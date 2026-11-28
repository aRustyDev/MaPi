const requests = globalThis.mapiHydraRequests ??= new Map();
let isolateId;
let isolateInvocation = 0;

export async function runHydra({ module, input, dsn, issuer, systemSecret, dial, fence }) {
  isolateId ??= crypto.randomUUID();
  const invocation = ++isolateInvocation;
  const grantType = input.path.split("?")[0] === "/oauth2/token"
    ? new URLSearchParams(input.body).get("grant_type") : null;
  const key = crypto.randomUUID();
  const closeSockets = new Set();
  const started = performance.now();
  let instance;
  let peakWasmBytes = 0;
  let socketReads = 0;
  let socketWrites = 0;
  let completed = false;
  const sampleMemory = () => {
    peakWasmBytes = Math.max(peakWasmBytes, instance?.exports.mem?.buffer.byteLength ?? 0);
  };
  const target = new URL(dsn);
  const hostname = target.hostname;
  const port = target.port || "5432";
  const host = {
    request: JSON.stringify(input),
    dsn,
    issuer,
    systemSecret,
    sqlOperations: 0,
    pgConnections: 0,
    pgSync: 0,
    pgSimpleQuery: 0,
    pgReady: 0,
    admit: fence?.admit ?? (async () => null),
    release: fence?.release ?? (async () => false),
    checkpoint: fence?.checkpoint ?? (async () => {}),
    async dial(requestedHost, requestedPort, timeout) {
      if (requestedHost !== hostname || requestedPort !== port) {
        throw new Error("Postgres target outside the selected binding");
      }
      const transport = dial(hostname, Number(port));
      let closed = false;
      function close() {
        if (closed) return;
        closed = true;
        closeSockets.delete(close);
        void Promise.resolve(transport.close()).catch(() => {});
      }
      closeSockets.add(close);
      await deadline(transport.opened, timeout, close);
      const reader = transport.readable.getReader();
      const writer = transport.writable.getWriter();
      return {
        read(timeoutMs) {
          sampleMemory();
          socketReads++;
          return deadline(reader.read(), timeoutMs, close);
        },
        write(bytes, timeoutMs) {
          sampleMemory();
          socketWrites++;
          return deadline(writer.write(bytes), timeoutMs, close);
        },
        close,
      };
    },
  };
  requests.set(key, host);
  try {
    const go = new globalThis.Go();
    let exitCode = 0;
    go.exit = (code) => {
      exitCode = code;
      // The pinned Go WASM shim can leave timers queued after main returns.
      for (const timer of go._scheduledTimeouts.values()) clearTimeout(timer);
      go._scheduledTimeouts.clear();
    };
    go.env = { MAPI_HYDRA_REQUEST: key };
    instance = await WebAssembly.instantiate(module, go.importObject);
    await go.run(instance);
    sampleMemory();
    if (host.failure) throw new Error(host.failure);
    if (exitCode !== 0 || !host.response) throw new Error("Hydra Wasm stopped without a response");
    completed = true;
    return JSON.parse(host.response);
  } finally {
    sampleMemory();
    console.log(JSON.stringify({
      event: "mapi.hydra.phase0.runtime",
      completed,
      isolateId,
      isolateInvocation: invocation,
      path: input.path.split("?")[0],
      grantType: ["authorization_code", "refresh_token", "client_credentials"].includes(grantType) ? grantType : null,
      elapsedMs: performance.now() - started,
      peakWasmBytes,
      socketReads,
      socketWrites,
      sqlOperations: host.sqlOperations,
      pgConnections: host.pgConnections,
      pgSync: host.pgSync,
      pgSimpleQuery: host.pgSimpleQuery,
      pgReady: host.pgReady,
    }));
    for (const close of closeSockets) close();
    requests.delete(key);
  }
}

async function deadline(work, timeout, close) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          close();
          reject(new Error("Postgres transport deadline elapsed"));
        }, Math.max(0, timeout));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
