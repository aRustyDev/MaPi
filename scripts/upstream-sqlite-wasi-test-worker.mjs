// Test-only WASI command runner for the pinned upstream stmttest package.
import { DurableObject } from 'cloudflare:workers';
import { isLocalSQLiteTestRequest } from './upstream-sqlite-local-guard.mjs';
import wasm from '../worker/generated/upstream-sqlite-stmttest.wasm';
import baseline from '../worker/generated/baseline.json';
import { execute, sqliteHost } from '../worker/sql.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const transactionRejected = Symbol('transaction rejected');
const processExited = Symbol('process exited');

export class UpstreamSQLiteTest extends DurableObject {
  run(testName, frozenClock = false) {
    if (!/^Test[A-Za-z0-9_]+$/.test(testName)) throw new Error('Invalid test name');
    this.ctx.storage.sql.exec('PRAGMA case_sensitive_like = ON');
    if (!this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").toArray().length) {
      this.ctx.storage.transactionSync(() => {
        for (const statement of baseline.statements) this.ctx.storage.sql.exec(statement);
      });
    }
    let instance;
    let exitCode;
    let logs = '';
    let advancedNanos = 0n;
    let timerPolls = 0;
    const initialTime = frozenClock ? (this.testFrozenTime ??= Date.now()) : Date.now();
    let wallClockReads = 0;
    let expiryWindowBegin;
    let expiryWindowEnd;
    let firstWallClock;
    let lastWallClock;
    const memory = () => instance.exports.memory.buffer;
    const view = () => new DataView(memory());
    const args = ['stmttest', '-test.v', '-test.parallel=1', '-test.timeout=0', `-test.run=^${testName}$`]
      .map((arg) => encoder.encode(`${arg}\0`));
    const wasi = {
      args_sizes_get(count, size) {
        view().setUint32(count, args.length, true);
        view().setUint32(size, args.reduce((total, arg) => total + arg.length, 0), true);
        return 0;
      },
      args_get(array, buffer) {
        for (let index = 0; index < args.length; index++) {
          view().setUint32(array + index * 4, buffer, true);
          new Uint8Array(memory(), buffer, args[index].length).set(args[index]);
          buffer += args[index].length;
        }
        return 0;
      },
      environ_sizes_get(count, size) { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0; },
      environ_get() { return 0; },
      sched_yield() { return 0; },
      proc_exit(code) { exitCode = code; throw processExited; },
      clock_time_get(_id, _precision, result) {
        const now = frozenClock ? initialTime : Date.now();
        if (firstWallClock === undefined) firstWallClock = now;
        lastWallClock = now;
        wallClockReads++;
        view().setBigUint64(result, BigInt(now) * 1_000_000n + advancedNanos, true);
        return 0;
      },
      random_get(pointer, length) {
        for (let offset = 0; offset < length; offset += 65_536) {
          crypto.getRandomValues(new Uint8Array(memory(), pointer + offset, Math.min(65_536, length - offset)));
        }
        return 0;
      },
      // workerd cannot block inside a synchronous host import. Advance a
      // test-only clock on WASI timer polls and report every such use.
      poll_oneoff(subscription, events, count, ready) {
        const data = view();
        if (count !== 1 || data.getUint8(subscription + 8) !== 0 || data.getUint16(subscription + 40, true) !== 0) return 52;
        const delay = data.getBigUint64(subscription + 24, true);
        if (delay) { advancedNanos += delay; timerPolls++; }
        new Uint8Array(memory(), events, 32).fill(0);
        data.setBigUint64(events, data.getBigUint64(subscription, true), true);
        data.setUint32(ready, 1, true);
        return 0;
      },
      fd_write(fd, vectors, count, written) {
        if (fd !== 1 && fd !== 2) return 8;
        let total = 0;
        for (let index = 0; index < count; index++) {
          const pointer = view().getUint32(vectors + index * 8, true);
          const size = view().getUint32(vectors + index * 8 + 4, true);
          const text = decoder.decode(new Uint8Array(memory(), pointer, size));
          if (text.includes('MAPI_EXPIRY_WINDOW_BEGIN')) expiryWindowBegin = performance.now();
          if (text.includes('MAPI_EXPIRY_WINDOW_END')) expiryWindowEnd = performance.now();
          if (logs.length < 2_000_000) logs += text;
          total += size;
        }
        view().setUint32(written, total, true);
        return 0;
      },
      fd_fdstat_get(fd, result) {
        if (fd > 2) return 8;
        new Uint8Array(memory(), result, 24).fill(0);
        view().setUint8(result, 2);
        return 0;
      },
      fd_close() { return 8; },
      fd_prestat_get() { return 8; },
    };
    for (const entry of WebAssembly.Module.imports(wasm)) {
      if (entry.module === 'wasi_snapshot_preview1' && !(entry.name in wasi)) wasi[entry.name] = () => 52;
    }
    const storage = this.ctx.storage;
    const host = {
      ...sqliteHost(memory, (pointer, size) => instance.exports.mapi_sql_frame(pointer, size),
        (query, resultSink) => execute(storage, query, resultSink)),
      transaction() {
        try {
          storage.transactionSync(() => {
            if (instance.exports.mapi_transaction_body() !== 0) throw transactionRejected;
          });
          return 0;
        } catch (error) { return error === transactionRejected ? 1 : 2; }
      },
    };
    instance = new WebAssembly.Instance(wasm, { wasi_snapshot_preview1: wasi, mapi: host });
    try { instance.exports._start(); } catch (error) { if (error !== processExited) throw error; }
    return { exitCode, logs, timerPolls, wallClockReads, firstWallClock, lastWallClock, frozenClock, expiryWindowMs: expiryWindowEnd - expiryWindowBegin };
  }
}

export default {
  async fetch(request, env) {
    if (!isLocalSQLiteTestRequest(request, env)) return new Response(null, { status: 404 });
    const testName = new URL(request.url).searchParams.get('test');
    const shared = new URL(request.url).searchParams.get('shared');
    if (shared && !/^[a-z0-9-]+$/.test(shared)) throw new Error('Invalid shared object');
    return Response.json(await env.TEST.getByName(shared || crypto.randomUUID()).run(testName, new URL(request.url).searchParams.get('clock') === 'frozen'));
  },
};
