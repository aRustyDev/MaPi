import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startLocalZitadel, bootstrapProject, connectZitadel } from '@zitadel/testing';
import { inspectProjectExtraction } from './project-extraction-preflight.mjs';

const directory = await mkdtemp(resolve(tmpdir(), 'mapi-native-project-preflight-'));
let native, db;
try {
  native = await startLocalZitadel({ dir: directory, projectName: 'Synthetic extraction project' });
  const primary = native.handle, user = await native.seedUser();
  const other = { ...primary, ...await bootstrapProject({ baseUrl: primary.baseUrl, projectName: 'Second extraction project' }) };
  const otherUser = await connectZitadel(other).seedUser();
  await native.stop(); native = undefined;
  const databasePath = resolve(directory, '.zitadel/local/nextgen-data/zitadel.db');
  // Direct SQL is synthetic test setup, not evidence of the grant API.
  db = new DatabaseSync(databasePath);
  const insert = db.prepare("INSERT INTO authz_assignments(id,project_id,catalog_id,principal_type,principal_id,object_type,relation,scope_kind,created_at,updated_at) VALUES(?,?,'cat_sys_1','user',?,'project','viewer','project',1,1)");
  insert.run('synthetic-inbound', primary.projectId, otherUser.id);
  insert.run('synthetic-outbound', other.projectId, user.id);
  db.close(); db = undefined;
  const baseline = JSON.parse(await readFile('worker/generated/baseline.json', 'utf8'));
  db = new DatabaseSync(databasePath, { readOnly: true });
  const report = inspectProjectExtraction(db, primary.projectId, baseline.statements);
  assert.equal(report.schemaComplete, true, `native schema differs: ${JSON.stringify(report.issues)}`);
  assert.equal(report.safeToExport, false); assert.equal(report.issues.projectRows, 1);
  assert.ok(report.issues.inboundUserGrants >= 1, 'foreign inbound grant missed');
  assert.ok(report.issues.outboundUserGrants >= 1, 'foreign outbound grant missed');
  console.log('Native SQLite project preflight detected synthetic inbound and outbound cross-project grants and refused export.');
} finally { db?.close(); if (native) await native.stop(); await rm(directory, { recursive: true, force: true }); }
