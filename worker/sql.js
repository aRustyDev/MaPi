// Use SQLite to convert integer columns to decimal text before crossing V8's
// number boundary. Nextgen stores Unix nanoseconds and requires exact int64s.
function columnPair(column) {
  return "CASE WHEN typeof(" + column + ") = 'integer' THEN printf('%lld', " + column +
    ") ELSE " + column + " END, typeof(" + column + ")";
}

// Wide results cannot use two result columns per value: workerd limits a
// result set to 100 columns. Prefix integers and text to distinguish them;
// retain blobs as blobs and real values as numbers. The common narrow path
// keeps its original representation and does not copy large text values.
function packedColumn(column) {
  const type = "typeof(" + column + ")";
  return "CASE WHEN " + type + " = 'integer' THEN 'i' || printf('%lld', " + column +
    ") WHEN " + type + " = 'text' THEN 't' || " + column + " ELSE " + column + " END";
}

function decodePacked(encoded) {
  if (typeof encoded === "string") {
    if (encoded[0] === "i") return { integer: encoded.slice(1) };
    if (encoded[0] === "t") return encoded.slice(1);
    throw new Error("Unexpected wide SQLite value tag");
  }
  if (encoded === null || typeof encoded === "number") return encoded;
  return { blob: new Uint8Array(encoded).toBase64() };
}

function bind(statement, args) {
  let highest = 0;
  const sql = statement.replace(/'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\?(\d*)/g, (part, numbered) => {
    // SQLite accepts a trailing block comment without its closing delimiter.
    // Remove only that comment: query-mode appends wrapper SQL after the
    // original statement, which would otherwise remain inside the comment.
    if (numbered === undefined) return part.startsWith('/*') && (part.length < 4 || !part.endsWith('*/')) ? ' ' : part;
    const index = numbered === "" ? highest + 1 : Number(numbered);
    // SQLite Durable Objects support at most 100 bound parameters.
    if (!Number.isSafeInteger(index) || index < 1 || index > 100) throw new Error("Invalid SQLite parameter index");
    highest = Math.max(highest, index);
    if (index > args.length) throw new Error("Missing SQLite argument");
    const placeholder = `?${index}`;
    return args[index - 1].kind === "int" ? `CAST(${placeholder} AS INTEGER)` : placeholder;
  });
  if (highest !== args.length) throw new Error("SQLite argument count mismatch");
  const values = args.map(({ kind, value }) => kind === "blob" ? Uint8Array.fromBase64(value).buffer : value);
  return { sql, values };
}

function decodePair(value, type) {
  if (type === "integer") return { integer: value };
  if (type === "blob") return { blob: new Uint8Array(value).toBase64() };
  return value;
}

// Only inspect tokens outside quoted strings, identifiers and comments.
// A SQL exec can contain more than one statement, so query-mode callers must
// not be allowed to hide a write after a leading SELECT.
function queryTokens(statement) {
  let depth = 0;
  const found = [];
  const tokens = /'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[();,]|[a-zA-Z_\u0080-\u{10ffff}][a-zA-Z_0-9$\u0080-\u{10ffff}]*/gu;
  for (const match of statement.matchAll(tokens)) {
    const token = match[0];
    if (token === "(") {
      if (depth === 0) found.push({ word: token, start: match.index, end: match.index + 1 });
      depth++; continue;
    }
    if (token === ")") {
      depth--;
      if (depth === 0) found.push({ word: token, start: match.index, end: match.index + 1 });
      continue;
    }
    // SQLite keywords are ASCII case-insensitive; Unicode case folding can
    // turn an identifier such as "aſ" into the keyword "AS".
    if (depth === 0 && (/^[a-zA-Z_]/.test(token) || token === ";" || token === ",")) found.push({ word: token.replace(/[a-z]/g, character => character.toUpperCase()), start: match.index, end: match.index + token.length });
  }
  return found;
}

function singleQueryStatement(statement) {
  const tokens = queryTokens(statement);
  const semicolons = tokens.filter(token => token.word === ";");
  if (semicolons.length > 1) throw new Error("Multiple SQLite statements are unsupported in query mode");
  if (!semicolons.length) return statement;
  const trailing = statement.slice(semicolons[0].end);
  if (!/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/.test(trailing)) throw new Error("Multiple SQLite statements are unsupported in query mode");
  return statement.slice(0, semicolons[0].start);
}

function queryVerb(tokens) {
  const first = tokens.find(token => /^[A-Z_]/.test(token.word));
  if (!first || first.word !== "WITH") return first;
  // Skip complete CTE definitions, including optional column lists and
  // MATERIALIZED modifiers, before deciding whether the main query writes.
  // A valid CTE can itself be named REPLACE or UPDATE.
  let index = tokens.indexOf(first) + 1;
  while (index < tokens.length) {
    while (index < tokens.length && tokens[index].word !== "AS") index++;
    if (index === tokens.length) return undefined;
    index++;
    while (index < tokens.length && tokens[index].word !== "(") index++;
    if (index === tokens.length) return undefined;
    index++;
    while (index < tokens.length && tokens[index].word !== ")") index++;
    if (index === tokens.length) return undefined;
    index++;
    if (tokens[index]?.word === ",") { index++; continue; }
    const verb = tokens[index];
    return verb && ["SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE"].includes(verb.word) ? verb : undefined;
  }
  return undefined;
}

