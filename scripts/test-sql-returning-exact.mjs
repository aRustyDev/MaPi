import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function freePort() { const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(done => server.close(done)); return port; }
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-sql-limits-'));
const variant = process.env.MAPI_SQL_RETURNING_EXACT_TEXT_NESTED === '1' ? 'exact-text-nested' : process.env.MAPI_SQL_RETURNING_EXACT_TEXT_TAG === '1' ? 'exact-text-tag' : process.env.MAPI_SQL_RETURNING_EXACT_TEXT === '1' ? 'exact-text' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8_FF === '1' ? 'exact-blob-repeat-tail8-ff' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8_ZERO === '1' ? 'exact-blob-repeat-tail8-zero' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8_WIDE_FF === '1' ? 'exact-blob-repeat-tail8-wide-ff' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8_WIDE_ZERO === '1' ? 'exact-blob-repeat-tail8-wide-zero' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8_WIDE64_FF === '1' ? 'exact-blob-repeat-tail8-wide64-ff' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8_WIDE64_ZERO === '1' ? 'exact-blob-repeat-tail8-wide64-zero' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8_WIDE66 === '1' ? 'exact-blob-repeat-tail8-wide66' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8_WIDE65 === '1' ? 'exact-blob-repeat-tail8-wide65' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8_WIDE64 === '1' ? 'exact-blob-repeat-tail8-wide64' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8_WIDE63 === '1' ? 'exact-blob-repeat-tail8-wide63' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8_WIDE === '1' ? 'exact-blob-repeat-tail8-wide' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL11 === '1' ? 'exact-blob-repeat-tail11' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL8 === '1' ? 'exact-blob-repeat-tail8' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL6 === '1' ? 'exact-blob-repeat-tail6' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL5 === '1' ? 'exact-blob-repeat-tail5' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL4 === '1' ? 'exact-blob-repeat-tail4' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL3 === '1' ? 'exact-blob-repeat-tail3' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL2 === '1' ? 'exact-blob-repeat-tail2' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_TAIL === '1' ? 'exact-blob-repeat-tail' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT_SAFE === '1' ? 'exact-blob-repeat-safe' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB_REPEAT === '1' ? 'exact-blob-repeat' : process.env.MAPI_SQL_RETURNING_EXACT_BLOB === '1' ? 'exact-blob' : process.env.MAPI_SQL_RETURNING_EXACT_MANY === '1' ? 'exact-many' : process.env.MAPI_SQL_RETURNING_EXACT_REAL === '1' ? 'exact-real' : process.env.MAPI_SQL_RETURNING_EXACT_INT64 === '1' ? 'exact64' : 'exact';
const envFile = resolve(directory, 'empty.env'); await writeFile(envFile, '');
const port = await freePort(), inspector = await freePort();
const server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/phase1-sql-limit-probe.wrangler.jsonc', '--env-file', envFile, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', directory], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('workerd exited before SQL limit test');
    try { response = await fetch(`http://127.0.0.1:${port}/?${variant}=1`, { signal: AbortSignal.timeout(60000) }); break; }
    catch (error) { if (error.name === 'TimeoutError') throw error; await setTimeout(200); }
  }
  if (!response) throw new Error('workerd did not start');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.directLength, variant.startsWith('exact-text') ? 8388636 : variant === 'exact-blob-repeat-tail8-wide66' || variant === 'exact-blob-repeat-tail8-wide65' || variant.startsWith('exact-blob-repeat-tail8-wide64') || variant === 'exact-blob-repeat-tail8-wide63' ? 8388566 : variant.startsWith('exact-blob-repeat-tail8-wide') ? 8388584 : variant === 'exact-blob-repeat-tail11' ? 8388632 : variant.startsWith('exact-blob-repeat-tail8') ? 8388629 : variant === 'exact-blob-repeat-tail6' ? 8388636 : variant === 'exact-blob-repeat-tail5' ? 8388635 : variant === 'exact-blob-repeat-tail4' ? 8388634 : variant === 'exact-blob-repeat-tail3' ? 8388633 : variant === 'exact-blob-repeat-tail2' ? 8388632 : variant === 'exact-blob-repeat-tail' ? 8388631 : variant === 'exact-blob-repeat-safe' ? 8000001 : variant.startsWith('exact-blob') ? 8388630 : 8388602);
  assert.equal(result.rows, 0); assert.equal(result.audit, 0);
  const fixture = variant.startsWith('exact-text') ? 'Synthetic tagged-TEXT' : variant.startsWith('exact-blob') ? 'Synthetic escaped-BLOB' : variant === 'exact-many' ? 'Synthetic multi-integer' : 'Pinned JSON-schema';
  assert.equal(result.ok, true, `${fixture} RETURNING should preserve the exact-size value; bridge error: ${result.error}`);
  console.log(`${fixture} RETURNING exact-size ${variant} result passed.`);
} finally {
  if (server.exitCode === null && server.signalCode === null) { const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped; }
  await rm(directory, { recursive: true, force: true });
}
