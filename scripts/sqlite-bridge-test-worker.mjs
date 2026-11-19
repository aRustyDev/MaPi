import { DurableObject } from "cloudflare:workers";
import wasm from "../worker/generated/sqlite-bridge-test.wasm";
import { instantiateReactor } from "../worker/wasi.js";
import { execute, sqliteError } from "../worker/sql.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const rejected = Symbol("Go transaction failed");

export class BridgeTest extends DurableObject {
  run() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_rows_written_probe (a TEXT, b TEXT, PRIMARY KEY (a, b))");
    this.ctx.storage.sql.exec("DELETE FROM mapi_rows_written_probe");
    const write = this.ctx.storage.sql.exec("INSERT INTO mapi_rows_written_probe VALUES ('a', 'b')");
    write.toArray();
    const written = write.rowsWritten;
    const changes = this.ctx.storage.sql.exec("SELECT changes() AS count").one().count;
    let reactor;
    let output;
    let memory;
    reactor = instantiateReactor(wasm, (getMemory) => {
      memory = getMemory;
      return {
        sql: (pointer, size) => {
          const query = JSON.parse(decoder.decode(new Uint8Array(memory(), pointer, size)));
          let result;
          try { result = execute(this.ctx.storage, query); }
          catch (error) { result = { error: sqliteError(error) }; }
          output = encoder.encode(JSON.stringify(result));
          return output.length;
        },
        result: (pointer, size) => {
          new Uint8Array(memory(), pointer, size).set(output);
          output = undefined;
        },
        transaction: () => {
          try {
            this.ctx.storage.transactionSync(() => {
              if (reactor.mapi_transaction_body() !== 0) throw rejected;
            });
            return 0;
          } catch (error) {
            if (error === rejected) return 1;
            return 2;
          }
        },
      };
    });
    const packed = reactor.run_bridge_tests();
    const pointer = Number(packed >> 32n);
    const length = Number(packed & 0xffffffffn);
    return { ...JSON.parse(decoder.decode(new Uint8Array(memory(), pointer, length))), written, changes };
  }
}

export default {
  async fetch(_request, env) {
    return Response.json(await env.BRIDGE_TEST.getByName("bridge-test").run());
  },
};
