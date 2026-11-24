// Run only against the loopback caller bound to the isolated service proxy.
// Durable coordinator checkpoints permit an operator to resume after failure.
import { setTimeout } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { rehearsalManagementRead } from './rehearsal-management.mjs';
import { requireEnabledProof } from './relocation-rehearsal-enabled-proof.mjs';

const target = new URL(process.env.MAPI_REHEARSAL_CONTROL_URL ?? '');
const secret = process.env.MAPI_REHEARSAL_OPERATOR_TOKEN;
const limit = Number(process.env.MAPI_REHEARSAL_CALL_LIMIT ?? '10000');
if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password || !secret || !Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw Error('A loopback rehearsal caller, operator token and bounded call limit are required');
const fixturePath = process.env.MAPI_REHEARSAL_FIXTURE;
const managementToken = process.env.MAPI_REHEARSAL_OTHER_MANAGEMENT_TOKEN;
if (Boolean(fixturePath) !== Boolean(managementToken)) throw Error('Concurrent management needs both fixture and synthetic management token');
const fixture = fixturePath ? JSON.parse(await readFile(fixturePath, 'utf8')) : null;
if (fixture) {
  const directory = dirname(resolve(fixturePath));
  const verified = await requireEnabledProof(directory);
  if (fixture.rehearsalId !== verified.fixture.rehearsalId || fixture.otherProjectId !== verified.fixture.otherProjectId) throw Error('Concurrent management provenance mismatch');
}
for (let attempt = 1; attempt <= limit; attempt++) {
  const [response] = await Promise.all([
    fetch(target, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(60000) }),
    ...(fixture ? [rehearsalManagementRead(fixture, managementToken, attempt)] : []),
  ]);
  if (!response.ok) throw Error(`Rehearsal call ${attempt} returned HTTP ${response.status}; inspect durable state before rerunning`);
  const progress = await response.json();
  if (!progress || typeof progress.phase !== 'string' || typeof progress.done !== 'boolean') throw Error('Invalid coordinator response');
  console.log(JSON.stringify({ attempt, managementReads: fixture ? attempt : 0, ...progress }));
  if (progress.done) {
    if (process.env.MAPI_REHEARSAL_VERIFY_EVIDENCE === '1') {
      let after = 0, pages = 0; const tables = new Set();
      for (;;) {
        const evidenceURL = new URL(target); evidenceURL.pathname = '/evidence'; evidenceURL.search = new URLSearchParams({ after: String(after) }).toString();
        const response = await fetch(evidenceURL, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw Error('Could not read reconciliation evidence');
        const evidence = await response.json();
        if (!evidence.complete || !Array.isArray(evidence.pages) || !Number.isSafeInteger(evidence.next) || evidence.next < after || typeof evidence.done !== 'boolean') throw Error('Invalid reconciliation evidence');
        for (const page of evidence.pages) {
          if (!Number.isSafeInteger(page.sequence) || page.sequence <= after || !Number.isSafeInteger(page.count) || page.count < 0 || !/^[0-9a-f]{64}$/.test(page.digest) || typeof page.table !== 'string') throw Error('Invalid reconciliation evidence page');
          after = page.sequence; tables.add(page.table); pages++; console.log(JSON.stringify({ reconciliation: page }));
        }
        if (evidence.next !== after) throw Error('Evidence cursor differs');
        if (evidence.done) break;
        if (!evidence.pages.length) throw Error('Evidence cursor did not advance');
      }
      if (!tables.has('users') || !tables.has('events')) throw Error('Users or audit reconciliation is missing');
      console.log(JSON.stringify({ reconciliationComplete: true, evidencePages: pages }));
    }
    if (process.env.MAPI_REHEARSAL_VERIFY_STALE === '1') {
      const probeURL = new URL(target); probeURL.pathname = '/stale-probe'; probeURL.search = '';
      const probe = await fetch(probeURL, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (!probe.ok || (await probe.json()).rejected !== true) throw Error('Stale source rejection was not verified');
      console.log(JSON.stringify({ staleSourceRejected: true }));
    }
    process.exit(0);
  }
  await setTimeout(10);
}
throw Error('Rehearsal call limit reached; inspect durable state before continuing');
