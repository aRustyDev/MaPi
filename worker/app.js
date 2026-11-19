import { DurableObject } from "cloudflare:workers";
import baseline from "./generated/baseline.json";
import wasm from "./wasm-module.js";
import { instantiateReactor } from "./wasi.js";
import { execute, sqliteError } from "./sql.js";
import { canonicalOrigin, ProjectRegistry } from "./registry.js";
import { renderLogin } from "./login-ui.js";
import { handleFlowProxy } from "./flow-proxy.js";
import { handleOAuthIngress, isOAuthRoute } from "./oauth-ingress.js";

export { ProjectRegistry };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const rejected = Symbol("transaction rejected");
const noStore = { "cache-control": "no-store" };

function page(body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MaPi</title><body>${body}</body></html>`, {
    status, headers: { ...noStore, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  });
}

async function readLimited(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error("body too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return decoder.decode(bytes);
}

function sameKey(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

// One object is the authoritative database for an application deployment.
export class NextgenApplication extends DurableObject {
  #reactor;
  #memory;
  #failAudit = 0;
  #wasmDiagnostic = "";
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_schema_version (version INTEGER PRIMARY KEY)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_project (project_id TEXT PRIMARY KEY, schema_url TEXT NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_project_origin (origin TEXT NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_login_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_recovery_epoch (epoch TEXT NOT NULL)");
      if (!ctx.storage.sql.exec("SELECT epoch FROM mapi_recovery_epoch").toArray().length) ctx.storage.sql.exec("INSERT INTO mapi_recovery_epoch VALUES ('0')");
      const current = ctx.storage.sql.exec("SELECT version FROM mapi_schema_version").toArray();
      if (current.length === 0) {
        for (const statement of baseline.statements) ctx.storage.sql.exec(statement);
        ctx.storage.sql.exec("INSERT INTO mapi_schema_version (version) VALUES (?)", baseline.version);
      } else if (current.length !== 1 || ![baseline.version, 2].includes(current[0].version)) {
        throw new Error("Unsupported application database schema version");
      }
      if (env.MAPI_SCHEMA_TARGET === "2" && ctx.storage.sql.exec("SELECT version FROM mapi_schema_version").one().version === 1) {
        ctx.storage.sql.exec("CREATE TABLE mapi_schema_history (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
        ctx.storage.sql.exec("INSERT INTO mapi_schema_history VALUES (2, ?)", Date.now());
        ctx.storage.sql.exec("UPDATE mapi_schema_version SET version = 2");
      }
    });
  }

  #initialize() {
    if (this.#reactor) return;
    let output;
    this.#reactor = instantiateReactor(wasm, (memory) => {
      this.#memory = memory;
      return {
        sql: (ptr, size) => {
          const query = JSON.parse(decoder.decode(new Uint8Array(memory(), ptr, size)));
          let result;
          try {
            if (this.#failAudit > 0 && /\bINSERT INTO events\b/i.test(query.statement)) {
              this.#failAudit--;
              if (this.#failAudit === 0) throw new Error("Injected mutation audit write failure");
            }
            result = execute(this.ctx.storage, query);
          } catch (error) {
            if (this.env.MAPI_LOCAL_TEST === "1") console.error("SQLite bridge:", query.statement, String(error));
            result = { error: sqliteError(error) };
          }
          output = encoder.encode(JSON.stringify(result));
          return output.length;
        },
        result: (ptr, size) => {
          new Uint8Array(memory(), ptr, size).set(output);
          output.fill(0);
          output = undefined;
        },
        transaction: () => {
          try {
            this.ctx.storage.transactionSync(() => {
              if (this.#reactor.mapi_transaction_body() !== 0) throw rejected;
            });
            return 0;
          } catch (error) {
            if (error === rejected) return 1;
            if (this.env.MAPI_LOCAL_TEST === "1") console.error("SQLite commit:", String(error));
            return 2;
          }
        },
      };
    }, (bytes) => {
      if (this.#wasmDiagnostic.length < 2048) this.#wasmDiagnostic += decoder.decode(bytes);
    });
    const key = JSON.parse(decoder.decode(Uint8Array.fromBase64(this.env.MAPI_MASTER_KEY)));
    if (this.#call("mapi_init", { ...key, projectId: this.projectId() }) !== true) {
      throw new Error("Go reactor initialization failed");
    }
  }

  #call(name, input) {
    this.#wasmDiagnostic = "";
    try {
      if (input !== undefined) {
        const encoded = encoder.encode(JSON.stringify(input));
        const ptr = this.#reactor.mapi_alloc(encoded.length);
        new Uint8Array(this.#memory(), ptr, encoded.length).set(encoded);
        encoded.fill(0);
      }
      const result = this.#reactor[name]();
      const offset = Number(result >> 32n);
      const size = Number(result & 0xffffffffn);
      const value = JSON.parse(decoder.decode(new Uint8Array(this.#memory(), offset, size)));
      this.#reactor.mapi_release();
      if (value?.error) {
        const error = new Error(value.error);
        error.code = value.code;
        throw error;
      }
      return value;
    } catch (error) {
      const fatal = this.#wasmDiagnostic.match(/(?:^|\n)fatal error: ([^\n]+)/)?.[1];
      if (fatal) console.error("Go/Wasm runtime:", fatal);
      if (this.env.MAPI_LOCAL_TEST === "1" && this.#wasmDiagnostic) {
        console.error("Go/Wasm diagnostic:", this.#wasmDiagnostic.slice(0, 1400));
      }
      this.#reactor = undefined;
      this.#memory = undefined;
      throw error;
    }
  }

  handleRequest(request) {
    try {
      this.#initialize();
      return this.#call("mapi_request", request);
    } catch (error) {
      this.#reactor = undefined;
      if (this.env.MAPI_LOCAL_TEST === "1") console.error("Go reactor:", String(error));
      return { status: 503, headers: {}, body: null };
    }
  }

  // Check registry routing and recovery state in the same synchronous owner
  // turn as the operation, so no state change can interleave after admission.
  #admitRoute(route) {
    return Boolean(route?.projectId && route.origin && this.env.MAPI_MAINTENANCE !== "1" &&
      this.projectId() === route.projectId && this.projectOrigin() === route.origin &&
      this.ctx.storage.sql.exec("SELECT epoch FROM mapi_recovery_epoch").one().epoch === (this.env.MAPI_RECOVERY_EPOCH ?? "0"));
  }

  flowRequest(request, route) {
    if (!this.#admitRoute(route)) return { status: 503, headers: {}, body: null };
    const url = new URL(request.url);
    if (url.origin !== route.origin) return { status: 403, headers: {}, body: null };
    if (request.method === "POST" && /^\/api\/v1\/flows\/flow_[A-Za-z0-9_-]+\/submit$/.test(url.pathname) && !this.allowLogin(request.peer ?? "127.0.0.1")) return { status: 429, headers: {}, body: null };
    this.#initialize();
    const projectId = route.projectId;
    if (url.pathname === "/api/v1/sessions/exchange") {
      const { token } = this.#call("mapi_project_token", { projectId });
      request.headers.authorization = [`Bearer ${token}`];
    }
    return this.#call("mapi_request", request);
  }

  oauthRequest(request, route) {
    if (this.env.MAPI_OIDC_EXPERIMENTAL !== "1") throw new Error("Experimental issuer is disabled");
    if (!this.#admitRoute(route)) return { status: 503, headers: {}, body: null };
    const url = new URL(request.url);
    if (url.origin !== route.origin || !isOAuthRoute(request.method, url.pathname, route.projectId)) return { status: 403, headers: {}, body: null };
    if (!this.allowLogin(request.peer ?? "127.0.0.1", "oauth")) return { status: 429, headers: {}, body: null };
    this.#initialize();
    return this.#call("mapi_oauth_request", { projectId: route.projectId, origin: route.origin, request });
  }

  oauthAdmin(action, options = {}) {
    if (this.env.MAPI_OIDC_EXPERIMENTAL !== "1") throw new Error("Experimental issuer is disabled");
    if (!["initialize", "register", "rotate", "register_logout", "rotate_client_secret", "revoke_client_secrets"].includes(action)) throw new Error("Unsupported issuer action");
    this.#initialize();
    return this.#call("mapi_oauth_admin", { projectId: this.projectId(), origin: this.projectOrigin(), action, ...options });
  }

  flowRelease(action, options = {}) {
    if (this.env.MAPI_OIDC_EXPERIMENTAL !== "1") throw new Error("Experimental flow release is disabled");
    if (!["status", "publish", "rollback"].includes(action)) throw new Error("Unsupported flow release action");
    this.#initialize();
    return this.#call("mapi_flow_release", { projectId: this.projectId(), origin: this.projectOrigin(), action, ...options });
  }

  projectId() {
    return this.ctx.storage.sql.exec("SELECT project_id FROM mapi_project").toArray()[0]?.project_id ?? "";
  }

  identity() {
    return this.projectId();
  }

  projectOrigin() {
    return this.ctx.storage.sql.exec("SELECT origin FROM mapi_project_origin").toArray()[0]?.origin ?? this.env.MAPI_APP_ORIGIN;
  }

  provision(name, origin) {
    origin = canonicalOrigin(origin);
    const savedOrigin = this.ctx.storage.sql.exec("SELECT origin FROM mapi_project_origin").toArray()[0]?.origin;
    if (savedOrigin && savedOrigin !== origin) throw new Error("Project origin cannot be changed by provisioning");
    if (this.projectId()) {
      if (canonicalOrigin(this.projectOrigin()) !== origin) throw new Error("Project origin cannot be changed by provisioning");
      return { projectId: this.projectId() };
    }
    if (!savedOrigin) this.ctx.storage.sql.exec("INSERT INTO mapi_project_origin VALUES (?)", origin);
    this.#initialize();
    const result = this.#call("mapi_provision", { name, origin });
    this.#reactor = undefined;
    this.#memory = undefined;
    return result;
  }

  addUser(email, password) {
    const projectId = this.projectId();
    if (!projectId) throw new Error("Project is not initialized");
    this.#initialize();
    return this.#call("mapi_add_user", { projectId, email, password });
  }

  failNextAudit(after = 1) {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local testing is disabled");
    if (!Number.isInteger(after) || after < 1 || after > 20) throw new Error("Invalid failure position");
    this.#failAudit = after;
  }

  testCounts() {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local testing is disabled");
    const sql = this.ctx.storage.sql;
    return Object.fromEntries(["projects", "users", "events"].map((table) => [table, sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).one().count]));
  }

  evict() {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local testing is disabled");
    this.ctx.abort("MaPi local eviction test");
  }

  async bookmark() {
    return this.ctx.storage.getCurrentBookmark();
  }

  async restore(bookmark) {
    if (this.env.MAPI_MAINTENANCE !== "1" || this.status().recoveryReady) throw new Error("Recovery mode is not armed");
    await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    setTimeout(() => this.ctx.abort("Restore requested"), 0);
  }

  recover() {
    if (this.env.MAPI_MAINTENANCE !== "1" || this.status().recoveryReady) throw new Error("Recovery mode is not armed");
    this.#initialize();
    return this.#call("mapi_recover", { projectId: this.projectId(), epoch: this.env.MAPI_RECOVERY_EPOCH });
  }

  #upstream(method, path, body, headers = {}) {
    const request = {
      method, url: this.projectOrigin() + path,
      headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, [value]])),
      body: body === undefined ? "" : encoder.encode(JSON.stringify(body)).toBase64(),
      peer: "127.0.0.1",
    };
    if (body !== undefined) request.headers["content-type"] = ["application/json"];
    const result = this.#call("mapi_request", request);
    const data = result.body ? JSON.parse(decoder.decode(Uint8Array.fromBase64(result.body))) : null;
    return { ...result, data };
  }

  #mintHandoff(email, password) {
    this.#initialize();
    const projectId = this.projectId();
    if (!projectId) return { status: 503 };
    const { token } = this.#call("mapi_project_token", { projectId });
    const auth = { authorization: "Bearer " + token };
    const start = this.#upstream("POST", "/auth_attempts", { project_id: projectId }, auth);
    if (start.status !== 200 && start.status !== 201) return { status: 401 };
    const path = `/auth_attempts/${start.data.attempt_id}/challenges`;
    for (const [method, proof] of [["identifier", { login_name: email }], ["password", { password }]]) {
      const challenge = this.#upstream("POST", path, { method }, auth);
      if (challenge.status >= 300) return { status: 401 };
      const verified = this.#upstream("POST", `${path}/${challenge.data.challenge_id}/verify`, proof, auth);
      if (verified.status >= 300) return { status: 401 };
    }
    const handoff = this.#upstream("POST", `/auth_attempts/${start.data.attempt_id}/handoff`, undefined, auth);
    return handoff.status >= 300 ? { status: 401 } : { status: 200, handoff: handoff.data.handoff_token };
  }

  #exchangeHandoff(handoff) {
    const projectId = this.projectId();
    const { token } = this.#call("mapi_project_token", { projectId });
    return this.#upstream("POST", `/sessions/exchange?project_id=${encodeURIComponent(projectId)}`, { handoff_token: handoff }, { authorization: "Bearer " + token });
  }

  allowLogin(ip, scope = "password") {
    if (!["password", "oauth"].includes(scope)) throw new Error("Invalid throttle scope");
    const window = Math.floor(Date.now() / 60000);
    const allowed = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM mapi_login_limits WHERE window < ?", window);
      const globalKey = "global:" + scope, ipKey = "ip:" + scope + ":" + ip;
      const [globalMax, ipMax] = scope === "password" ? [120, 60] : [360, 180];
      for (const [key, max] of [[globalKey, globalMax], [ipKey, ipMax]]) {
        const row = sql.exec("SELECT count FROM mapi_login_limits WHERE key = ? AND window = ?", key, window).toArray()[0];
        if ((row?.count ?? 0) >= max) return false;
      }
      for (const key of [globalKey, ipKey]) {
        sql.exec("INSERT INTO mapi_login_limits VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1, window = excluded.window", key, window);
      }
      return true;
    });
    return allowed;
  }

  login(email, password, ip) {
    if (!this.allowLogin(ip)) return { status: 429 };
    const handoff = this.#mintHandoff(email, password);
    if (handoff.status !== 200) return handoff;
    const session = this.#exchangeHandoff(handoff.handoff);
    if (session.status >= 300) return { status: 401 };
    return { status: 200, cookie: session.headers["Set-Cookie"]?.[0] ?? session.headers["set-cookie"]?.[0] };
  }

  testRecovery(email, password) {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local testing is disabled");
    const handoff = this.#mintHandoff(email, password);
    if (handoff.status !== 200) throw new Error("Test handoff failed");
    this.#call("mapi_recover", { projectId: this.projectId(), epoch: this.env.MAPI_RECOVERY_EPOCH ?? "0" });
    return this.#exchangeHandoff(handoff.handoff).status;
  }

  session(cookie, operation = "read", csrfToken = "") {
    this.#initialize();
    const project = encodeURIComponent(this.projectId());
    const headers = { cookie };
    if (operation === "read") return this.#upstream("GET", `/sessions/me?project_id=${project}`, undefined, headers);
    if (operation === "csrf") return this.#upstream("GET", `/sessions/me/csrf?project_id=${project}`, undefined, headers);
    headers["x-zitadel-csrf"] = csrfToken;
    headers.origin = this.projectOrigin();
    return this.#upstream("DELETE", `/sessions/me?project_id=${project}`, undefined, headers);
  }

  status() {
    return {
      schemaVersion: this.ctx.storage.sql.exec("SELECT version FROM mapi_schema_version").one().version,
      ready: Boolean(this.projectId()),
      wasmMemoryBytes: this.#memory?.().byteLength ?? 0,
      maintenance: this.env.MAPI_MAINTENANCE === "1",
      recoveryReady: this.ctx.storage.sql.exec("SELECT epoch FROM mapi_recovery_epoch").one().epoch === (this.env.MAPI_RECOVERY_EPOCH ?? "0"),
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const registry = env.PROJECT_REGISTRY.getByName("projects");
    const configuredOrigin = canonicalOrigin(env.MAPI_APP_ORIGIN);
    let requestOrigin = url.origin;
    const configuredUrl = new URL(configuredOrigin);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && ["localhost", "127.0.0.1", "[::1]"].includes(configuredUrl.hostname) && url.port === configuredUrl.port && url.protocol === configuredUrl.protocol) {
      requestOrigin = configuredOrigin;
    }
    let route = await registry.resolve(requestOrigin);
    if (!route && requestOrigin === configuredOrigin) route = await registry.reserve(configuredOrigin, "application");
    if (url.pathname === "/_mapi/admin/projects" && request.method === "POST") {
      if (!sameKey(request.headers.get("authorization"), `Bearer ${env.MAPI_OPERATOR_TOKEN || ""}`) || !env.MAPI_OPERATOR_TOKEN) return new Response(null, { status: 404, headers: noStore });
      if (env.MAPI_MAINTENANCE === "1") return new Response(null, { status: 503, headers: noStore });
      let args;
      try { args = JSON.parse(await readLimited(request, 4096)); } catch { return new Response(null, { status: 400, headers: noStore }); }
      if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 200 || typeof args.origin !== "string") return new Response(null, { status: 400, headers: noStore });
      let origin;
      try { origin = canonicalOrigin(args.origin); } catch { return new Response(null, { status: 400, headers: noStore }); }
      try {
        const reserved = await registry.reserve(origin, `project:${crypto.randomUUID()}`);
        const project = env.NEXTGEN_APPLICATION.getByName(reserved.object_name);
        if (!(await project.status()).recoveryReady) return new Response(null, { status: 503, headers: noStore });
        const result = await project.provision(args.name, origin);
        await registry.activate(origin, reserved.object_name, result.projectId);
        return Response.json({ projectId: result.projectId, origin }, { headers: noStore });
      } catch (error) {
        console.error("Project initialization failed", error.code ?? "internal error");
        return new Response(null, { status: 503, headers: noStore });
      }
    }
    if (!route) return new Response(null, { status: 404, headers: noStore });
    const object = env.NEXTGEN_APPLICATION.getByName(route.object_name);
    if (route.state === "pending" && route.object_name === "application") {
      const projectId = await object.identity();
      if (projectId) route = await registry.activate(route.origin, route.object_name, projectId);
    }
    // Hot-path admission, rate limiting and execution happen together inside
    // the owning object. The registry must still resolve an active route first.
    if (route.state === "active" && env.MAPI_OIDC_EXPERIMENTAL === "1" && isOAuthRoute(request.method, url.pathname, route.project_id)) {
      if (env.MAPI_MAINTENANCE === "1") return new Response(null, { status: 503, headers: noStore });
      try { return await handleOAuthIngress(request, object, route.project_id, route.origin); }
      catch { return new Response(null, { status: 503, headers: noStore }); }
    }
    if (route.state === "active" && env.MAPI_OFFICIAL_LOGIN === "1" && url.pathname.startsWith("/__nextgen/")) {
      if (env.MAPI_MAINTENANCE === "1") return new Response(null, { status: 503, headers: noStore });
      try { return await handleFlowProxy(request, object, route.project_id, route.origin); }
      catch { return new Response(null, { status: 503, headers: noStore }); }
    }
    if (route.state === "active" && route.project_id !== await object.identity()) return new Response(null, { status: 503, headers: noStore });
    if (url.pathname.startsWith("/_mapi/admin/oidc/")) {
      const actions = new Map([["/_mapi/admin/oidc/init", "initialize"], ["/_mapi/admin/oidc/clients", "register"], ["/_mapi/admin/oidc/rotate", "rotate"], ["/_mapi/admin/oidc/logout-uri", "register_logout"], ["/_mapi/admin/oidc/client-secret/rotate", "rotate_client_secret"], ["/_mapi/admin/oidc/client-secret/revoke", "revoke_client_secrets"], ["/_mapi/admin/oidc/flow/status", "flow_status"], ["/_mapi/admin/oidc/flow/publish", "flow_publish"], ["/_mapi/admin/oidc/flow/rollback", "flow_rollback"]]);
      const action = actions.get(url.pathname);
      if (env.MAPI_OIDC_EXPERIMENTAL !== "1" || !action || request.method !== "POST" || !env.MAPI_OPERATOR_TOKEN || !sameKey(request.headers.get("authorization"), `Bearer ${env.MAPI_OPERATOR_TOKEN}`)) return new Response(null, { status: 404, headers: noStore });
      const status = await object.status();
      if (route.state !== "active" || env.MAPI_MAINTENANCE === "1" || status.maintenance || !status.recoveryReady || url.origin !== route.origin) return new Response(null, { status: 503, headers: noStore });
      let body;
      try { body = JSON.parse(await readLimited(request, 65536) || "{}"); } catch { return new Response(null, { status: 400, headers: noStore }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return new Response(null, { status: 400, headers: noStore });
      const options = {};
      if (action === "register") {
        if (!body.document || typeof body.document !== "object" || Array.isArray(body.document)) return new Response(null, { status: 400, headers: noStore });
        options.document = body.document;
      }
      if (action === "register_logout") {
        if (typeof body.clientId !== "string" || typeof body.logoutUri !== "string" || !body.clientId || !body.logoutUri) return new Response(null, { status: 400, headers: noStore });
        options.clientId = body.clientId; options.logoutUri = body.logoutUri;
      }
      if (["rotate_client_secret", "revoke_client_secrets"].includes(action)) {
        if (typeof body.clientId !== "string" || !body.clientId) return new Response(null, { status: 400, headers: noStore });
        options.clientId = body.clientId;
      }
      if (action === "flow_publish") {
        if (!body.document || typeof body.document !== "object" || Array.isArray(body.document) || typeof body.expectedDeploymentId !== "string" || !body.expectedDeploymentId) return new Response(null, { status: 400, headers: noStore });
        options.document = body.document; options.expectedDeploymentId = body.expectedDeploymentId;
      }
      if (action === "flow_rollback") {
        if (typeof body.targetDeploymentId !== "string" || !body.targetDeploymentId || typeof body.expectedDeploymentId !== "string" || !body.expectedDeploymentId) return new Response(null, { status: 400, headers: noStore });
        options.targetDeploymentId = body.targetDeploymentId; options.expectedDeploymentId = body.expectedDeploymentId;
      }
      try { return Response.json(await (action.startsWith("flow_") ? object.flowRelease(action.slice(5), options) : object.oauthAdmin(action, options)), { headers: noStore }); }
      catch { return new Response(null, { status: 400, headers: noStore }); }
    }
    if (["/livez", "/readyz", "/api/v1/livez", "/api/v1/readyz", "/api/v1/openapi.json"].includes(url.pathname)) {
      const headers = {};
      for (const name of ["accept", "accept-encoding", "if-none-match", "if-modified-since", "range", "origin"]) {
        if (request.headers.has(name)) headers[name] = [request.headers.get(name)];
      }
      const result = await object.handleRequest({ method: request.method, url: request.url, headers, body: "", peer: request.headers.get("cf-connecting-ip") ?? "127.0.0.1" });
      const outgoing = new Headers();
      for (const [name, values] of Object.entries(result.headers)) for (const value of values) outgoing.append(name, value);
      const body = result.body && ![204, 205, 304].includes(result.status) && request.method !== "HEAD" ? Uint8Array.fromBase64(result.body) : null;
      return new Response(body, { status: result.status, headers: outgoing, encodeBody: "manual" });
    }
    if (["/_mapi/admin/status", "/_mapi/admin/init", "/_mapi/admin/users", "/_mapi/admin/bookmark", "/_mapi/admin/restore", "/_mapi/admin/recover", "/_mapi/admin/test/fail-audit", "/_mapi/admin/test/evict", "/_mapi/admin/test/recovery", "/_mapi/admin/test/counts"].includes(url.pathname)) {
      if (!sameKey(request.headers.get("authorization"), `Bearer ${env.MAPI_OPERATOR_TOKEN || ""}`) || !env.MAPI_OPERATOR_TOKEN) {
        return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
      }
      if (url.pathname.endsWith("/status") && request.method === "GET") {
        return Response.json(await object.status(), { headers: { "cache-control": "no-store" } });
      }
      if (url.pathname.endsWith("/bookmark") && request.method === "GET") {
        return Response.json({ bookmark: await object.bookmark() }, { headers: noStore });
      }
      if (url.pathname.endsWith("/recover") && request.method === "POST") {
        if (env.MAPI_MAINTENANCE !== "1") return new Response(null, { status: 403, headers: noStore });
        try { await object.recover(); return new Response(null, { status: 204, headers: noStore }); }
        catch { return new Response(null, { status: 503, headers: noStore }); }
      }
      if (url.pathname.endsWith("/restore") && request.method === "POST") {
        if (env.MAPI_MAINTENANCE !== "1") return new Response(null, { status: 403, headers: noStore });
        let text;
        try { text = await readLimited(request, 4096); } catch { return new Response(null, { status: 413 }); }
        let args;
        try { args = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
        if (typeof args.bookmark !== "string" || !/^[0-9a-z-]+$/.test(args.bookmark)) return new Response(null, { status: 400 });
        try { await object.restore(args.bookmark); } catch { return new Response(null, { status: 503, headers: noStore }); }
        return new Response(null, { status: 202, headers: noStore });
      }
      const state = await object.status();
      if (env.MAPI_MAINTENANCE === "1" || !state.recoveryReady) return new Response(null, { status: 503, headers: noStore });
      if (url.pathname === "/_mapi/admin/test/fail-audit" && request.method === "POST" && env.MAPI_LOCAL_TEST === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        let args = {};
        try { const text = await readLimited(request, 1024); if (text) args = JSON.parse(text); } catch { return new Response(null, { status: 400, headers: noStore }); }
        await object.failNextAudit(args.after ?? 1);
        return new Response(null, { status: 204, headers: noStore });
      }
      if (url.pathname === "/_mapi/admin/test/counts" && request.method === "GET" && env.MAPI_LOCAL_TEST === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        return Response.json(await object.testCounts(), { headers: noStore });
      }
      if (url.pathname === "/_mapi/admin/test/evict" && request.method === "POST" && env.MAPI_LOCAL_TEST === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        await object.evict();
        return new Response(null, { status: 204, headers: noStore });
      }
      if (url.pathname === "/_mapi/admin/test/recovery" && request.method === "POST" && env.MAPI_LOCAL_TEST === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        let args;
        try { args = JSON.parse(await readLimited(request, 4096)); } catch { return new Response(null, { status: 400, headers: noStore }); }
        const status = await object.testRecovery(args.email, args.password);
        return Response.json({ status }, { headers: noStore });
      }
      if (url.pathname.endsWith("/init") && request.method === "POST") {
        if (!env.MAPI_MASTER_KEY || !env.MAPI_APP_ORIGIN) return new Response(null, { status: 503 });
        let text;
        try { text = await readLimited(request, 4096); } catch { return new Response(null, { status: 413 }); }
        let args;
        try { args = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
        if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 200) return new Response(null, { status: 400 });
        try {
          const result = await object.provision(args.name, route.origin);
          await registry.activate(route.origin, route.object_name, result.projectId);
          return Response.json(result, { headers: { "cache-control": "no-store" } });
        } catch (error) {
          console.error("Project initialization failed", String(error));
          return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
        }
      }
      if (url.pathname.endsWith("/users") && request.method === "POST") {
        if (route.state !== "active") return new Response(null, { status: 503, headers: noStore });
        let text;
        try { text = await readLimited(request, 4096); } catch { return new Response(null, { status: 413 }); }
        let args;
        try { args = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
        if (typeof args.email !== "string" || typeof args.password !== "string" || !args.email || !args.password) return new Response(null, { status: 400 });
        try {
          return Response.json(await object.addUser(args.email, args.password), { headers: { "cache-control": "no-store" } });
        } catch (error) {
          if (error.code === "user.already_exists") return new Response(null, { status: 409, headers: noStore });
          console.error("User creation failed", error.code ?? "internal error");
          return new Response(null, { status: 400, headers: noStore });
        }
      }
      return new Response(null, { status: 405 });
    }
    if (route.state !== "active") return new Response(null, { status: 503, headers: noStore });
    const appStatus = await object.status();
    if (env.MAPI_MAINTENANCE === "1" || appStatus.maintenance || !appStatus.recoveryReady) return new Response(null, { status: 503, headers: noStore });
    if (env.MAPI_OFFICIAL_LOGIN === "1" && url.pathname === "/zitadel-login.mjs" && request.method === "GET") {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname === "/login" && request.method === "GET") {
      if (env.MAPI_OFFICIAL_LOGIN === "1") {
        const projectId = await object.identity();
        if (!projectId) return new Response(null, { status: 503, headers: noStore });
        const handles = url.searchParams.getAll("mapi_oauth");
        if (handles.length && (env.MAPI_OIDC_EXPERIMENTAL !== "1" || handles.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(handles[0]))) return new Response(null, { status: 400, headers: noStore });
        return renderLogin(projectId, handles[0] ?? "");
      }
      return page('<h1>Sign in</h1><form method="post" action="/login"><label>Email <input name="email" type="email" autocomplete="username" required></label><br><label>Password <input name="password" type="password" autocomplete="current-password" required></label><br><button>Sign in</button></form>');
    }
    if (["/login", "/logout"].includes(url.pathname) && request.method === "POST") {
      if (request.headers.get("origin") !== route.origin) return new Response(null, { status: 403, headers: noStore });
      if (url.pathname === "/logout") {
        let text;
        try { text = await readLimited(request, 4096); } catch { return new Response(null, { status: 413, headers: noStore }); }
        const csrfToken = new URLSearchParams(text).get("csrf") ?? "";
        const result = await object.session(request.headers.get("cookie") ?? "", "logout", csrfToken);
        if (result.status !== 204) return new Response(null, { status: result.status, headers: noStore });
        const headers = new Headers({ ...noStore, location: "/login" });
        for (const cookie of result.headers["Set-Cookie"] ?? result.headers["set-cookie"] ?? []) headers.append("set-cookie", cookie);
        return new Response(null, { status: 303, headers });
      }
      let text;
      try { text = await readLimited(request, 4096); } catch { return new Response(null, { status: 413, headers: noStore }); }
      const form = new URLSearchParams(text);
      const result = await object.login(form.get("email") ?? "", form.get("password") ?? "", request.headers.get("cf-connecting-ip") ?? "local");
      if (result.status === 429) return page("<h1>Too many attempts</h1><p>Try again shortly.</p>", 429);
      if (result.status !== 200 || !result.cookie) return page('<h1>Sign in failed</h1><p>Check your email and password.</p><a href="/login">Try again</a>', 401);
      return new Response(null, { status: 303, headers: { ...noStore, location: "/app", "set-cookie": result.cookie } });
    }
    if (url.pathname === "/app" && request.method === "GET") {
      const result = await object.session(request.headers.get("cookie") ?? "");
      if (result.status !== 200) return new Response(null, { status: 303, headers: { ...noStore, location: "/login" } });
      const csrf = await object.session(request.headers.get("cookie") ?? "", "csrf");
      if (csrf.status !== 200 || !/^[A-Za-z0-9_-]+$/.test(csrf.data?.csrf_token ?? "")) return new Response(null, { status: 503, headers: noStore });
      return page(`<h1>Signed in</h1><form action="/logout" method="post"><input type="hidden" name="csrf" value="${csrf.data.csrf_token}"><button>Sign out</button></form>`);
    }
    if (request.method !== "GET" || url.pathname !== "/health") {
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    }
    const status = await object.status();
    return Response.json(status, { status: status.ready ? 200 : 503, headers: { "cache-control": "no-store" } });
  },
};
