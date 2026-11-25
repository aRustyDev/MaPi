import { DurableObject } from "cloudflare:workers";
import wasm from "../worker/generated/sqlite-bridge-test.wasm";
import baseline from "../worker/generated/baseline.json";
import migrations from "../worker/generated/sqlite-bridge-migrations.json";
import { instantiateReactor } from "../worker/wasi.js";
import { execute, sqliteError, stringifySQLResponse } from "../worker/sql.js";
import { snapshotSchema, snapshotSchemaObjects } from "./sqlite-bridge-schema.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const rejected = Symbol("Go transaction failed");

export class BridgeTest extends DurableObject {
  runMigrations(expected) {
    try {
      const storage = this.ctx.storage;
      const sql = storage.sql;
      const schemaSnapshot = () => snapshotSchema((statement) => sql.exec(statement).toArray());
      const objectSnapshot = () => snapshotSchemaObjects((statement) => sql.exec(statement).toArray());
      let maxObjectCount = objectSnapshot().length;
      const knownDefaults = {
        13: ["user_passwords", "changed_at"],
        14: ["user_passwords", "updated_at"],
        19: ["projects", "preview_origins"],
        26: ["user_attributes", "team_id"],
      };
      storage.sql.exec("CREATE TABLE mapi_test_migration_version (version INTEGER NOT NULL)");
      storage.sql.exec("INSERT INTO mapi_test_migration_version VALUES (0)");
      for (const migration of migrations) {
        if (migration.version === 29) {
          sql.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p', 'p', 1, 1)");
          for (const [url, payload] of [
            ["designated", '{"x-identifier":"email","x-display":["name.given","name.family"]}'],
            ["identifier", '{"x-identifier":"username"}'],
            ["plain", '{"type":"object"}'],
          ]) sql.exec("INSERT INTO json_schemas (project_id, url, kind, created_at, payload) VALUES ('p', ?, 'user-schema', 1, ?)", url, payload);
          for (const [user, schema] of [["u_designated", "designated"], ["u_identifier", "identifier"], ["u_plain", "plain"]]) {
            sql.exec("INSERT INTO users (project_id, id, schema_url, created_at, updated_at) VALUES ('p', ?, ?, 1, 1)", user, schema);
          }
          for (const [user, key, value] of [
            ["u_designated", "email", '"Ann@Example.com"'], ["u_designated", "name.given", '"Ann"'],
            ["u_designated", "name.family", '""'], ["u_designated", "nickname", '"Annie"'],
            ["u_identifier", "username", '"BEN"'], ["u_identifier", "email", '"ben@example.com"'],
            ["u_plain", "email", '"cleo@example.com"'], ["u_plain", "username", "42"],
          ]) sql.exec("INSERT INTO user_attributes (project_id, user_id, key, value) VALUES ('p', ?, ?, ?)", user, key, value);
        }
        if (migration.version === 33) {
          sql.exec("INSERT INTO teams (project_id, id, name, created_at, updated_at) VALUES ('p', 't1', 'Payments Alpha', 1, 1)");
          sql.exec(`INSERT INTO flow_definitions (project_id, id, name, schema_version, purposes, definition, created_at, updated_at)
            VALUES ('p', 'f_old', 'partner-sign-in', '1.0.0', '["login"]', '{}', 1, 1),
                   ('p', 'f_new', 'partner-sign-in', '1.0.0', '["register","login"]', '{}', 2, 2)`);
          sql.exec(`INSERT INTO json_schemas (project_id, url, object_type, kind, created_at, payload)
            VALUES ('p', 's_old', 'partner-user', 'user-schema', 1, '{"title":"Old Staff"}'),
                   ('p', 's_new', 'partner-user', 'user-schema', 2, '{"title":"Partner Staff"}'),
                   ('p', 's_ref', NULL, 'unknown', 2, '{"title":"Referenced"}')`);
          sql.exec("INSERT INTO idp_connections (project_id, id, slug, created_at) VALUES ('p', 'c1', 'partner-sso', 1)");
          sql.exec(`INSERT INTO idp_connection_revisions (project_id, id, connection_id, document, created_at)
            VALUES ('p', 'r1', 'c1', '{"display_name":"Old"}', 1),
                   ('p', 'r2', 'c1', '{"display_name":"Partner Portal"}', 2)`);
        }
        const verifyBackfill = () => {
          if (migration.version === 29) {
            const got = sql.exec("SELECT user_id || '/' || key AS item, search_text FROM user_attributes WHERE search_text IS NOT NULL ORDER BY item").toArray();
            const want = [
              { item: "u_designated/email", search_text: "ann@example.com" },
              { item: "u_designated/name.given", search_text: "ann" },
              { item: "u_identifier/username", search_text: "ben" },
            ];
            if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error("Search text backfill mismatch");
          }
          if (migration.version === 33) {
            const got = sql.exec(`SELECT resource_kind || '|' || resource_id || '|' || search_text || '|' || name_start || '|' || title || '|' || subtitle AS item
              FROM search_entries WHERE project_id = 'p' ORDER BY item`).toArray().map((row) => row.item);
            const want = [
              "team|t1|payments alpha|1|Payments Alpha|", "team|t1|alpha|0|Payments Alpha|",
              "flow_definition|f_new|partner-sign-in|1|partner-sign-in|login, register",
              "flow_definition|f_new|sign-in|0|partner-sign-in|login, register",
              "flow_definition|f_new|in|0|partner-sign-in|login, register",
              "schema|s_new|partner staff|1|Partner Staff|partner-user", "schema|s_new|staff|0|Partner Staff|partner-user",
              "schema|s_new|partner-user|1|Partner Staff|partner-user", "schema|s_new|user|0|Partner Staff|partner-user",
              "idp_connection|c1|partner-sso|1|Partner Portal|partner-sso", "idp_connection|c1|sso|0|Partner Portal|partner-sso",
              "idp_connection|c1|partner portal|1|Partner Portal|partner-sso", "idp_connection|c1|portal|0|Partner Portal|partner-sso",
            ].sort();
            if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error("Search entries backfill mismatch");
          }
        };
        const before = schemaSnapshot();
        const beforeObjects = objectSnapshot();
        const apply = (statements, version, direction) => {
          try {
            storage.transactionSync(() => {
              for (const statement of statements) execute(storage, { statement, args: [], query: false });
              storage.sql.exec("UPDATE mapi_test_migration_version SET version = ?", version);
            });
          } catch (error) {
            throw new Error(`${migration.name} ${direction}: ${error}`);
          }
        };
        apply(migration.up, migration.version, "up");
        maxObjectCount = Math.max(maxObjectCount, objectSnapshot().length);
        verifyBackfill();
        if (migration.version === 29) {
          try {
            storage.transactionSync(() => {
              sql.exec(migration.down[0]);
              sql.exec("UPDATE mapi_test_migration_version SET version = 28");
              throw new Error("Injected migration failure");
            });
            throw new Error("Migration failure did not roll back");
          } catch (error) {
            if (error.message !== "Injected migration failure") throw error;
          }
          if (sql.exec("SELECT version FROM mapi_test_migration_version").one().version !== 29) throw new Error("Migration ledger did not roll back");
          verifyBackfill();
        }
        apply(migration.down, migration.version - 1, "down");
        const after = schemaSnapshot();
        const afterObjects = objectSnapshot();
        maxObjectCount = Math.max(maxObjectCount, afterObjects.length);
        if (JSON.stringify(beforeObjects) !== JSON.stringify(afterObjects)) throw new Error(`${migration.name} down changed views or triggers`);
        const known = knownDefaults[migration.version];
        if (known) {
          for (const schema of [before, after]) {
            const column = schema[known[0]]?.columns.find((item) => item[0] === known[1]);
            if (!column) throw new Error(`Missing known migration column ${known.join(".")}`);
            column[3] = null;
          }
        }
        const changedTables = [...new Set([...Object.keys(before), ...Object.keys(after)])]
          .filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]));
        if (changedTables.length) throw new Error(`${migration.name} down changed columns: ${changedTables.join(", ")}`);
        apply(migration.up, migration.version, "up retry");
        verifyBackfill();
      }
      const version = storage.sql.exec("SELECT version FROM mapi_test_migration_version").one().version;
      const violations = storage.sql.exec("PRAGMA foreign_key_check").toArray();
      if (version !== migrations.length || violations.length) throw new Error("Migration version or foreign key check failed");
      const actualSchema = schemaSnapshot();
      const differing = [...new Set([...Object.keys(actualSchema), ...Object.keys(expected.tables)])]
        .filter((name) => JSON.stringify(actualSchema[name]) !== JSON.stringify(expected.tables[name]));
      if (differing.length) throw new Error("Final native/workerd table schema mismatch: " + differing.join(", "));
      const actualObjects = objectSnapshot();
      if (JSON.stringify(actualObjects) !== JSON.stringify(expected.objects)) throw new Error("Final native/workerd view or trigger mismatch");
      return { ok: true, versions: version, seededBackfills: [29, 33], injectedRollback: true, adaptedMigration: 33, schemaMatched: true, objectsMatched: true, objectCount: actualObjects.length, maxObjectCount };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  run() {
    this.ctx.storage.transactionSync(() => {
      for (const statement of baseline.statements) this.ctx.storage.sql.exec(statement);
    });
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_rows_written_probe (a TEXT, b TEXT, PRIMARY KEY (a, b))");
    this.ctx.storage.sql.exec("DELETE FROM mapi_rows_written_probe");
    const write = this.ctx.storage.sql.exec("INSERT INTO mapi_rows_written_probe VALUES ('a', 'b')");
    write.toArray();
    const written = write.rowsWritten;
    const changes = this.ctx.storage.sql.exec("SELECT changes() AS count").one().count;
    let reactor;
    let output;
    let memory;
    reactor = instantiateReactor(wasm, (getMemory) => {
      memory = getMemory;
      return {
        sql: (pointer, size) => {
          const query = JSON.parse(decoder.decode(new Uint8Array(memory(), pointer, size)));
          let result;
          try { result = execute(this.ctx.storage, query); }
          catch (error) { result = { error: sqliteError(error) }; }
          output = encoder.encode(stringifySQLResponse(result));
          return output.length;
        },
        result: (pointer, size) => {
          new Uint8Array(memory(), pointer, size).set(output);
          output = undefined;
        },
        transaction: () => {
          try {
            this.ctx.storage.transactionSync(() => {
              if (reactor.mapi_transaction_body() !== 0) throw rejected;
            });
            return 0;
          } catch (error) {
            if (error === rejected) return 1;
            return 2;
          }
        },
      };
    });
    const packed = reactor.run_bridge_tests();
    const pointer = Number(packed >> 32n);
    const length = Number(packed & 0xffffffffn);
    return { ...JSON.parse(decoder.decode(new Uint8Array(memory(), pointer, length))), written, changes };
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/migrations") {
      return Response.json(await env.BRIDGE_TEST.getByName("migration-test").runMigrations(await request.json()));
    }
    return Response.json(await env.BRIDGE_TEST.getByName("bridge-test").run());
  },
};
