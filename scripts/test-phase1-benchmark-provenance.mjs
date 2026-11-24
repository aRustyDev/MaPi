import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { requireBenchmarkProvenance } from './phase1-benchmark-provenance.mjs';

const disabled = /disabled until benchmark-specific provenance/;
await assert.rejects(requireBenchmarkProvenance(), disabled);

// Exercise the real entry points, not just the guard in isolation. The
// preload blocks network, child processes and RP temporary-directory creation
// if a future edit moves the guard past a side effect. It creates a marker
// before rejecting an operation, so such a regression cannot be a false pass.
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-benchmark-guard-'));
try {
  const scratch = resolve(directory, 'scratch');
  await mkdir(scratch);
  const marker = resolve(directory, 'unexpected-operation');
  const preload = resolve(directory, 'block-side-effects.mjs');
  await writeFile(preload, `
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const blocked = name => (..._args) => {
  fs.writeFileSync(process.env.MAPI_TEST_GUARD_MARKER, name);
  throw new Error('Unexpected side effect blocked by local test');
};
globalThis.fetch = blocked('fetch');
for (const name of ['fork', 'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) childProcess[name] = blocked(name);
for (const client of [http, https]) for (const name of ['request', 'get', 'createServer']) client[name] = blocked(name);
for (const name of ['connect', 'createConnection', 'createServer']) net[name] = blocked(name);
fsPromises.mkdtemp = blocked('mkdtemp');
syncBuiltinESMExports();
`);
  const configPath = resolve(directory, 'benchmark.json');
  const outputPath = resolve(directory, 'report.json');
  const secret = 'private-test-operator-must-not-appear';
  const missingUser = resolve(directory, 'user-fixture-must-not-be-read.json');
  const projects = ['a', 'b'].map(letter => ({
    origin: `https://project-${letter}.example.invalid`, operator: secret,
    userFile: missingUser, userId: `user_${letter}`, projectId: `project_${letter}`,
  }));
  await writeFile(configPath, JSON.stringify({ projects }), { mode: 0o600 });
  const baseEnv = {
    ...process.env,
    NODE_OPTIONS: `--import=${preload}`,
    TMPDIR: scratch,
    MAPI_TEST_GUARD_MARKER: marker,
    MAPI_PHASE1_FILE: configPath,
    MAPI_PHASE1_OUTPUT: outputPath,
    MAPI_PHASE1_CONTROL_URL: 'http://127.0.0.1:1',
    MAPI_URL: projects[0].origin,
    MAPI_OPERATOR_TOKEN: secret,
    MAPI_TEST_USER_FILE: missingUser,
    MAPI_PHASE1_CHILD: '0',
  };
  for (const [entry, extraEnv] of [
    ['scripts/benchmark-phase1.mjs', {}],
    ['scripts/test-hosted-oidc.mjs', {}],
    ['scripts/test-hosted-oidc.mjs', { MAPI_PHASE1_CHILD: '1' }],
  ]) {
    const run = spawnSync(process.execPath, [entry], {
      cwd: process.cwd(), env: { ...baseEnv, ...extraEnv }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(run.signal, null, `${entry}: process did not finish`);
    assert.notEqual(run.status, 0, `${entry}: guard must reject`);
    assert.match(run.stderr, disabled, `${entry}: expected the provenance rejection`);
    assert.ok(!`${run.stdout}${run.stderr}`.includes(secret), `${entry}: secret appeared in output`);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    await assert.rejects(access(outputPath), { code: 'ENOENT' });
    assert.deepEqual(await readdir(scratch), [], `${entry}: RP scratch directory was created`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('Both hosted benchmark entry points fail before network, subprocesses, RP setup, or report writes.');
