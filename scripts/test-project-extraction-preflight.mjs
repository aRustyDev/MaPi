import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { inspectProjectExtraction } from './project-extraction-preflight.mjs';

const baseline = JSON.parse(await readFile('worker/generated/baseline.json', 'utf8'));
const db = new DatabaseSync(':memory:');
try {
  for (const statement of baseline.statements) db.exec(statement);
  for (const id of ['p1', 'p2']) db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,1,1)').run(id, id);
  db.prepare("INSERT INTO users(project_id,id,schema_url,created_at,updated_at) VALUES('p1','u1','schema',1,1)").run();
  db.prepare("INSERT INTO users(project_id,id,schema_url,created_at,updated_at) VALUES('p2','u2','schema',1,1)").run();
  db.prepare("INSERT INTO teams(project_id,id,name,created_at,updated_at) VALUES('p1','t1','team one',1,1)").run();
  db.prepare("INSERT INTO teams(project_id,id,name,created_at,updated_at) VALUES('p2','t2','team two',1,1)").run();
  const insert = db.prepare("INSERT INTO authz_assignments(id,project_id,catalog_id,principal_type,principal_id,object_type,relation,scope_kind,created_at,updated_at) VALUES(?,?,'cat_sys_1',?,?,'project','viewer','project',1,1)");
  insert.run('g1','p1','user','u2'); insert.run('g2','p1','team','t2');
  insert.run('g3','p2','user','u1'); insert.run('g4','p2','team','t1');
  let report = inspectProjectExtraction(db, 'p1', baseline.statements);
  assert.equal(report.schemaComplete, true); assert.equal(report.safeToExport, false); assert.equal(report.issues.projectRows, 1);
  assert.equal(report.issues.inboundUserGrants, 1); assert.equal(report.issues.inboundTeamGrants, 1);
  assert.equal(report.issues.outboundUserGrants, 1); assert.equal(report.issues.outboundTeamGrants, 1);
  insert.run('g5','p1','user','missing-user');
  report = inspectProjectExtraction(db, 'p1', baseline.statements); assert.equal(report.issues.inboundUserGrants, 2);
  db.prepare("INSERT INTO users(project_id,id,schema_url,created_at,updated_at) VALUES('p1','u2','schema',1,1)").run();
  db.prepare("UPDATE users SET lifecycle_owner_team_id='missing-team' WHERE project_id='p1' AND id='u1'").run();
  db.prepare("INSERT INTO authz_membership_edges(project_id,member_type,member_id,set_type,set_id,created_at) VALUES('p1','user','missing-user','team','t1',1)").run();
  insert.run('g6','p1','sk_proj','key-one'); insert.run('g7','p2','agent','agent-two');
  db.exec("INSERT INTO authz_catalogs(id,catalog_kind,owner_id,version,status,created_at) VALUES('cat_custom','app_group','group',1,'active',1)");
  db.exec("INSERT INTO event_sinks(id,type,scope,project_id) VALUES('sink','test','global',NULL)");
  report = inspectProjectExtraction(db, 'p1', baseline.statements);
  assert.equal(report.issues.ambiguousPrincipalIds, 1); assert.equal(report.issues.unresolvedMembershipUsers, 1); assert.equal(report.issues.unresolvedLifecycleTeams, 1);
  assert.equal(report.issues.unsupportedPrincipalGrants, 1); assert.equal(report.issues.outsideUnsupportedPrincipalGrants, 1);
  assert.equal(report.issues.appGroupCatalogs, 1); assert.equal(report.issues.sharedEventSinks, 1);
  db.exec('CREATE TABLE unexpected_project_state (project_id TEXT, value TEXT)');
  report = inspectProjectExtraction(db, 'p1', baseline.statements); assert.equal(report.schemaComplete, false); assert.deepEqual(report.issues.unknownTables, ['unexpected_project_state']); assert.equal(report.safeToExport, false);
  db.exec('DROP TABLE unexpected_project_state'); db.exec('ALTER TABLE users ADD COLUMN unrecognized TEXT');
  report = inspectProjectExtraction(db, 'p1', baseline.statements); assert.equal(report.schemaComplete, false); assert.deepEqual(report.issues.changedTables, ['users']);
} finally { db.close(); }

const directory = await mkdtemp(resolve(tmpdir(), 'mapi-extraction-preflight-'));
try {
  const path = resolve(directory, 'source.sqlite');
  const disk = new DatabaseSync(path);
  try {
    for (const statement of baseline.statements) disk.exec(statement);
    disk.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('p1','p1',1,1)");
  } finally { disk.close(); }
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/project-extraction-preflight.mjs', path, 'p1'], { encoding: 'utf8' }));
  assert.equal(report.schemaComplete, true); assert.equal(report.issues.projectRows, 1); assert.equal(report.safeToExport, false);
  const readonly = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(readonly.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1); } finally { readonly.close(); }
} finally { await rm(directory, { recursive: true, force: true }); }
console.log('Project extraction preflight: cross-project grants, unresolved and ambiguous principals, global state, unknown schema and fail-closed status passed.');
