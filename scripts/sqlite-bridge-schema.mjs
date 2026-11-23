// Keep strings and quoted identifiers intact: whitespace inside them is data.
// These tokens are a conservative comparison, not SQL semantic equivalence.
function schemaTokens(sql) {
  const tokens = [];
  const token = /[ \t\r\n\f\v]+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9$\u0080-\uFFFF]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|./gy;
  for (let match; (match = token.exec(sql)) !== null;) {
    if (!/^[ \t\r\n\f\v]|^--|^\/\*/.test(match[0])) tokens.push(match[0]);
  }
  return tokens;
}

export function checkExpressions(sql) {
  const tokens = schemaTokens(sql);
  const expressions = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!/^check$/i.test(tokens[i]) || tokens[i + 1] !== "(") continue;
    let depth = 0, end = i + 1;
    for (; end < tokens.length; end++) {
      if (tokens[end] === "(") depth++;
      if (tokens[end] === ")" && --depth === 0) break;
    }
    if (end === tokens.length) throw new Error("Unterminated CHECK expression");
    expressions.push(tokens.slice(i + 1, end + 1));
    i = end;
  }
  return expressions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// table_xinfo exposes whether a column is generated, but not the expression
// used to compute it. Compare that expression separately for each column.
export function generatedExpressions(sql, columns) {
  const wanted = new Set(columns.filter((column) => column[5] === 2 || column[5] === 3).map((column) => column[0]));
  if (!wanted.size) return [];
  const tokens = schemaTokens(sql);
  const open = tokens.indexOf("(");
  if (open < 0) throw new Error("Missing generated-column table definition");
  const segments = [];
  let depth = 0, start = open + 1, closed = false;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    else if (tokens[i] === ")") {
      if (depth === 0) { segments.push(tokens.slice(start, i)); closed = true; break; }
      depth--;
    } else if (tokens[i] === "," && depth === 0) {
      segments.push(tokens.slice(start, i)); start = i + 1;
    }
  }
  if (!closed) throw new Error("Unterminated generated-column table definition");
  const identifier = (token) => {
    if (!token) return null;
    if (token[0] === '"' || token[0] === "'" || token[0] === '`') return token.slice(1, -1).replaceAll(token[0] + token[0], token[0]);
    if (token[0] === "[") return token.slice(1, -1);
    return token;
  };
  const result = [];
  for (const segment of segments) {
    const name = identifier(segment[0]);
    if (!wanted.has(name)) continue;
    let level = 0, found = false;
    for (let i = 1; i < segment.length; i++) {
      if (level === 0 && /^as$/i.test(segment[i]) && segment[i + 1] === "(") {
        let end = i + 1, nested = 0;
        for (; end < segment.length; end++) {
          if (segment[end] === "(") nested++;
          else if (segment[end] === ")" && --nested === 0) break;
        }
        if (end === segment.length || found) throw new Error("Invalid generated-column expression");
        result.push([name, segment.slice(i + 1, end + 1)]); found = true; i = end;
      } else if (segment[i] === "(") level++;
      else if (segment[i] === ")") level--;
    }
    if (!found) throw new Error("Missing generated-column expression");
    wanted.delete(name);
  }
  if (wanted.size) throw new Error("Missing generated-column definition");
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

