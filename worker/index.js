import { DurableObject } from "cloudflare:workers";
import wasm from "./generated/nextgen.wasm";
import fixture from "./generated/fixture.json";
import { instantiateReactor } from "./wasi.js";
import { execute, sqliteError } from "./sql.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const rejected = Symbol("Go rejected the SQLite transaction");
const NO_STORE = { "cache-control": "no-store" };

function isAuthRoute(method, pathname) {
  const path = pathname.replace(/^\/api\/v1(?=\/)/, "");
  if (method === "GET") return path === "/sessions/me";
  if (method === "DELETE") return /^\/sessions\/sess_[a-zA-Z0-9_-]+$/.test(path);
  return method === "POST" && (path === "/auth_attempts" || path === "/sessions/exchange" ||
    /^\/auth_attempts\/att_[a-zA-Z0-9_-]+\/(?:handoff|challenges(?:\/[a-zA-Z0-9_-]+\/verify)?)$/.test(path));
}

function sameKey(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

export class NextgenProject extends DurableObject {
  #reactor;
  #memory;
  #failAudit = false;
  #wasmDiagnostic = "";

  #initialize() {
    if (this.#reactor) return;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_fixture(version INTEGER PRIMARY KEY)");
      if (this.ctx.storage.sql.exec("SELECT version FROM mapi_fixture WHERE version = 1").toArray().length) return;
      this.ctx.storage.sql.exec("PRAGMA defer_foreign_keys = ON");
      for (const statement of fixture.statements) this.ctx.storage.sql.exec(statement);
      this.ctx.storage.sql.exec("INSERT INTO mapi_fixture VALUES (1)");
    });
    let output;
    this.#reactor = instantiateReactor(wasm, (memory) => {
      this.#memory = memory;
      return {
        sql: (ptr, size) => {
          const query = JSON.parse(decoder.decode(new Uint8Array(memory(), ptr, size)));
          let result;
          try {
            if (this.#failAudit && /\bINSERT INTO events\b/i.test(query.statement)) {
              this.#failAudit = false;
              throw new Error("Injected mutation audit write failure");
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
    if (this.#call("mapi_init", { ...key, projectId: fixture.projectId }) !== true) {
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
      if (value?.error) throw new Error(value.error);
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

  probe() {
    this.#initialize();
    const value = this.#call("mapi_probe");
    return { ...value, wasmMemoryBytes: this.#memory().byteLength };
  }

  test(command, id) {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local testing is disabled");
    this.#initialize();
    const sql = this.ctx.storage.sql;
    switch (command) {
      case "events":
        return {
          sessions: sql.exec("SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?", fixture.projectId).one().count,
          seeded: sql.exec("SELECT COUNT(*) AS count FROM mapi_fixture").one().count,
          events: sql.exec("SELECT event_type, COUNT(*) AS count FROM events WHERE project_id = ? GROUP BY event_type ORDER BY event_type", fixture.projectId).toArray(),
        };
      case "expire_session":
        sql.exec("UPDATE sessions SET updated_at = 1 WHERE project_id = ? AND id = ?", fixture.projectId, id);
        return true;
      case "expire_handoff":
        sql.exec("UPDATE auth_attempts SET handed_off_at = 1 WHERE project_id = ? AND handed_off_at IS NOT NULL", fixture.projectId);
        return true;
      case "fail_audit":
        this.#failAudit = true;
        return true;
      case "evict":
        this.ctx.abort("MaPi local durability test");
        break;
      default:
        throw new Error("Unknown local test command");
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!env.MAPI_MASTER_KEY || (!local && !env.MAPI_GATE_KEY)) {
      return new Response(null, { status: 503, headers: NO_STORE });
    }
    if (env.MAPI_GATE_KEY && !sameKey(request.headers.get("x-mapi-test-key"), env.MAPI_GATE_KEY)) {
      return new Response(null, { status: 404, headers: NO_STORE });
    }
    const project = env.NEXTGEN_PROJECT.getByName(fixture.projectId);
    if (request.method === "GET" && url.pathname === "/_mapi/probe") {
      return Response.json(await project.probe(), { headers: NO_STORE });
    }
    if (local && env.MAPI_LOCAL_TEST === "1" && request.method === "POST" && url.pathname === "/_mapi/test") {
      const { command, id } = await request.json();
      return Response.json(await project.test(command, id), { headers: NO_STORE });
    }
    if (!isAuthRoute(request.method, url.pathname)) {
      return new Response(null, { status: 404, headers: NO_STORE });
    }

    // This PoC accepts only small JSON request bodies. Bound the body even
    // when the client omits Content-Length.
    let buffer = new Uint8Array();
    if (request.body) {
      const reader = request.body.getReader();
      const chunks = [];
      let length = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 65_536) {
          await reader.cancel();
          return new Response(null, { status: 413, headers: NO_STORE });
        }
        chunks.push(value);
      }
      buffer = new Uint8Array(length);
      let offset = 0;
      for (const value of chunks) {
        buffer.set(value, offset);
        offset += value.length;
      }
    }

    const headers = {};
    for (const name of ["accept", "authorization", "content-type", "cookie", "idempotency-key",
      "origin", "referer", "user-agent", "x-zitadel-csrf"]) {
      if (request.headers.has(name)) headers[name] = [request.headers.get(name)];
    }
    const result = await project.handleRequest({
      method: request.method, url: request.url, headers, body: buffer.toBase64(),
      peer: request.headers.get("cf-connecting-ip") ?? "127.0.0.1",
    });
    const outgoing = new Headers(NO_STORE);
    for (const [name, values] of Object.entries(result.headers)) {
      for (const value of values) outgoing.append(name, value);
    }
    outgoing.set("cache-control", "no-store");
    return new Response(result.body ? Uint8Array.fromBase64(result.body) : null,
      { status: result.status, headers: outgoing });
  },
};
