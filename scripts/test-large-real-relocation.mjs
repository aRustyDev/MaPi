// Local-only, real-Go project move combined with the representative bulk data.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectLocalMoveAfterTimeout } from './large-timeout-diagnostics.mjs';

const large = process.env.MAPI_LARGE_IMPORT === '1';
const timeoutRegression = process.env.MAPI_LOCAL_TIMEOUT_REGRESSION === '1';
if (large && timeoutRegression) throw Error('Timeout regression is limited to the small fixture');
const users = large ? 10_000 : 64;
const events = large ? 100_000 : 512;
async function port() { const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-large-real-move-'));
const address = await port(), inspector = await port(), envFile = resolve(dir, 'worker.env');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
await writeFile(envFile, `MAPI_MASTER_KEY=${Buffer.from(JSON.stringify({ id: 'master-test', pem: privateKey })).toString('base64')}\n`, { mode: 0o600 });
const server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/large-real-relocation-test.wrangler.jsonc', '--env-file', envFile, ...(timeoutRegression ? ['--var', 'MAPI_LOCAL_TIMEOUT_REGRESSION:1'] : []), '--ip', '127.0.0.1', '--port', String(address), '--inspector-port', String(inspector), '--persist-to', dir], { stdio: ['ignore', timeoutRegression ? 'pipe' : 'ignore', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
let diagnostic = '';
let acknowledgedAdvances = 0, lastAcknowledgedPhase = 'not-started';
let timeoutTestAttempts = 0;
for (const stream of [server.stdout, server.stderr]) stream?.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8000); });
async function call(action, body = {}, expectedFailure = false, timeoutMs = 120000) {
  const delayedAdvance = timeoutRegression && action === 'advance' && acknowledgedAdvances === 1;
  if (timeoutRegression && action === 'advance') console.error(JSON.stringify({ event: 'local.timeout.test.attempt', attempt: ++timeoutTestAttempts }));
  if (delayedAdvance) { body = { ...body, testDelayAfterAdvance: true }; timeoutMs = 3000; }
  const started = performance.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  let response, text;
  try {
    response = await fetch(`http://127.0.0.1:${address}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }), signal: timeout });
    text = await response.text();
  } catch (error) {
    const failure = Error(`${action}: local request failed (${error?.name ?? 'Error'}) after ${Math.round(performance.now() - started)} ms; acknowledged advances ${acknowledgedAdvances}, phase ${lastAcknowledgedPhase}`);
    failure.localAction = action; failure.localTimeout = timeout.aborted && timeout.reason?.name === 'TimeoutError';
    throw failure;
  }
  let value; try { value = JSON.parse(text); } catch { if (expectedFailure && response.status >= 500) return null; throw Error(`${action}: invalid response HTTP ${response.status}`); }
  if (expectedFailure) { assert.equal(response.status, 500, `Expected ${action} failure`); return value; }
  if (action === 'advance' && response.status === 500 && value.error === 'Error: Relocation cutover unavailable: independent archive proof is not configured') {
    return { phase: 'archive-blocked' };
  }
  assert.equal(response.status, 200, `${action}: ${value.error ?? response.status}`);
  if (action === 'advance') { acknowledgedAdvances++; lastAcknowledgedPhase = typeof value.phase === 'string' ? value.phase : 'unknown'; }
  if (timeoutRegression && action === 'advance') console.error(JSON.stringify({ event: 'local.timeout.test.ack', nextChunk: value.nextChunk }));
  return value;
}
let diagnosticFixture;
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error('Local workerd exited before readiness');
    try {
      const response = await fetch(`http://127.0.0.1:${address}/`, { method: 'POST', body: '{}' });
      if (response.status !== 503) break;
    } catch {}
    if (i === 99) throw Error('Local workerd did not start');
    await delay(200);
  }
  const startedSeed = performance.now();
  const fixture = await call('setup');
  const client = fixture.client;
  delete fixture.client; // Keep the synthetic secret out of coordinator calls.
  if (timeoutRegression) fixture.syntheticSentinel = 'LOCAL_TIMEOUT_TEST_SECRET_SENTINEL';
  diagnosticFixture = fixture;
  assert.notEqual(fixture.projectId, fixture.otherProject);
  for (let start = 0; start < users - 1; start += 128) await call('users', { ...fixture, start, count: Math.min(128, users - 1 - start) });
  for (let start = 0; start < events; start += 256) await call('events', { ...fixture, start, count: Math.min(256, events - start) });
  await call('domain', fixture);
  const bulkLogin = await call('bulkLogin', fixture);
  assert.equal(bulkLogin.status, 200, `Synthetic bulk credential failed before relocation: ${JSON.stringify(bulkLogin.diagnostics)}`);
  assert.equal(bulkLogin.sessionUserMatches, true, 'Synthetic bulk session resolved the wrong project or user');
  const sourceCounts = await call('counts', { ...fixture, name: 'large-source' });
  assert.equal(sourceCounts.projects, 1); assert.equal(sourceCounts.users, users); assert.equal(sourceCounts.user_passwords, users); assert.ok(sourceCounts.events >= events);
  const sourceBytesBefore = await call('databaseSize', { name: 'large-source' });
  const seedSeconds = (performance.now() - startedSeed) / 1000;
  const moveStarted = performance.now();
  let advances = 0;
  let progress = await call('advance', fixture); advances++;
  assert.equal(progress.phase, 'importing');
  const beforeExport = await call('exportStatus', fixture);
  const beforeImport = await call('importStatus', fixture);
  const diagnosticBaseline = await inspectLocalMoveAfterTimeout(action => call(action, fixture, false, 5000));
  assert.equal(diagnosticBaseline.observations[0].phase, 'moving');
  assert.equal(diagnosticBaseline.observations[1].nextChunk, beforeExport.next_chunk);
  assert.equal(diagnosticBaseline.observations[2].nextChunk, beforeImport.next_chunk);
  assert.equal(beforeExport.next_chunk, beforeImport.next_chunk);
  await call('failExport', { ...fixture, index: beforeExport.next_chunk }, true);
  assert.equal((await call('exportStatus', fixture)).next_chunk, beforeExport.next_chunk, 'Export advanced before digest finalization');
  await call('evictSource', fixture, true); await call('evictTarget', fixture, true);
  // Seek the next nonempty chunk without bypassing the production coordinator.
  for (;;) {
    const index = (await call('importStatus', fixture)).next_chunk;
    const part = await call('peek', { ...fixture, index });
    const payload = JSON.parse(part.content);
    if (payload.rows.length) {
      await call('corruptImport', { ...fixture, index }, true);
      await call('failImport', { ...fixture, index }, true);
      assert.equal((await call('importStatus', fixture)).next_chunk, index, 'Failed import advanced checkpoint');
      break;
    }
    progress = await call('advance', fixture); advances++;
    if (progress.phase !== 'importing') throw Error('No nonempty import chunk available for failure injection');
  }
  progress = await call('advance', fixture); advances++;
  const committed = (await call('importStatus', fixture)).next_chunk;
  await call('replayImport', { ...fixture, index: committed - 1 });
  assert.equal((await call('importStatus', fixture)).next_chunk, committed, 'Identical replay changed checkpoint');
  // Simulate loss of an acknowledgement: advance committed, then resume from
  // the destination checkpoint on the next coordinator call.
  await call('advance', fixture); advances++;
  const afterLostAck = (await call('importStatus', fixture)).next_chunk;
  assert.equal(afterLostAck, committed + 1);
  for (;;) {
    progress = await call('advance', fixture); advances++;
    if (large && advances % 500 === 0) console.log(`Advanced ${advances} chunks/pages; phase ${progress.phase}.`);
    if (progress.done || progress.phase === 'archive-blocked') break;
    if (advances > 10000) throw Error('Move exceeded bounded coordinator calls');
  }
  const moveSeconds = (performance.now() - moveStarted) / 1000;
  const stats = await call('exportStats', fixture);
  const sourceBytesAfter = await call('databaseSize', { name: 'large-source' });
  const gate = progress.phase === 'archive-blocked' ? await call('gateStatus', fixture) : null;
  if (gate) {
    assert.equal(gate.route.state, 'moving');
    assert.equal(gate.source.state, 'frozen');
    assert.equal(gate.destination.state, 'staged');
    assert.equal(gate.source.digest, gate.destination.digest);
  }
  const destinationName = gate ? gate.destination.object_name : progress.objectName;
  const destinationBytesAfter = await call('databaseSize', { name: destinationName });
  assert.ok(sourceBytesBefore > 0 && sourceBytesAfter > 0 && destinationBytesAfter > 0);
  assert.ok(stats.max_chunk <= 128 * 1024); assert.ok(stats.fragments > 1);
  if (large) assert.ok(stats.bytes >= 128 * 1024 * 1024, 'Encoded transfer below representative size');
  let cursor = 0, pages = 0; const counts = {}, tables = new Set();
  for (;;) {
    const evidence = await call('evidence', { ...fixture, after: cursor });
    assert.equal(evidence.complete, true);
    for (const row of evidence.pages) { assert.ok(/^[0-9a-f]{64}$/.test(row.digest)); cursor = row.sequence; pages++; tables.add(row.table); counts[row.table] = (counts[row.table] ?? 0) + row.count; }
    assert.equal(evidence.next, cursor);
    if (evidence.done) break;
    assert.ok(evidence.pages.length);
  }
  assert.equal(counts.users, sourceCounts.users); assert.equal(counts.user_passwords, sourceCounts.user_passwords); assert.equal(counts.events, sourceCounts.events);
  assert.equal(counts.mapi_oauth_signing_keys, 1, 'Issuer signing key missing from reconciliation');
  if (gate) {
    const targetCounts = await call('counts', { projectId: fixture.projectId, name: destinationName });
    assert.deepEqual(targetCounts, sourceCounts, 'Staged destination counts differ');
    assert.deepEqual(await call('counts', { projectId: fixture.projectId, name: 'large-source' }), sourceCounts, 'Source counts changed');
    console.log(JSON.stringify({ large, users, seededEvents: events, seedSeconds, moveSeconds, advances, transfer: stats, evidencePages: pages, tables: tables.size, archiveGateRejected: true, sourceFrozen: true, destinationStaged: true, stagedCountsMatch: true }, null, 2));
  } else {
    const result = await call('verify', { ...fixture, client });
    assert.equal(result.projectId, fixture.projectId); assert.equal(result.generation, 2);
    assert.equal(result.active, 200); assert.equal(result.revoked, 401); assert.equal(result.login, 200); assert.equal(result.bulkLogin, 200); assert.equal(result.bulkSessionMatched, true); assert.equal(result.foreign, 401); assert.equal(result.foreignBulk, 401); assert.equal(result.otherSession, 200); assert.equal(result.staleRejected, true); assert.equal(result.fk, 0);
    assert.equal(result.movedOverlapEmail, 'bulk-0@example.invalid'); assert.equal(result.otherOverlapEmail, 'other-overlap@example.invalid');
    assert.equal(result.counts.users, users); assert.equal(result.counts.user_passwords, users); assert.ok(result.counts.events >= sourceCounts.events);
    console.log(JSON.stringify({ large, users, seededEvents: events, historicalEvents: sourceCounts.events, seedSeconds, moveSeconds, advances, transfer: stats, transferBytesPerSecond: stats.bytes / moveSeconds, databaseBytes: { sourceBefore: sourceBytesBefore, sourceAfter: sourceBytesAfter, destinationAfter: destinationBytesAfter }, evidencePages: pages, tables: tables.size, projectIdPreserved: true, actualGoCredentialAndActiveRevokedSessions: true, bulkCredentialSessionIdentityAndCrossProjectRejection: true, preMoveIssuerKeySignsAfterMove: true, staleSourceRejected: true, otherProjectSessionConcurrent: true, overlappingUserIdsIsolated: true, interruptedExportAndImport: true, identicalReplayAndLostAcknowledgement: true, foreignKeys: result.fk }, null, 2));
  }
} catch (error) {
  if (error.localAction === 'advance' && error.localTimeout && diagnosticFixture) {
    // Read durable state before cleanup. The in-flight call may still be
    // completing; observations are independent and never authorize a retry.
    console.error(JSON.stringify(await inspectLocalMoveAfterTimeout(action => call(action, diagnosticFixture, false, 5000))));
  }
  if (diagnostic) console.error(diagnostic);
  throw error;
}
finally { if (server.exitCode === null && server.signalCode === null) { const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped; } await rm(dir, { recursive: true, force: true }); }
