import { mkdtemp, mkdir, readFile, readdir, rm, cp } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { startLocalZitadel } from "@zitadel/testing";

// Run the pinned native server and a separate RP/provider test in an isolated
// temporary checkout. Generated keys, credentials and SQLite files stay there.
const temp = await mkdtemp(resolve(tmpdir(), "mapi-native-flow-release-"));
let server;
try {
  const checkout = resolve(temp, "nextgen");
  await mkdir(checkout);
  execFileSync("rsync", ["-a", "--exclude=.git", "--exclude=node_modules", `${resolve(".mapi/nextgen")}/`, `${checkout}/`], { stdio: "inherit" });
  await cp(resolve("upstream/overlay/apps/api/internal/mapiflowrelease"), resolve(checkout, "apps/api/internal/mapiflowrelease"), { recursive: true });
  await cp(resolve("upstream/overlay/apps/api/internal/api/mapi_flow_release.go"), resolve(checkout, "apps/api/internal/api/mapi_flow_release.go"));
  await cp(resolve("upstream/overlay/apps/api/internal/storage/dialect/sqlite/mapi_native_e2e.go"), resolve(checkout, "apps/api/internal/storage/dialect/sqlite/mapi_native_e2e.go"));
  const data = resolve(temp, "server");
  await mkdir(data);
  server = await startLocalZitadel({ dir: data, projectName: "MaPi native OAuth test" });
  const user = await server.seedUser();
  const nativeData = resolve(data, ".zitadel/local/nextgen-data");
  const keyDir = resolve(nativeData, "master-keys");
  const names = await readdir(keyDir);
  if (names.length !== 1) throw new Error("Expected exactly one synthetic master key");
  const fixture = { ...server.handle, user, dbPath: resolve(nativeData, "zitadel.db"), key: { id: names[0], pem: await readFile(resolve(keyDir, names[0]), "utf8") } };
  const child = spawn("go", ["test", "-v", "-tags", "mapi_native_e2e,mapi_oauth", "-run", "^TestNativeFlowReleasePublishRollback$", "-count=1", "-timeout=120s", "./internal/mapiflowrelease"], {
    cwd: resolve(checkout, "apps/api"), stdio: "inherit", env: { ...process.env, GOWORK: "off", MAPI_NATIVE_OIDC_FIXTURE: JSON.stringify(fixture) },
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) throw new Error(`Native flow-release integration test failed (${signal ?? code})`);
} finally {
  if (server) await server.stop();
  await rm(temp, { recursive: true, force: true });
}