// table_xinfo does not report a column's declared collation. Restrict this
// comparison to top-level column clauses: COLLATE inside a CHECK or generated
// expression has different semantics and is compared with that expression.
export function columnCollations(sql, columns) {
  const wanted = new Set(columns.filter((column) => column[5] !== 1).map((column) => column[0]));
  const tokens = schemaTokens(sql);
  const open = tokens.indexOf("(");
  if (open < 0) throw new Error("Missing column table definition");
  const segments = [];
  let depth = 0, start = open + 1, closed = false;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    else if (tokens[i] === ")") {
      if (depth === 0) { segments.push(tokens.slice(start, i)); closed = true; break; }
      depth--;
    } else if (tokens[i] === "," && depth === 0) {
      segments.push(tokens.slice(start, i)); start = i + 1;
    }
  }
  if (!closed) throw new Error("Unterminated column table definition");
  const identifier = (token) => {
    if (!token) return null;
    if (token[0] === '"' || token[0] === "'" || token[0] === '`') return token.slice(1, -1).replaceAll(token[0] + token[0], token[0]);
    if (token[0] === "[") return token.slice(1, -1);
    return token;
  };
  const result = [];
  for (const segment of segments) {
    const name = identifier(segment[0]);
    if (!wanted.has(name)) continue;
    const collations = [];
    let level = 0;
    for (let i = 1; i < segment.length; i++) {
      if (segment[i] === "(") level++;
      else if (segment[i] === ")") level--;
      else if (level === 0 && /^collate$/i.test(segment[i])) {
        const collation = segment[++i];
        if (!collation || collation === "(" || collation === ")") throw new Error("Missing column collation");
        collations.push(collation);
      }
    }
    if (collations.length) result.push([name, collations]);
    wanted.delete(name);
  }
  if (wanted.size) throw new Error("Missing column definition");
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

// PRAGMA table_xinfo and index_list do not expose a constraint's conflict
// policy. Constraint order can determine which policy fires, or which unique
// constraint error is reported, when a write violates multiple constraints.
// Preserve uniqueness definitions in order even for implicit ABORT; when a
// policy is explicit, retain all definitions. This is conservative, not
// semantic normalization.
export function conflictPolicies(sql) {
  const tokens = schemaTokens(sql);
  const open = tokens.indexOf("(");
  if (open < 0) throw new Error("Missing column table definition");
  const definitions = [];
  const uniquenessDefinitions = [];
  let hasPolicy = false;
  let depth = 0, start = open + 1, closed = false;
  const capture = (end) => {
    const segment = tokens.slice(start, end);
    definitions.push(segment);
    let level = 0, hasUniqueness = false;
    for (let i = 0; i < segment.length; i++) {
      if (segment[i] === "(") level++;
      else if (segment[i] === ")") level--;
      else if (level === 0) {
        if (/^unique$/i.test(segment[i]) || (/^primary$/i.test(segment[i]) && /^key$/i.test(segment[i + 1] ?? ""))) hasUniqueness = true;
        if (/^on$/i.test(segment[i]) && /^conflict$/i.test(segment[i + 1] ?? "")) hasPolicy = true;
      }
    }
    if (hasUniqueness) uniquenessDefinitions.push(segment);
  };
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    else if (tokens[i] === ")") {
      if (depth === 0) { capture(i); closed = true; break; }
      depth--;
    } else if (tokens[i] === "," && depth === 0) {
      capture(i); start = i + 1;
    }
  }
  if (!closed) throw new Error("Unterminated column table definition");
  return hasPolicy ? definitions : uniquenessDefinitions;
}

// foreign_key_list omits DEFERRABLE and INITIALLY DEFERRED, which change when
// SQLite enforces a constraint. Compare the containing column or table
// definitions conservatively in declaration order as well as the pragma's
// structural metadata. This intentionally does not claim SQL equivalence.
export function foreignKeyDeclarations(sql) {
  const tokens = schemaTokens(sql);
  const open = tokens.indexOf("(");
  if (open < 0) throw new Error("Missing foreign-key table definition");
  const result = [];
  let depth = 0, start = open + 1, closed = false;
  const capture = (end) => {
    const segment = tokens.slice(start, end);
    let level = 0;
    for (let i = 0; i < segment.length; i++) {
      if (segment[i] === "(") level++;
      else if (segment[i] === ")") level--;
      else if (level === 0 && /^references$/i.test(segment[i])) {
        result.push(segment);
      }
    }
  };
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    else if (tokens[i] === ")") {
      if (depth === 0) { capture(i); closed = true; break; }
      depth--;
    } else if (tokens[i] === "," && depth === 0) {
      capture(i); start = i + 1;
    }
  }
  if (!closed) throw new Error("Unterminated foreign-key table definition");
  return result;
}

