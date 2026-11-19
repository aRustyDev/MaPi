import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const masterKey = await readFile(".mapi/runtime-key.json");
await writeFile(".mapi/staging-secrets.json", JSON.stringify({
  MAPI_MASTER_KEY: masterKey.toString("base64"),
  MAPI_GATE_KEY: randomBytes(32).toString("base64url"),
}), { mode: 0o600 });
console.log("Staging secrets saved to .mapi/staging-secrets.json.");
