#!/usr/bin/env node
import { stdin, stderr } from "node:process";

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

let path, body;
if (args[0] !== "admin") throw new Error("Use mapi admin init, status, or user add");
if (args[1] === "status") path = "/_mapi/admin/status";
else if (args[1] === "bookmark") path = "/_mapi/admin/bookmark";
else if (args[1] === "restore") { path = "/_mapi/admin/restore"; body = { bookmark: option("--bookmark") }; }
else if (args[1] === "recover") { path = "/_mapi/admin/recover"; body = {}; }
else if (args[1] === "init") {
  path = "/_mapi/admin/init";
  body = { name: option("--name") };
} else if (args[1] === "project" && args[2] === "add") {
  path = "/_mapi/admin/projects";
  body = { name: option("--name"), origin: option("--origin") };
} else if (args[1] === "user" && args[2] === "add") {
  path = "/_mapi/admin/users";
  body = { email: option("--email"), password: await password() };
} else throw new Error("Use mapi admin init, status, or user add");

const response = await fetch(new URL(path, base), {
  method: body ? "POST" : "GET",
  headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : undefined,
  redirect: "error",
});
if (body?.password) body.password = "";
if (!response.ok) throw new Error(`Operator request failed with HTTP ${response.status}`);
if (response.status === 204 || response.status === 202) console.log(JSON.stringify({ status: response.status }));
else console.log(JSON.stringify(await response.json()));
