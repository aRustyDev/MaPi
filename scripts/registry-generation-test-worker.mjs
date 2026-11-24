import { DurableObject } from "cloudflare:workers";
import { ProjectRegistry } from "../worker/registry.js";

export class RegistryGenerationOwner extends DurableObject {
  provisioningAttestation(origin, objectName, generation) {
    return { projectId: "proj_pending", origin, objectName, generation, objectId: this.ctx.id.toString() };
  }
  activateProvisioning() {}
}

export class RegistryGenerationTest extends DurableObject {
  async run() {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS project_routes (
      origin TEXT PRIMARY KEY,
      object_name TEXT NOT NULL UNIQUE,
      project_id TEXT UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('pending', 'active'))
    )`);
    if (!sql.exec("SELECT 1 FROM project_routes WHERE origin = 'https://legacy.example'").toArray().length) {
      sql.exec("INSERT INTO project_routes (origin, object_name, project_id, state) VALUES ('https://legacy.example', 'application', 'proj_legacy', 'active')");
      sql.exec("INSERT INTO project_routes (origin, object_name, project_id, state) VALUES ('https://pending.example', 'project:pending', NULL, 'pending')");
    }
    const registry = new ProjectRegistry(this.ctx, this.env);
    const legacy = registry.resolve("https://legacy.example");
    const pending = registry.resolve("https://pending.example");
    if (legacy?.generation !== 1 || legacy.project_id !== "proj_legacy" || legacy.object_name !== "application" || legacy.state !== "active") throw new Error("legacy route changed during upgrade");
    if (pending?.generation !== 1 || !["pending", "active"].includes(pending.state)) throw new Error("pending route changed during upgrade");
    const activated = await registry.activate("https://pending.example", "project:pending", "proj_pending");
    if (activated.generation !== 1 || registry.resolve("https://pending.example").project_id !== "proj_pending") throw new Error("activation lost generation");
    const added = registry.reserve("https://new.example", "project:new");
    if (added.generation !== 1 || registry.reserve("https://new.example", "ignored").generation !== 1) throw new Error("new reservation lost generation");
    let conflictRejected = false;
    try { await registry.activate("https://new.example", "wrong-owner", "proj_new"); } catch { conflictRejected = true; }
    if (!conflictRejected || registry.resolve("https://new.example").state !== "pending") throw new Error("conflicting activation changed the route");
    new ProjectRegistry(this.ctx, this.env);
    if (registry.resolve("https://legacy.example").generation !== 1) throw new Error("upgrade retry changed generation");
    let rejected = false;
    try { sql.exec("UPDATE project_routes SET generation = 0 WHERE origin = 'https://legacy.example'"); } catch { rejected = true; }
    if (!rejected) throw new Error("nonpositive generation accepted");
    return { ok: true };
  }

  evict() { this.ctx.abort("Registry upgrade restart test"); }
}

export default {
  async fetch(_request, env) {
    const registry = env.REGISTRY_TEST.getByName("legacy");
    if (new URL(_request.url).pathname === "/evict") {
      try { await registry.evict(); } catch { return new Response(null, { status: 204 }); }
      return new Response(null, { status: 500 });
    }
    try { return Response.json(await registry.run()); }
    catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
};