// Compare stored definitions verbatim. The reserved SQLite prefix contains a
// literal underscore; LIKE 'sqlite_%' would also exclude legal names such as
// sqliteXview because LIKE treats underscore as a wildcard. This deliberately
// does not claim SQL semantic equivalence or execution coverage for views and
// triggers.
export function snapshotSchemaObjects(query) {
  return query("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('view', 'trigger') AND lower(substr(name, 1, 7)) <> 'sqlite_' AND name NOT GLOB 'mapi_test_*' AND name NOT GLOB '__miniflare_*' AND tbl_name NOT GLOB 'mapi_test_*' AND tbl_name NOT GLOB '__miniflare_*' ORDER BY type, name")
    .map(({type, name, tbl_name, sql}) => [type, name, tbl_name, sql]);
}

// Describe schema by semantic properties so recreated autoindex numbers and
// column order do not change an otherwise equivalent snapshot.
export function snapshotSchema(query) {
  // Table names are arbitrary SQLite identifiers, including "__proto__".
  // Avoid the Object prototype setter silently dropping such a table.
  const schema = Object.create(null);
  const tables = query("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND lower(substr(name, 1, 7)) <> 'sqlite_' AND name NOT GLOB 'mapi_test_*' AND name NOT GLOB '__miniflare_*' AND name != 'goose_db_version' ORDER BY name");
  // table_xinfo does not expose STRICT or WITHOUT ROWID, both of which
  // change SQLite's behavior. Do not silently accept missing/malformed flags.
  const listed = query("PRAGMA table_list");
  if (!Array.isArray(listed)) throw new Error("SQLite table metadata unavailable");
  const tableNames = new Set(tables.map(({name}) => name));
  const options = new Map();
  for (const row of listed) {
    if (row?.schema !== "main" || !tableNames.has(row.name)) continue;
    if (options.has(row.name) || !["table", "virtual", "shadow"].includes(row.type) ||
        !Number.isSafeInteger(row.ncol) || row.ncol < 0 || ![0, 1].includes(row.wr) || ![0, 1].includes(row.strict)) {
      throw new Error(`Invalid SQLite table metadata for ${row.name}`);
    }
    options.set(row.name, { ncol: row.ncol, flags: [row.wr, row.strict] });
  }
  const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
  for (const { name, sql } of tables) {
    if (!options.has(name)) throw new Error(`Missing SQLite table metadata for ${name}`);
    const columns = query(`PRAGMA table_xinfo(${quote(name)})`)
      .map(({ name, type, notnull, dflt_value, pk, hidden }) => [name, type, notnull, dflt_value, pk, hidden])
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (options.get(name).ncol !== columns.length) throw new Error(`SQLite column metadata differs for ${name}`);
    const groups = new Map();
    for (const row of query(`PRAGMA foreign_key_list(${quote(name)})`)) {
      if (!groups.has(row.id)) groups.set(row.id, []);
      groups.get(row.id).push([row.seq, row.table, row.from, row.to, row.on_update, row.on_delete, row.match]);
    }
    const foreignKeys = [...groups.values()].map((rows) => rows.sort((a, b) => a[0] - b[0]));
    foreignKeys.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const indexes = query(`PRAGMA index_list(${quote(name)})`).map((index) => {
      const fields = query(`PRAGMA index_xinfo(${quote(index.name)})`)
        .filter((row) => row.key === 1)
        .map((row) => [row.seqno, row.name, row.desc, row.coll]);
      const literalName = "'" + index.name.replaceAll("'", "''") + "'";
      const sql = index.origin === "c"
        ? query(`SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ${literalName}`)[0]?.sql ?? null
        : null;
      const definition = sql === null ? null : schemaTokens(sql);
      return [index.origin === "c" ? index.name : null, index.origin, index.unique, index.partial, fields, definition];
    });
    indexes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const fkDeclarations = foreignKeyDeclarations(sql);
    if (fkDeclarations.length !== foreignKeys.length) throw new Error(`Foreign-key declarations do not match metadata for ${name}`);
    schema[name] = { tableOptions: options.get(name).flags, columns, foreignKeys, foreignKeyDeclarations: fkDeclarations, indexes, checks: checkExpressions(sql), generated: generatedExpressions(sql, columns), collations: columnCollations(sql, columns), conflictPolicies: conflictPolicies(sql) };
  }
  return schema;
}
