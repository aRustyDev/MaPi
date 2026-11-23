// Local-only experiment: this cannot authorize a move or protect a real owner.
// The persistent counter can be rewound by privileged SQL or point-in-time
// restore, and its triggers have not been deployed or proven on all writers.
const quote = name => `"${name.replaceAll('"', '""')}"`;
// The prototype's cursor is control state, not project data. Excluding it
// avoids self-invalidation but requires protected checkpoint authority before
// any production use; this experiment does not provide that authority.
const excluded = new Set(['mapi_preflight_generation', 'mapi_preflight_trace', 'mapi_preflight_progress']);
const triggerSQL = (name, table, operation) => `CREATE TRIGGER ${quote(name)} AFTER ${operation} ON ${quote(table)} BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM mapi_preflight_generation WHERE singleton=1) THEN RAISE(ABORT,'mutation generation missing') END; SELECT CASE WHEN (SELECT typeof(counter) FROM mapi_preflight_generation WHERE singleton=1) <> 'integer' OR (SELECT counter FROM mapi_preflight_generation WHERE singleton=1) < 0 THEN RAISE(ABORT,'mutation generation invalid') END; SELECT CASE WHEN (SELECT counter FROM mapi_preflight_generation WHERE singleton=1) >= 9223372036854775807 THEN RAISE(ABORT,'mutation generation exhausted') END; UPDATE mapi_preflight_generation SET counter=counter+1 WHERE singleton=1; UPDATE mapi_preflight_trace SET changes=changes+1 WHERE table_name='${table.replaceAll("'", "''")}'; END`;

export function installPreflightGeneration(storage) {
  const sql = storage.sql;
  const exists = sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_preflight_generation'").toArray().length > 0;
  sql.exec('CREATE TABLE IF NOT EXISTS mapi_preflight_generation (singleton INTEGER PRIMARY KEY CHECK(singleton=1),counter INTEGER NOT NULL CHECK(counter>=0))');
  if (exists) {
    const rows = sql.exec("SELECT typeof(counter) AS kind, printf('%lld',counter) AS generation FROM mapi_preflight_generation WHERE singleton=1 LIMIT 2").toArray();
    if (rows.length !== 1 || rows[0].kind !== 'integer' || !/^(0|[1-9][0-9]*)$/.test(rows[0].generation)) throw Error('existing mutation generation invalid');
  } else sql.exec('INSERT INTO mapi_preflight_generation VALUES(1,0)');
  sql.exec('CREATE TABLE IF NOT EXISTS mapi_preflight_trace (table_name TEXT PRIMARY KEY, changes INTEGER NOT NULL)');
  const tables = sql.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").toArray().map(row => row.name).filter(name => !excluded.has(name));
  for (const table of tables) {
    sql.exec('INSERT OR IGNORE INTO mapi_preflight_trace VALUES (?,0)', table);
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const name = `mapi_preflight_gen_${operation.toLowerCase()}_${table}`;
      sql.exec(triggerSQL(name, table, operation).replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS '));
    }
  }
  return tables;
}

export function preflightGeneration(storage) {
  const rows = storage.sql.exec("SELECT typeof(counter) AS kind, printf('%lld',counter) AS generation FROM mapi_preflight_generation WHERE singleton=1 LIMIT 2").toArray();
  if (rows.length !== 1 || rows[0].kind !== 'integer' || !/^(0|[1-9][0-9]*)$/.test(rows[0].generation)) throw Error('mutation generation missing or invalid');
  return rows[0].generation;
}

export function missingPreflightGenerationCoverage(storage) {
  const sql = storage.sql;
  const schema = sql.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").toArray().map(row => row.name).filter(name => !excluded.has(name));
  const triggers = new Map(sql.exec("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").toArray().map(row => [row.name, row.sql]));
  const tracked = sql.exec('SELECT table_name FROM mapi_preflight_trace').toArray().map(row => row.table_name), trackedSet = new Set(tracked), schemaSet = new Set(schema);
  return [...tracked.filter(table => !schemaSet.has(table)).map(table => `${table}:table-missing`), ...schema.filter(table => !trackedSet.has(table)).map(table => `${table}:table-untracked`), ...schema.flatMap(table => ['insert', 'update', 'delete'].filter(op => triggers.get(`mapi_preflight_gen_${op}_${table}`) !== triggerSQL(`mapi_preflight_gen_${op}_${table}`, table, op.toUpperCase())).map(op => `${table}:${op}`))];
}