// Discover the original column names without stepping any result row. A
// direct sql.exec() steps the first row even before its cursor is consumed.
// Preserve LIMIT/OFFSET placeholders inside unreachable CASE branches, so
// SQLite accepts the same bindings without evaluating volatile expressions.
function metadataQuery(statement, tokens, verb) {
  const limit = tokens.find(token => token.start > verb.end && token.word === "LIMIT");
  if (!limit) return statement + "\nLIMIT 0";
  const separator = tokens.find(token => token.start > limit.end && (token.word === "OFFSET" || token.word === ","));
  const zero = expression => " CASE WHEN 0 THEN (\n" + expression + "\n) ELSE 0 END";
  if (!separator) return statement.slice(0, limit.end) + zero(statement.slice(limit.end));
  return statement.slice(0, limit.end) + zero(statement.slice(limit.end, separator.start)) +
    " " + statement.slice(separator.start, separator.end) + zero(statement.slice(separator.end));
}

// Comments in a RETURNING projection are whitespace, not column names.
// Preserve quoted tokens so the existing simple-identifier restriction cannot
// accidentally treat an expression or quoted identifier as a plain name.
function returningProjection(statement) {
  return statement.replace(/'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|--[^\n]*|\/\*[\s\S]*?\*\//g, part =>
    part.startsWith('--') || part.startsWith('/*') ? ' ' : part);
}

// Migration 33's six-arm search backfill exceeds workerd's compound SELECT
// limit. Nesting two groups preserves UNION ALL and keeps each group bounded.
function adaptSearchEntriesMigration(statement) {
  const prefix = "names(project_id, kind, key, resource_id, title, subtitle, name) AS (";
  if (!statement.includes(prefix) || !statement.includes("INSERT OR IGNORE INTO search_entries")) return statement;
  const start = statement.indexOf(prefix) + prefix.length;
  const end = statement.indexOf("\n),\nfolded AS (", start);
  if (end < 0) throw new Error("Unexpected search entries migration shape");
  const arms = statement.slice(start, end).split(/\n\s*UNION ALL\s*\n/);
  if (arms.length !== 6) throw new Error("Unexpected search entries migration UNION count");
  const first = arms.slice(0, 3).join("\nUNION ALL\n");
  const second = arms.slice(3).join("\nUNION ALL\n");
  return statement.slice(0, start) + "\nSELECT * FROM (" + first + ")\nUNION ALL\nSELECT * FROM (" + second + ")" + statement.slice(end);
}

export function execute(storage, { statement, args, query }) {
  statement = adaptSearchEntriesMigration(statement);
  const bound = bind(statement, args);
  const values = bound.values;
  const sql = query ? singleQueryStatement(bound.sql) : bound.sql;
  if (!query) {
    const cursor = storage.sql.exec(sql, ...values);
    cursor.toArray();
    // rowsWritten is a billing counter that also includes index writes.
    // database/sql requires SQLite's logical affected-row count instead.
    const changes = storage.sql.exec("SELECT changes() AS count").one().count;
    return { changes };
  }

  const tokens = queryTokens(sql);
  const verb = queryVerb(tokens);
  const kind = verb?.word ?? "";
  const returningToken = ["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(kind) ? tokens.find(token => token.start > verb.end && token.word === "RETURNING") : undefined;
  const returning = returningToken ? /^\s*([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)\s*$/i.exec(returningProjection(sql.slice(returningToken.end))) : null;
  let columns;
  let prepared;
  let wide;
  if (returning) {
    columns = returning[1].split(/\s*,\s*/);
    wide = columns.length > 50;
    prepared = sql.slice(0, returningToken.start) + "RETURNING " + columns.map(wide ? packedColumn : columnPair).join(", ");
  } else {
    if (kind !== "SELECT") throw new Error("Unsupported row-producing SQLite statement");
    const cursor = storage.sql.exec(metadataQuery(sql, tokens, verb), ...values);
    columns = cursor.columnNames;
    // Drain the zero-row cursor so it cannot retain a lock across later DDL.
    for (const _row of cursor.raw()) { /* Exhaust the cursor without retaining rows. */ }
    const aliases = columns.map((_column, index) => "column_" + index);
    wide = columns.length > 50;
    // Avoid shadowing a real table or CTE named mapi_rows in the source.
    let rowSource = "mapi_rows";
    while (new RegExp("\\b" + rowSource + "\\b", "i").test(sql)) rowSource += "_";
    prepared = "WITH " + rowSource + "(" + aliases.join(", ") + ") AS MATERIALIZED (" + sql.trim() +
      "\n) SELECT " + aliases.map(wide ? packedColumn : columnPair).join(", ") + " FROM " + rowSource;
  }
  const rows = storage.sql.exec(prepared, ...values).raw().toArray().map((row) =>
    columns.map((_column, index) => wide ? decodePacked(row[index]) : decodePair(row[index * 2], row[index * 2 + 1])));
  return { columns, rows };
}

export function sqliteError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const codes = [
    [/UNIQUE constraint failed/, 2067], [/FOREIGN KEY constraint failed/, 787],
    [/NOT NULL constraint failed/, 1299], [/CHECK constraint failed/, 275],
  ];
  return { message, code: codes.find(([match]) => match.test(message))?.[1] ?? 0 };
}
