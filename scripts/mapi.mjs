#!/usr/bin/env node
import { stdin, stderr } from "node:process";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const url = process.env.MAPI_URL;
const token = process.env.MAPI_OPERATOR_TOKEN;
if (!url || !token) throw new Error("Set MAPI_URL and MAPI_OPERATOR_TOKEN");
const base = new URL(url);
if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) {
  throw new Error("MAPI_URL must use HTTPS or loopback HTTP");
}

function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
  return args[index + 1];
}

async function password() {
  if (!stdin.isTTY) {
    let value = "";
    for await (const chunk of stdin) value += chunk;
    return value.replace(/\r?\n$/, "");
  }
  stderr.write("Password: ");
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    for await (const chunk of stdin) {
      for (const ch of chunk.toString()) {
        if (ch === "\u0003") throw new Error("Cancelled");
        if (ch === "\r" || ch === "\n") return value;
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    }
    return value;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stderr.write("\n");
  }
}

async function configurationDocument() {
  const file = option("--file");
  let text;
  if (file === "-") {
    const chunks = [];
    let length = 0;
    for await (const chunk of stdin) {
      length += chunk.length;
      if (length > 65_536) throw new Error("Configuration document exceeds 65536 bytes");
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    const bytes = await readFile(file);
    if (bytes.length > 65_536) throw new Error("Configuration document exceeds 65536 bytes");
    text = bytes.toString("utf8");
  }
  let document;
  try { document = JSON.parse(text); }
  catch { throw new Error("Configuration document is invalid JSON"); }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Configuration document must be a JSON object");
  if (Buffer.byteLength(JSON.stringify({ document })) > 65_536) throw new Error("Configuration request exceeds 65536 bytes");
  return document;
}

let path, body;
let oneTimeSecrets = false;
if (args[0] !== "admin") throw new Error("Use mapi admin init, status, user add, or oidc");
if (args[1] === "status") path = "/_mapi/admin/status";
else if (args[1] === "bookmark") path = "/_mapi/admin/bookmark";
else if (args[1] === "restore") { path = "/_mapi/admin/restore"; body = { bookmark: option("--bookmark") }; }
else if (args[1] === "recover") { path = "/_mapi/admin/recover"; body = {}; }
else if (args[1] === "oidc" && args[2] === "init") { path = "/_mapi/admin/oidc/init"; body = {}; }
else if (args[1] === "oidc" && args[2] === "rotate") { path = "/_mapi/admin/oidc/rotate"; body = {}; }
else if (args[1] === "oidc" && args[2] === "flow" && args[3] === "status") { path = "/_mapi/admin/oidc/flow/status"; body = {}; }
else if (args[1] === "oidc" && args[2] === "flow" && args[3] === "publish") {
  path = "/_mapi/admin/oidc/flow/publish";
  body = { document: await configurationDocument(), expectedDeploymentId: option("--expected-deployment") };
} else if (args[1] === "oidc" && args[2] === "flow" && args[3] === "rollback") {
  path = "/_mapi/admin/oidc/flow/rollback";
  body = { targetDeploymentId: option("--target-deployment"), expectedDeploymentId: option("--expected-deployment") };
}
else if (args[1] === "oidc" && args[2] === "client-secret" && ["rotate", "revoke"].includes(args[3])) {
  path = `/_mapi/admin/oidc/client-secret/${args[3]}`;
  body = { clientId: option("--client-id") };
  oneTimeSecrets = args[3] === "rotate";
}
else if (args[1] === "oidc" && args[2] === "client" && args[3] === "add") {
  path = "/_mapi/admin/oidc/clients";
  body = { document: await configurationDocument() };
  if (Array.isArray(body.document.clients) && body.document.clients.some((client) => !client?.client_id)) {
    stderr.write("Specify and record each client_id before registration to recover if the response is lost.\n");
  }
  oneTimeSecrets = true;
} else if (args[1] === "oidc" && args[2] === "logout-uri" && args[3] === "add") {
  path = "/_mapi/admin/oidc/logout-uri";
  body = { clientId: option("--client-id"), logoutUri: option("--uri") };
}
else if (args[1] === "init") {
  path = "/_mapi/admin/init";
  body = { name: option("--name") };
} else if (args[1] === "project" && args[2] === "add") {
  path = "/_mapi/admin/projects";
  body = { name: option("--name"), origin: option("--origin") };
} else if (args[1] === "user" && args[2] === "add") {
  path = "/_mapi/admin/users";
  body = { email: option("--email"), password: await password() };
} else throw new Error("Use mapi admin init, status, user add, or oidc");

const requestBody = body ? JSON.stringify(body) : undefined;
if (requestBody && Buffer.byteLength(requestBody) > 65_536) throw new Error("Operator request exceeds 65536 bytes");

const response = await fetch(new URL(path, base), {
  method: body ? "POST" : "GET",
  headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
  body: requestBody,
  redirect: "error",
});
if (body?.password) body.password = "";
if (!response.ok) throw new Error(`Operator request failed with HTTP ${response.status}`);
if (oneTimeSecrets) stderr.write("Client secrets are shown once; store them securely.\n");
if (response.status === 204 || response.status === 202) console.log(JSON.stringify({ status: response.status }));
else console.log(JSON.stringify(await response.json()));
