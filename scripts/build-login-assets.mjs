import { createRequire } from "node:module";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("@zitadel/components/package.json");
const metadata = JSON.parse(await readFile(packagePath, "utf8"));
if (metadata.version !== "0.7.0") throw new Error("Expected @zitadel/components version 0.7.0");

const destination = resolve("worker/assets");
await mkdir(destination, { recursive: true });
await copyFile(resolve(dirname(packagePath), "dist/standalone.mjs"), resolve(destination, "zitadel-login.mjs"));
console.log("Prepared the pinned Nextgen login component asset.");
