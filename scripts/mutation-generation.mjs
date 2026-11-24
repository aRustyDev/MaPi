// Experimental local proof only. Install immediately after a checked schema
// migration while all writes are fenced; never enable on a live project without
// complete migration, restore, routing, privilege and workload review.
const quote = (name) => `"${name.replaceAll('"','""')}"`;
// The prototype handles its durable admission counter separately; changes to
// that counter do not alter a verified credential snapshot. This exclusion
// is not a substitute for the application's full throttle review.
const excluded = new Set(['mapi_mutation_generation','mapi_mutation_trace','split_jobs','mapi_login_limits']);
const triggerSQL = (name, table, operation) => `CREATE TRIGGER ${quote(name)} AFTER ${operation} ON ${quote(table)} BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM mapi_mutation_generation WHERE singleton=1) THEN RAISE(ABORT,'mutation generation missing') END; SELECT CASE WHEN (SELECT typeof(counter) FROM mapi_mutation_generation WHERE singleton=1) <> 'integer' OR (SELECT counter FROM mapi_mutation_generation WHERE singleton=1) < 0 THEN RAISE(ABORT,'mutation generation invalid') END; SELECT CASE WHEN (SELECT counter FROM mapi_mutation_generation WHERE singleton=1) >= 9223372036854775807 THEN RAISE(ABORT,'mutation generation exhausted') END; UPDATE mapi_mutation_generation SET counter=counter+1 WHERE singleton=1; UPDATE mapi_mutation_trace SET changes=changes+1 WHERE table_name='${table.replaceAll("'","''")}'; END`;
export function installMutationGeneration(storage) {
 const sql=storage.sql;
 sql.exec('CREATE TABLE IF NOT EXISTS mapi_mutation_generation (singleton INTEGER PRIMARY KEY CHECK(singleton=1),counter INTEGER NOT NULL CHECK(counter>=0))');
 sql.exec('INSERT OR IGNORE INTO mapi_mutation_generation VALUES(1,0)');
 sql.exec('CREATE TABLE IF NOT EXISTS mapi_mutation_trace (table_name TEXT PRIMARY KEY, changes INTEGER NOT NULL)');
 const tables=sql.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").toArray().map(r=>r.name).filter(name=>!excluded.has(name));
 for(const table of tables) {
  sql.exec('INSERT OR IGNORE INTO mapi_mutation_trace VALUES (?,0)',table);
  for(const operation of ['INSERT','UPDATE','DELETE']) {
  const name=`mapi_gen_${operation.toLowerCase()}_${table}`;
  sql.exec(triggerSQL(name,table,operation).replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS '));
  }
 }
 return tables;
}
export function mutationGeneration(storage) {
 const rows=storage.sql.exec("SELECT typeof(counter) AS kind, printf('%lld',counter) AS generation FROM mapi_mutation_generation WHERE singleton=1 LIMIT 2").toArray();
 if(rows.length!==1||rows[0].kind!=='integer'||!/^(0|[1-9][0-9]*)$/.test(rows[0].generation))throw Error('mutation generation missing or invalid');
 return rows[0].generation;
}

// This local prototype fails closed on missing or modified trigger definitions.
// Production would also need to prevent privileged SQL and schema writes.
export function missingGenerationCoverage(storage) {
 const schema=storage.sql.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").toArray().map(r=>r.name).filter(n=>!excluded.has(n));
 const triggers=new Map(storage.sql.exec("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").toArray().map(r=>[r.name,r.sql]));
 const tracked=storage.sql.exec('SELECT table_name FROM mapi_mutation_trace').toArray().map(r=>r.table_name), trackedSet=new Set(tracked), schemaSet=new Set(schema);
 return [ ...tracked.filter(table=>!schemaSet.has(table)).map(table=>`${table}:table-missing`), ...schema.filter(table=>!trackedSet.has(table)).map(table=>`${table}:table-untracked`), ...schema.flatMap(table=>['insert','update','delete'].filter(op=>triggers.get(`mapi_gen_${op}_${table}`)!==triggerSQL(`mapi_gen_${op}_${table}`,table,op.toUpperCase())).map(op=>`${table}:${op}`)) ];
}
