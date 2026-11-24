import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("@zitadel/components/package.json");
const metadata = JSON.parse(await readFile(packagePath, "utf8"));
if (metadata.version !== "0.7.0") throw new Error("Expected @zitadel/components version 0.7.0");

const destination = resolve("worker/assets");
await mkdir(destination, { recursive: true });
const source = resolve(dirname(packagePath), "dist/standalone.mjs");
const asset = resolve(destination, "zitadel-login.mjs");
if (process.env.MAPI_MINIFY_LOGIN === "1") {
  const { transform } = await import("esbuild");
  const original = await readFile(source, "utf8");
  const result = await transform(original, { minify: true, keepNames: true, format: "esm", target: "esnext", legalComments: "inline" });
  await writeFile(asset, result.code);
  console.log(`Prepared the pinned minified login asset (${Buffer.byteLength(result.code)} bytes).`);
} else {
  await copyFile(source, asset);
  console.log("Prepared the pinned Nextgen login component asset.");
}
