import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((done, reject) => socket.close((error) => error ? reject(error) : done()));
  return port;
}

const directory = await mkdtemp(resolve(tmpdir(), "mapi-dpop-"));
const environment = resolve(directory, "empty.env");
await writeFile(environment, "");
const port = await freePort();
const inspectorPort = await freePort();
const server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", "scripts/dpop-spike.wrangler.jsonc", "--env-file", environment, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", directory], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"), WRANGLER_SEND_METRICS: "false" },
});
let diagnostic = "";
server.stdout.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-16000); });
server.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-16000); });
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error("Wrangler exited before readiness");
    try { response = await fetch(`http://127.0.0.1:${port}/`); break; }
    catch { await setTimeout(200); }
  }
  if (!response) throw new Error("Wrangler did not become ready");
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.ok, true, result.error);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const protectedHeader = b64({typ:'dpop+jwt',alg:'ES256',jwk:publicKey.export({format:'jwk'})});
  const payload = b64({jti:'concurrent-proof',htm:'POST',htu:'https://issuer.test/token',iat:1700000000,nonce:'server-nonce'});
  const signingInput = `${protectedHeader}.${payload}`;
  const proof = `${signingInput}.${sign('sha256',Buffer.from(signingInput),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
  const submit = async projectId => (await fetch(`http://127.0.0.1:${port}/verify`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({proof,projectId})})).json();
  const raced = await Promise.all(Array.from({length:10},()=>submit('proj_race')));
  assert.equal(raced.filter(r=>r.status==='ok').length,1);
  assert.equal(raced.filter(r=>r.status==='invalid').length,9);
  assert.equal((await submit('proj_other')).status,'ok');
  const counts = await (await fetch(`http://127.0.0.1:${port}/counts`)).json(); assert.deepEqual(counts, { nonce:1, audit:1 });
  assert.equal((await fetch(`http://127.0.0.1:${port}/evict`)).status,500);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/counts`)).json(), counts);
  assert.equal((await submit('proj_race')).status,'invalid');
  console.log("DPoP and nonce issuance, concurrent replay, expiry, eviction, project isolation and audit rollback passed in workerd.");
} catch (error) {
  if (diagnostic) console.error(diagnostic);
  throw error;
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
