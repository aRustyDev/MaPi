// Use SQLite to convert integer columns to decimal text before crossing V8's
// number boundary. Nextgen stores Unix nanoseconds and requires exact int64s.
function columnPair(column) {
  return "CASE WHEN typeof(" + column + ") = 'integer' THEN printf('%lld', " + column +
    ") ELSE " + column + " END, typeof(" + column + ")";
}

function bind(statement, args) {
  let highest = 0;
  const sql = statement.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|\?(\d*)/g, (part, numbered) => {
    if (numbered === undefined) return part;
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

export function execute(storage, { statement, args, query }) {
  const { sql, values } = bind(statement, args);
  if (!query) {
    const cursor = storage.sql.exec(sql, ...values);
    cursor.toArray();
    return { changes: cursor.rowsWritten };
  }

  const returning = /\bRETURNING\s+([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)\s*;?\s*$/i.exec(sql);
  let columns;
  let prepared;
  if (returning) {
    columns = returning[1].split(/\s*,\s*/);
    prepared = sql.slice(0, returning.index) + "RETURNING " + columns.map(columnPair).join(", ");
  } else {
    if (!/^\s*(?:SELECT|WITH)\b/i.test(sql)) throw new Error("Unsupported row-producing SQLite statement");
    columns = storage.sql.exec(sql, ...values).columnNames;
    const aliases = columns.map((_column, index) => "column_" + index);
    prepared = "WITH mapi_rows(" + aliases.join(", ") + ") AS (" + sql.trim().replace(/;$/, "") +
      ") SELECT " + aliases.map(columnPair).join(", ") + " FROM mapi_rows";
  }
  const rows = storage.sql.exec(prepared, ...values).raw().toArray().map((row) =>
    columns.map((_column, index) => decodePair(row[index * 2], row[index * 2 + 1])));
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
