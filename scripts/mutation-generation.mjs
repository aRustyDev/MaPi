// Experimental local proof only. Install immediately after a checked schema
// migration while all writes are fenced; never enable on a live project without
// complete migration, restore, routing, privilege and workload review.
const quote = (name) => `"${name.replaceAll('"','""')}"`;
const excluded = new Set(['mapi_mutation_generation','mapi_mutation_trace','split_jobs']);
export function installMutationGeneration(storage) {
 const sql=storage.sql;
 sql.exec('CREATE TABLE IF NOT EXISTS mapi_mutation_generation (singleton INTEGER PRIMARY KEY CHECK(singleton=1),counter INTEGER NOT NULL CHECK(counter>=0))');
 sql.exec('INSERT OR IGNORE INTO mapi_mutation_generation VALUES(1,0)');
 sql.exec('CREATE TABLE IF NOT EXISTS mapi_mutation_trace (table_name TEXT PRIMARY KEY, changes INTEGER NOT NULL)');
 const tables=sql.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").toArray().map(r=>r.name).filter(name=>!excluded.has(name));
 for(const table of tables) {
  sql.exec('INSERT OR IGNORE INTO mapi_mutation_trace VALUES (?,0)',table);
  for(const operation of ['INSERT','UPDATE','DELETE']) {
  const name=`mapi_gen_${operation.toLowerCase()}_${table}`;
  sql.exec(`CREATE TRIGGER IF NOT EXISTS ${quote(name)} AFTER ${operation} ON ${quote(table)} BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM mapi_mutation_generation WHERE singleton=1) THEN RAISE(ABORT,'mutation generation missing') END; SELECT CASE WHEN (SELECT counter FROM mapi_mutation_generation WHERE singleton=1) >= 9223372036854775807 THEN RAISE(ABORT,'mutation generation exhausted') END; UPDATE mapi_mutation_generation SET counter=counter+1 WHERE singleton=1; UPDATE mapi_mutation_trace SET changes=changes+1 WHERE table_name='${table.replaceAll("'","''")}'; END`);
  }
 }
 return tables;
}
export function mutationGeneration(storage) {
 const rows=storage.sql.exec("SELECT printf('%lld',counter) AS generation FROM mapi_mutation_generation WHERE singleton=1").toArray();
 if(rows.length!==1||!/^(0|[1-9][0-9]*)$/.test(rows[0].generation))throw Error('mutation generation missing');
 return rows[0].generation;
}

// Detects missing trigger names after DDL; a secure implementation must also
// validate trigger definitions and prevent privileged writes to these tables.
export function missingGenerationCoverage(storage) {
 const schema=storage.sql.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray().map(r=>r.name).filter(n=>!excluded.has(n));
 const triggers=new Set(storage.sql.exec("SELECT name FROM sqlite_schema WHERE type='trigger'").toArray().map(r=>r.name));
 return schema.flatMap(table=>['insert','update','delete'].filter(op=>!triggers.has(`mapi_gen_${op}_${table}`)).map(op=>`${table}:${op}`));
}
