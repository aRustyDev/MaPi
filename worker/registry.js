import { DurableObject } from "cloudflare:workers";

export function canonicalOrigin(value) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid project origin");
  }
  return url.origin;
}

export class ProjectRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS project_routes (
      origin TEXT PRIMARY KEY,
      object_name TEXT NOT NULL UNIQUE,
      project_id TEXT UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('pending', 'active'))
    )`);
  }

  resolve(origin) {
    return this.ctx.storage.sql.exec("SELECT origin, object_name, project_id, state FROM project_routes WHERE origin = ?", canonicalOrigin(origin)).toArray()[0] ?? null;
  }

  reserve(origin, objectName) {
    origin = canonicalOrigin(origin);
    if (typeof objectName !== "string" || !objectName) throw new Error("Invalid object name");
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const existing = sql.exec("SELECT origin, object_name, project_id, state FROM project_routes WHERE origin = ?", origin).toArray()[0];
      if (existing) return existing;
      sql.exec("INSERT INTO project_routes (origin, object_name, state) VALUES (?, ?, 'pending')", origin, objectName);
      return { origin, object_name: objectName, project_id: null, state: "pending" };
    });
  }

  activate(origin, objectName, projectId) {
    origin = canonicalOrigin(origin);
    if (typeof projectId !== "string" || !/^proj_[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error("Invalid project ID");
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const existing = sql.exec("SELECT origin, object_name, project_id, state FROM project_routes WHERE origin = ?", origin).toArray()[0];
      if (!existing || existing.object_name !== objectName || (existing.project_id && existing.project_id !== projectId)) throw new Error("Project route conflict");
      sql.exec("UPDATE project_routes SET project_id = ?, state = 'active' WHERE origin = ?", projectId, origin);
      return { origin, object_name: objectName, project_id: projectId, state: "active" };
    });
  }
}
