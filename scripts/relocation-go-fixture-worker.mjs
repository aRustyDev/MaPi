import { NextgenApplication } from "../worker/app.js";
import { execute } from "../worker/sql.js";
import { initializeProjectFence, freezeProject, activateProject, projectFenceStatus } from "../worker/relocation.js";
import { beginChunkExport, exportChunk, beginChunkImport, importChunk } from "../worker/relocation-chunks.js";

const tables = [
  "projects", "mapi_project", "mapi_login_limits", "authz_assignments", "encryption_keys", "signing_keys",
  "json_schemas", "flow_definitions", "policies", "policy_revisions", "project_origins", "releases", "variable_sets",
  "deployments", "deployment_origins", "deployment_variable_sets", "resource_scope_index", "search_entries",
  "users", "user_attributes", "user_passwords", "sessions", "tokens", "auth_attempts", "checks", "events",
];
const referenceTables = ["authz_catalogs", "authz_expression_edges", "authz_relation_closure", "authz_relation_references", "authz_relations", "goose_db_version"];
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const arg = (value) => value && typeof value === "object" && "integer" in value ? { kind: "int", value: value.integer } : value && typeof value === "object" && "blob" in value ? { kind: "blob", value: value.blob } : { kind: "value", value };

export class GoFixture extends NextgenApplication {
  freezeForCopy(name, project) {
    initializeProjectFence(this.ctx.storage, project, name);
    freezeProject(this.ctx.storage, project, 1, "fixture-move");
    beginChunkExport(this.ctx.storage, project, 1, "fixture-move", tables);
  }
  beginCopy(name, project) { beginChunkImport(this.ctx.storage, project, 1, "fixture-move", name, tables); }
  chunk(project, index) { return exportChunk(this.ctx.storage, project, 1, "fixture-move", index); }
  receive(project, envelope) { return importChunk(this.ctx.storage, project, envelope); }
  copyStatus(project) { return projectFenceStatus(this.ctx.storage, project); }
  activateCopy(name, project) {
    activateProject(this.ctx.storage, project, 2, "fixture-move", { state: "active", project_id: project, generation: 2, move_id: "fixture-move", source_object: name });
  }
  finishCopy(origin) {
    this.ctx.storage.transactionSync(() => {
      const origins = this.ctx.storage.sql.exec("SELECT origin FROM mapi_project_origin").toArray();
      if (origins.length === 1 && origins[0].origin === origin) return;
      if (origins.length) throw Error("Target origin already set");
      this.ctx.storage.sql.exec("INSERT INTO mapi_project_origin VALUES (?)", origin);
    });
  }
  page(table, cursor) {
    if (!tables.includes(table) && !referenceTables.includes(table)) throw Error("Unexpected fixture table");
    const info = this.ctx.storage.sql.exec(`PRAGMA table_xinfo(${quote(table)})`).toArray();
    const columns = info.filter((column) => column.hidden === 0).map((column) => column.name);
    const keys = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    const order = keys.map(quote).join(", ");
    const where = cursor ? ` WHERE (${order}) > (${keys.map(() => "?").join(", ")})` : "";
    const result = execute(this.ctx.storage, { statement: `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}${where} ORDER BY ${order} LIMIT 64`, args: cursor ? cursor.map(arg) : [], query: true });
    return { rows: result.rows, cursor: result.rows.length ? keys.map((key) => result.rows.at(-1)[columns.indexOf(key)]) : null };
  }
  populated() {
    const sql = this.ctx.storage.sql;
    const tables = sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__miniflare_*' ORDER BY name").toArray();
    return tables.map(({ name }) => {
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      return { name, count: sql.exec(`SELECT COUNT(*) AS count FROM ${quoted}`).one().count };
    }).filter(({ count }) => count);
  }
}

export default {
  async fetch(request, env) {
    try {
      const input = await request.json();
      const object = env.PROJECT.getByName(input.name);
      switch (input.action) {
        case "provision": return Response.json(await object.provision(input.name, input.origin));
        case "user": return Response.json(await object.addUser(input.email, input.password));
        case "login": return Response.json(await object.login(input.email, input.password, "fixture"));
        case "session": return Response.json(await object.session(input.cookie, input.operation ?? "read", input.csrfToken ?? ""));
        case "identity": return Response.json(await object.identity());
        case "tables": return Response.json(await object.populated());
        case "freeze": return Response.json(await object.freezeForCopy(input.name, input.project) ?? true);
        case "begin": return Response.json(await object.beginCopy(input.name, input.project) ?? true);
        case "chunk": return Response.json(await object.chunk(input.project, input.index));
        case "receive": return Response.json(await object.receive(input.project, input.envelope) ?? true);
        case "copyStatus": return Response.json(await object.copyStatus(input.project));
        case "activate": return Response.json(await object.activateCopy(input.name, input.project) ?? true);
        case "finish": return Response.json(await object.finishCopy(input.origin) ?? true);
        case "page": return Response.json(await object.page(input.table, input.cursor));
        default: return new Response(null, { status: 404 });
      }
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
};
