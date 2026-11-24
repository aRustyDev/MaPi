// Inject a local-only interruption into the transactional DDL for this test.
import { readFile, writeFile } from 'node:fs/promises';
let app = await readFile('worker/app.js', 'utf8');
const replaceOnce = (before, after) => {
  if (!app.includes(before) || app.indexOf(before) !== app.lastIndexOf(before)) throw Error(`Schema test hook anchor missing or ambiguous: ${before}`);
  app = app.replace(before, after);
};
replaceOnce('  #pendingAuthority;', '  #pendingAuthority;\n  #failSchemaAfterDDL = false;');
replaceOnce("      sql.exec('CREATE TABLE mapi_schema_history (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');", `      sql.exec('CREATE TABLE mapi_schema_history (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
      if (this.env.MAPI_LOCAL_TEST === '1' && this.#failSchemaAfterDDL) { this.#failSchemaAfterDDL = false; throw new Error('Injected schema DDL failure'); }`);
replaceOnce('  async schemaMigrationReadiness(secret, route, epoch) {', `  failSchemaAfterDDL() {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw new Error('Local testing is disabled');
    this.#failSchemaAfterDDL = true;
  }

  async schemaMigrationReadiness(secret, route, epoch) {`);
app = app.replace('"./generated/baseline.json"', '"./baseline.json"').replace(/from "\.\/([^"/]+\.js)"/g, 'from "../$1"');
await writeFile('worker/generated/schema-migration-test-app.js', app);
