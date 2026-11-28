import { connect } from "cloudflare:sockets";
import { WorkerEntrypoint } from "cloudflare:workers";
import "./generated/hydra-wasm-exec.js";
import module from "./generated/hydra.wasm";
import { readBoundedBody } from "./request-body.js";
import { runHydra } from "../experiments/hydra-phase0/runtime.mjs";
import { SessionFence } from "../experiments/hydra-phase0/session-fence.mjs";

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const noStore = { "cache-control": "no-store" };

function validIdentity(identity, issuer) {
  return identity && typeof issuer === "string" && identity.issuer === issuer &&
    typeof identity.projectId === "string" && typeof identity.userId === "string" && typeof identity.sessionId === "string" &&
    idPattern.test(identity.projectId) && idPattern.test(identity.userId) && idPattern.test(identity.sessionId);
}

function fenceFor(env, identity) {
  if (!validIdentity(identity, env.HYDRA_ISSUER)) throw new Error("invalid grant identity");
  return env.HYDRA_FENCES.getByName(JSON.stringify([identity.projectId, identity.sessionId]));
}

async function invoke(env, input, fence) {
  if (!env.HYDRA_DATABASE || !env.HYDRA_ISSUER || !env.HYDRA_SYSTEM_SECRET) throw new Error("Hydra bindings unavailable");
  return runHydra({
    module, input, fence, verifiedBindings: true,
    dsn: env.HYDRA_DATABASE.connectionString,
    issuer: env.HYDRA_ISSUER,
    systemSecret: env.HYDRA_SYSTEM_SECRET,
    dial: (hostname, port) => connect({ hostname, port }),
  });
}

async function command(env, body) {
  const result = await invoke(env, { method: "POST", path: "/phase0/fence", body: JSON.stringify(body) });
  if (result.status !== 200) throw new Error("Hydra cleanup unavailable");
  return result.body;
}

export class HydraSessionFence extends SessionFence {
  hydra(body) {
    return command(this.env, body);
  }
}

// Only a service binding can invoke these methods.
export class HydraIssuer extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const allowed = new Map([
      ["/.well-known/openid-configuration", "GET"],
      ["/.well-known/jwks.json", "GET"],
      ["/oauth2/auth", "GET"],
      ["/oauth2/token", "POST"],
    ]);
    if (allowed.get(url.pathname) !== request.method || url.search.length > 8192) return new Response(null, { status: 404, headers: noStore });
    try {
      const bytes = await readBoundedBody(request, 16384);
      if (bytes === null) return new Response(null, { status: 413, headers: noStore });
      const body = new TextDecoder().decode(bytes);
      if (url.pathname === "/oauth2/token") {
        const types = new URLSearchParams(body).getAll("grant_type");
        // This integration has a live session binding only for these grants.
        if (types.length !== 1 || !["authorization_code", "refresh_token"].includes(types[0])) {
          return Response.json({ error: "unsupported_grant_type" }, { status: 400, headers: noStore });
        }
      }
      const headers = {};
      for (const name of ["accept", "authorization", "content-type", "cookie", "user-agent"]) {
        if (request.headers.has(name)) headers[name] = [request.headers.get(name)];
      }
      const attempts = new Map();
      const env = this.env;
      const result = await invoke(env, {
        method: request.method, path: url.pathname + url.search, headers, body,
      }, {
        async admit(identity, grant) {
          if (!validIdentity(identity, env.HYDRA_ISSUER) || typeof grant !== "string" || !idPattern.test(grant) ||
              await env.HYDRA_SESSION_AUTHORITY.verify(identity) !== true) return null;
          const id = crypto.randomUUID();
          const admitted = await fenceFor(env, identity).admit(grant, id);
          if (!admitted) return null;
          attempts.set(id, admitted.epoch);
          return id;
        },
        async release(identity, id) {
          if (!attempts.has(id)) return false;
          const fence = fenceFor(env, identity);
          if (!await fence.settle(id, "committed")) return false;
          if (await env.HYDRA_SESSION_AUTHORITY.verify(identity) !== true) {
            await fence.close(identity.sessionId);
            return false;
          }
          return fence.release(id, attempts.get(id));
        },
      });
      const outgoing = new Headers(noStore);
      for (const [name, values] of Object.entries(result.headers || {})) {
        if (["content-type", "location", "set-cookie", "www-authenticate"].includes(name.toLowerCase())) {
          for (const value of values) outgoing.append(name, value);
        }
      }
      outgoing.set("cache-control", "no-store");
      return new Response(result.body, { status: result.status, headers: outgoing });
    } catch {
      return new Response(null, { status: 503, headers: noStore });
    }
  }

  async admin(method, path, body = "") {
    const url = new URL(path, "https://private.invalid");
    const allowed = new Map([
      ["/admin/oauth2/auth/requests/login", "GET"],
      ["/admin/oauth2/auth/requests/login/accept", "PUT"],
      ["/admin/oauth2/auth/requests/consent", "GET"],
      ["/admin/oauth2/auth/requests/consent/accept", "PUT"],
    ]);
    if (allowed.get(url.pathname) !== method || typeof body !== "string" || body.length > 16384 || url.search.length > 8192) {
      throw new Error("invalid Hydra challenge request");
    }
    return invoke(this.env, { method, path: url.pathname + url.search, body, headers: { "Content-Type": ["application/json"] } });
  }

  async bindCode(identity, code) {
    if (!validIdentity(identity, this.env.HYDRA_ISSUER) || typeof code !== "string" || code.length > 4096 ||
        await this.env.HYDRA_SESSION_AUTHORITY.verify(identity) !== true) throw new Error("session unavailable");
    const result = await invoke(this.env, {
      method: "POST", path: "/mapi/bind-code", body: JSON.stringify({ ...identity, code }),
    });
    if (result.status !== 200 || typeof result.body !== "string" || !idPattern.test(result.body) ||
        !await fenceFor(this.env, identity).linkGrant(result.body)) throw new Error("grant binding unavailable");
    return true;
  }

  async closeSession(identity) {
    if (!validIdentity(identity, this.env.HYDRA_ISSUER) ||
        await this.env.HYDRA_SESSION_AUTHORITY.verify(identity) !== true) throw new Error("session unavailable");
    return fenceFor(this.env, identity).close(identity.sessionId);
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404, headers: noStore });
  },
};
