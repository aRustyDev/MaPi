import { DurableObject } from "cloudflare:workers";
import baseline from "../worker/generated/baseline.json";
import { execute } from "../worker/sql.js";
import { projectFenceStatus } from "../worker/relocation.js";
import { initializeOwnerFence, freezeOwnerFence, reserveMoveDestination } from "../worker/owner-fence.js";
import { inspectRelocationSource, inspectRelocationDestination, prepareRelocationDestination, restoreRelocationMetadata, digestRelocationPage } from "../worker/relocation-manifest.js";
import issuerSchema from "../worker/relocation-issuer-schema.json";
import { beginChunkExport, exportChunk, beginChunkImport, importChunk, chunkExportStatus, chunkImportStatus } from "../worker/relocation-chunks.js";

const origin = 'https://large-fixture.example';
const route = { projectId: 'proj_fixture', origin, objectName: 'source', generation: 1 };
const destinationRoute = { ...route, objectName: 'target', generation: 2 };
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const arg = (value) => value && typeof value === "object" && "integer" in value ? { kind: "int", value: value.integer } : value && typeof value === "object" && "blob" in value ? { kind: "blob", value: value.blob } : { kind: "value", value };
const id = (prefix, number) => prefix + String(number).padStart(8, "0");

export class NextgenRelocation extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = ctx.storage;
    this.storage.transactionSync(() => {
      if (!this.storage.sql.exec("SELECT name FROM sqlite_schema WHERE name = 'projects'").toArray().length) {
        for (const statement of baseline.statements) this.storage.sql.exec(statement);
        this.storage.sql.exec('CREATE TABLE mapi_project (project_id TEXT PRIMARY KEY, schema_url TEXT NOT NULL)');
        this.storage.sql.exec('CREATE TABLE mapi_login_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)');
        this.storage.sql.exec('CREATE TABLE mapi_project_origin (origin TEXT NOT NULL)');
        this.storage.sql.exec('CREATE TABLE mapi_schema_version (version INTEGER PRIMARY KEY)');
        this.storage.sql.exec('INSERT INTO mapi_schema_version VALUES (1)');
        this.storage.sql.exec('CREATE TABLE mapi_recovery_epoch (epoch TEXT NOT NULL)');
        this.storage.sql.exec("INSERT INTO mapi_recovery_epoch VALUES ('0')");
      }
    });
  }

  initialize(name) {
    initializeOwnerFence(this.storage, route);
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      sql.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_fixture', 'Synthetic project', 1700000000000000001, 1700000000000000001)");
      sql.exec("INSERT INTO mapi_project VALUES ('proj_fixture', 'https://example.test/schema')");
      sql.exec('INSERT INTO mapi_project_origin VALUES (?)', origin);
      sql.exec("INSERT INTO teams (project_id, id, name, created_at, updated_at) VALUES ('proj_fixture', 'team_fixture', 'Fixture team', 1, 1)");
      sql.exec("INSERT INTO json_schemas (project_id, url, kind, created_at, payload) VALUES ('proj_fixture', 'https://example.test/schema', 'user-schema', 1, ?)", '{"type":"object"}');
      sql.exec("INSERT INTO encryption_keys (project_id, id, key, algorithm, state, created_at, purpose) VALUES ('proj_fixture', 'key_fixture', 'synthetic-key', 'test', 'inactive', 1, 'fixture')");
      for (const item of issuerSchema.filter(item => item.type === 'table')) sql.exec(item.sql);
      for (const item of issuerSchema.filter(item => item.type === 'index')) sql.exec(item.sql);
      for (const item of issuerSchema.filter(item => item.type === 'table')) {
        const cols = sql.exec(`PRAGMA table_xinfo(${quote(item.name)})`).toArray().filter(col => col.hidden === 0);
        const values = cols.map(col => col.name === 'project_id' ? route.projectId : col.name === 'kind' ? 'par' : col.name === 'prompt' ? 'consent' : col.name === 'profile' ? 'bearer' : col.type.toUpperCase() === 'INTEGER' ? 1 : col.type.toUpperCase() === 'BLOB' ? new Uint8Array([1, 2, 3]).buffer : 'fixture');
        sql.exec(`INSERT INTO ${quote(item.name)} (${cols.map(col => quote(col.name)).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...values);
      }
    });
  }

  seedUsers(start, count) {
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      for (let i = start; i < start + count; i++) {
        const user = id("user_", i);
        sql.exec("INSERT INTO users (project_id, id, schema_url, created_at, updated_at) VALUES ('proj_fixture', ?, 'https://example.test/schema', 1700000000000000001, 1700000000000000001)", user);
        sql.exec("INSERT INTO user_attributes (project_id, user_id, key, value) VALUES ('proj_fixture', ?, 'email', ?)", user, JSON.stringify(`fixture-${i}@example.test`));
        sql.exec("INSERT INTO user_passwords (project_id, id, user_id, encoded_hash, created_at) VALUES ('proj_fixture', ?, ?, 'synthetic-hash', 1)", id("password_", i), user);
      }
    });
  }

  seedEvents(start, count) {
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const payload = JSON.stringify({ detail: "x".repeat(1400) });
      for (let i = start; i < start + count; i++) {
        sql.exec("INSERT INTO events (project_id, id, event_type, category, occurred_at, created_at, payload, metadata) VALUES ('proj_fixture', ?, 'fixture.created', 'entity', 1700000000000000001, 1700000000000000001, ?, '{}')", id("event_", i), payload);
      }
    });
  }

  finishSeed() {
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      sql.exec("INSERT INTO user_attributes (project_id, user_id, key, value) VALUES ('proj_fixture', 'user_00000000', 'large', ?)", JSON.stringify('x'.repeat(180000)));
      sql.exec("INSERT INTO authz_membership_edges VALUES ('proj_fixture', 'user', 'user_00000000', 'team', 'team_fixture', 1)");
      sql.exec("INSERT INTO authz_assignments (id, project_id, catalog_id, principal_type, principal_id, object_type, relation, scope_kind, created_at, updated_at) VALUES ('grant_fixture', 'proj_fixture', 'cat_sys_1', 'user', 'user_00000000', 'project', 'admin', 'project', 1, 1)");
      sql.exec("INSERT INTO releases (project_id, id, content_hash, pointers, metadata, created_at) VALUES ('proj_fixture', 'release_fixture', ?, '[\"fixture\"]', '{}', 1)", 'a'.repeat(64));
      sql.exec("INSERT INTO deployments (project_id, id, release_id, origin_kind, metadata, deployed_at) VALUES ('proj_fixture', 'deployment_fixture', 'release_fixture', 'primary', '{}', 1)");
      sql.exec("INSERT INTO sessions (project_id, id, created_at, updated_at, time_to_live, user_id) VALUES ('proj_fixture', 'session_fixture', 1, 1, 100000, 'user_00000000')");
      sql.exec("INSERT INTO auth_attempts (project_id, id, handoff_token, created_at, time_to_live) VALUES ('proj_fixture', 'attempt_fixture', X'000102FF', 1, 100000)");
    });
    freezeOwnerFence(this.storage, route, 'move_fixture');
    const manifest = inspectRelocationSource(this.storage, route, 'move_fixture');
    beginChunkExport(this.storage, "proj_fixture", 1, "move_fixture", manifest.tables);
    return manifest;
  }

  beginImport(name, manifest) { reserveMoveDestination(this.storage, destinationRoute, 'move_fixture'); prepareRelocationDestination(this.storage, manifest, destinationRoute); beginChunkImport(this.storage, "proj_fixture", 1, "move_fixture", name, manifest.tables); }
  chunk(index, fail) { return exportChunk(this.storage, "proj_fixture", 1, "move_fixture", index, fail); }
  receive(part, fail) { return importChunk(this.storage, "proj_fixture", part, fail); }
  status() { return { source: chunkExportStatus(this.storage, "proj_fixture"), destination: chunkImportStatus(this.storage, "proj_fixture"), fence: projectFenceStatus(this.storage, "proj_fixture"), owner: this.storage.sql.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name='mapi_owner_fence'").toArray().length ? this.storage.sql.exec('SELECT digest FROM mapi_owner_fence').one() : null }; }
  reconcile(manifest) { restoreRelocationMetadata(this.storage, manifest); return inspectRelocationDestination(this.storage, manifest); }
  digest(manifest, role, table, cursor) { return digestRelocationPage(this.storage, manifest, role, table, cursor); }
  page(table, cursor) {
    const info = this.storage.sql.exec(`PRAGMA table_xinfo(${quote(table)})`).toArray();
    const columns = info.filter((column) => column.hidden === 0).map((column) => column.name);
    const keys = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    const order = keys.map(quote).join(", ");
    const where = cursor ? ` WHERE (${order}) > (${keys.map(() => "?").join(", ")})` : "";
    const result = execute(this.storage, { statement: `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}${where} ORDER BY ${order} LIMIT 64`, args: cursor ? cursor.map(arg) : [], query: true });
    return { rows: result.rows, cursor: result.rows.length ? keys.map((key) => result.rows.at(-1)[columns.indexOf(key)]) : null };
  }
  fk() { return this.storage.sql.exec("PRAGMA foreign_key_check").toArray().length; }
  plan() { return this.storage.sql.exec("EXPLAIN QUERY PLAN SELECT project_id, id FROM events WHERE (project_id, id) > (?, ?) ORDER BY project_id, id LIMIT 1", "proj_fixture", "event_00000000").toArray().map((row) => row.detail); }
  evict() { this.ctx.abort("fixture eviction"); }
}

export default {
  async fetch(request, env) {
    try {
      const body = await request.json();
      const object = env.PROJECT.getByName(body.name);
      switch (body.action) {
        case "initialize": return Response.json(await object.initialize(body.name) ?? true);
        case "users": return Response.json(await object.seedUsers(body.start, body.count) ?? true);
        case "events": return Response.json(await object.seedEvents(body.start, body.count) ?? true);
        case "finish": return Response.json(await object.finishSeed());
        case "begin": return Response.json(await object.beginImport(body.name, body.manifest) ?? true);
        case "reconcile": return Response.json(await object.reconcile(body.manifest));
        case "digest": return Response.json(await object.digest(body.manifest, body.role, body.table, body.cursor));
        case "chunk": return Response.json(await object.chunk(body.index, body.fail));
        case "receive": return Response.json(await object.receive(body.part, body.fail) ?? true);
        case "status": return Response.json(await object.status());
        case "page": return Response.json(await object.page(body.table, body.cursor));
        case "fk": return Response.json(await object.fk());
        case "plan": return Response.json(await object.plan());
        case "evict": return Response.json(await object.evict());
        default: return new Response(null, { status: 404 });
      }
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
};
