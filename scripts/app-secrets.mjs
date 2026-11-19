import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

await mkdir(".mapi", { recursive: true, mode: 0o700 });
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 4096,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = { id: "master-key.pem", pem: privateKey };
const secrets = {
  MAPI_MASTER_KEY: Buffer.from(JSON.stringify(key)).toString("base64"),
  MAPI_OPERATOR_TOKEN: randomBytes(32).toString("base64url"),
};
if (process.argv.includes("--local")) {
  const lines = Object.entries({ ...secrets, MAPI_APP_ORIGIN: "http://localhost:8787", MAPI_LOCAL_TEST: "1" })
    .map(([name, value]) => `${name}=${value}`).join("\n") + "\n";
  await writeFile(".dev.vars.app", lines, { mode: 0o600, flag: "wx" });
  console.log("Created .dev.vars.app for local development.");
} else {
  const path = process.argv.includes("--oidc-staging") ? ".mapi/oidc-staging-secrets.json" : ".mapi/app-staging-secrets.json";
  await writeFile(path, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
  console.log(`Created ${path}. Keep a secure backup of this file.`);
}
