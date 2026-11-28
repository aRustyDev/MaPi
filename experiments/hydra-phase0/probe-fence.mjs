import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const storage = await mkdtemp(join(tmpdir(), "mapi-hydra-fence-"));
const modules = await Promise.all(["fence-fixture.mjs", "session-fence.mjs"].map(async (path) => ({
  path,
  type: "ESModule",
  contents: await readFile(new URL(path, import.meta.url), "utf8"),
})));
let runtime;
function startRuntime() {
  runtime = new Miniflare(convertV4MiniflareOptions({
    host: "127.0.0.1",
    port: 0,
    telemetry: { enabled: false },
    resourcePersistencePath: storage,
    workers: [{
      name: "hydra-phase0-fence-local",
      compatibilityDate: "2026-11-25",
      durableObjects: { FENCE: { className: "SessionFence", useSQLite: true } },
      modules,
    }],
  }));
}

async function invoke(session, operation, ...args) {
  const result = await runtime.dispatchFetch("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session, operation, args }),
  });
  assert.equal(result.status, 200, operation);
  return result.json();
}

startRuntime();
try {
  const first = (...args) => invoke("first-session", ...args);
  const second = (...args) => invoke("second-session", ...args);
  await first("linkGrant", "grant_a");
  const { epoch } = await first("admit", "grant_a", "mint_a");
  assert.equal(await first("release", "mint_a", epoch), false, "receipt is required to release");
  assert.equal(await first("close"), epoch + 1);
  assert.equal(await first("admit", "grant_a", "mint_after_revoke"), null);
  assert.deepEqual(await first("cleanupStatus"), { state: "waiting", attempts: ["mint_a"] });

  await runtime.dispose();
  startRuntime();
  assert.deepEqual(await first("cleanupStatus"), { state: "waiting", attempts: ["mint_a"] });
  assert.equal(await first("confirmCleanup", epoch + 1, ["grant_a"]), false);
  await first("settle", "mint_a", "committed");
  assert.equal(await first("release", "mint_a", epoch), false, "a late commit cannot release");
  assert.deepEqual(await first("cleanupStatus"), { state: "ready", grants: ["grant_a"], epoch: epoch + 1 });
  assert.equal(await first("confirmCleanup", epoch + 1, ["grant_b"]), false);
  assert.equal(await first("confirmCleanup", epoch + 1, ["grant_a"]), true);
  assert.equal(await first("confirmCleanup", epoch + 1, ["grant_a"]), true, "duplicate ack is idempotent");
  assert.deepEqual(await first("cleanupStatus"), { state: "complete" });

  await second("linkGrant", "grant_b");
  const other = await second("admit", "grant_b", "mint_b");
  await second("settle", "mint_b", "committed");
  assert.equal(await second("release", "mint_b", other.epoch), true, "other session remained open");
  assert.equal(await second("release", "mint_b", other.epoch), false, "release is single-use");
  await second("close");
  assert.equal(await second("admit", "grant_b", "mint_c"), null);
  console.log("Local workerd fence passed late commit, release-first, restart, scoped retry and duplicate acknowledgment cases.");
} finally {
  await runtime.dispose();
  await rm(storage, { recursive: true, force: true });
}
