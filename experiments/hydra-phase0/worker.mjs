import { connect } from "cloudflare:sockets";
import { WorkerEntrypoint } from "cloudflare:workers";
import "./wasm_exec.js";
import module from "./hydra-phase0.wasm";
import { runHydra } from "./runtime.mjs";
import { SessionFence } from "./session-fence.mjs";

let startupProbeID;
let startupProbeCalls = 0;

function sessionFence(env, session) {
  if (typeof session !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) {
    throw new Error("invalid private fence key");
  }
  return env.SPIKE_FENCES.getByName(session);
}

async function invoke(env, input, fence) {
  const { SPIKE_POSTGRES, SPIKE_ISSUER, SPIKE_SYSTEM_SECRET } = env;
  if (!SPIKE_POSTGRES || !SPIKE_ISSUER || !SPIKE_SYSTEM_SECRET) throw new Error("Hydra bindings unavailable");
  return runHydra({
    module,
    dsn: SPIKE_POSTGRES.connectionString,
    issuer: SPIKE_ISSUER,
    systemSecret: SPIKE_SYSTEM_SECRET,
    input,
    dial: (hostname, port) => connect({ hostname, port }),
    fence,
  });
}

async function command(env, body) {
  const result = await invoke(env, { method: "POST", path: "/phase0/fence", body: JSON.stringify(body) });
  if (result.status !== 200) throw new Error("private database command failed");
  return result.body;
}

export class HydraSessionFence extends SessionFence {
  hydra(body) {
    return command(this.env, body);
  }
}

// Only a named service binding can reach these entrypoints.
export class HydraPhase0 extends WorkerEntrypoint {
  startupProbe() {
    if (this.env.SPIKE_BARRIERS !== "true") throw new Error("staging fixtures are disabled");
    startupProbeID ??= crypto.randomUUID();
    const result = { isolate: startupProbeID, call: ++startupProbeCalls };
    console.log(JSON.stringify({ event: "mapi.hydra.phase0.startup-probe", ...result }));
    return JSON.stringify(result);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!["/.well-known/openid-configuration", "/.well-known/jwks.json", "/oauth2/auth", "/oauth2/token"].includes(url.pathname)) {
      return new Response(null, { status: 404 });
    }
    const body = request.method === "POST" ? await request.text() : "";
    if (body.length > 16_384) return new Response(null, { status: 413 });
    const headers = Object.fromEntries([...request.headers].map(([name, value]) => [name, [value]]));
    const attempts = new Map();
    const env = this.env;

    try {
      const result = await invoke(env, { method: request.method, path: url.pathname + url.search, headers, body }, {
        async admit(session, grant) {
          if (session.startsWith("sess_") && (!env.NEXTGEN || !await env.NEXTGEN.verify(session))) return null;
          const id = crypto.randomUUID();
          const fence = sessionFence(env, session);
          const admitted = await fence.admit(grant, id);
          if (!admitted) return null;
          attempts.set(id, admitted.epoch);
          return id;
        },
        async release(session, id) {
          const fence = sessionFence(env, session);
          if (!await fence.settle(id, "committed")) return false;
          return fence.release(id, attempts.get(id));
        },
        async checkpoint(session, phase) {
          if (env.SPIKE_BARRIERS !== "true") return;
          const fence = sessionFence(env, session);
          let state = await fence.barrier(phase, "arrive");
          const deadline = Date.now() + 15_000;
          while (state === "arrived" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 60));
            state = await fence.barrier(phase, "read");
          }
          if (state !== "pass") throw new Error("staging barrier interrupted processing");
          return phase === "before_commit" && await fence.barrier("drop_ack", "read") === "armed";
        },
      });
      const responseHeaders = new Headers();
      for (const [name, values] of Object.entries(result.headers || {})) {
        for (const value of values) responseHeaders.append(name, value);
      }
      responseHeaders.set("Cache-Control", "no-store");
      return new Response(result.body, { status: result.status, headers: responseHeaders });
    } catch {
      return new Response("Hydra probe unavailable", { status: 503 });
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
    if (allowed.get(url.pathname) !== method || typeof body !== "string" || body.length > 16384) {
      throw new Error("invalid private Hydra admin request");
    }
    return invoke(this.env, {
      method, path: url.pathname + url.search, body,
      headers: { "Content-Type": ["application/json"] },
    });
  }

  async bindCode(session, code) {
    if (!this.env.NEXTGEN || !await this.env.NEXTGEN.verify(session)) throw new Error("session unavailable");
    const result = await invoke(this.env, {
      method: "POST", path: "/phase0/code", body: JSON.stringify({ session, code }), headers: {},
    });
    if (result.status !== 200 || !await sessionFence(this.env, session).linkGrant(result.body)) {
      throw new Error("authorization grant binding failed");
    }
    return true;
  }

  // Test-only protected resource check. Hydra validates the bearer token and
  // supplies the trusted grant's session; Nextgen and the fence supply live state.
  async authorizeAccess(token) {
    if (this.env.SPIKE_BARRIERS !== "true" || typeof token !== "string" || token.length > 8192) return false;
    try {
      const result = await invoke(this.env, { method: "POST", path: "/phase0/access", body: JSON.stringify({ token }), headers: {} });
      if (result.status !== 200 || !result.body.startsWith("sess_") || !this.env.NEXTGEN) return false;
      if (!await this.env.NEXTGEN.verify(result.body)) return false;
      return !(await sessionFence(this.env, result.body).state()).closed;
    } catch {
      return false;
    }
  }

  async fixture({ action, session, grant, phase, state, loseAck, trace }) {
    if (this.env.SPIKE_BARRIERS !== "true") throw new Error("staging fixtures are disabled");
    const traceID = typeof trace === "string" && /^[0-9a-f-]{36}$/.test(trace) ? trace : null;
    console.log(JSON.stringify({ event: "mapi.hydra.phase0.fixture", action, phase: phase ?? null, state: state ?? null, trace: traceID }));
    const fence = sessionFence(this.env, session);
    switch (action) {
      case "link":
        if (!await fence.linkGrant(grant)) return false;
        return await command(this.env, { action: "link", session, grant }) === "linked";
      case "close":
        return fence.close(session, loseAck === true);
      case "barrier":
        {
          const result = await fence.barrier(phase, state);
          console.log(JSON.stringify({ event: "mapi.hydra.phase0.fixture-return", action, trace: traceID }));
          return result;
        }
      case "evidence":
        {
          const result = await fence.evidence();
          console.log(JSON.stringify({ event: "mapi.hydra.phase0.fixture-return", action }));
          return JSON.stringify(result);
        }
      case "restart":
        return fence.restart();
      default:
        throw new Error("unknown staging fixture action");
    }
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
