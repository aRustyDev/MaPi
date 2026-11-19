import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startLocalZitadel, bootstrapProject } from '@zitadel/testing';

const directory = await mkdtemp(resolve(tmpdir(), 'mapi-idp-config-native-'));
let server, db;
try {
  server = await startLocalZitadel({ dir: directory, projectName: 'Synthetic IdP config' });
  const { baseUrl, projectId, projectSecret } = server.handle;
  const foreign = await bootstrapProject({ baseUrl, projectName: 'Foreign IdP config' });
  const request = async (method, path, body, token = projectSecret, project = projectId) => {
    const url = new URL(path, baseUrl); url.searchParams.set('project_id', project);
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { throw Error('native response was not JSON'); }
    return { status: response.status, data };
  };
  const definition = client => ({ slug: 'synthetic', protocol: 'oidc', display_name: 'Synthetic', oidc: { issuer: 'https://idp.example.test', client_id: client, client_secret: '${{ PROVIDER_SECRET }}', scopes: ['openid'] }, claim_mapping: { email: 'email' } });
  const created = await request('POST', '/idps', { idp: definition('synthetic') }); assert.equal(created.status, 201); const oldRevision = created.data.revision_id; assert.ok(oldRevision);
  const set = await request('PATCH', '/variables', { PROVIDER_SECRET: { value: 'synthetic-secret', secret: true } }); assert.equal(set.status, 200); assert.ok(!JSON.stringify(set.data).includes('synthetic-secret'));
  const deployments = await request('GET', '/deployments'); assert.equal(deployments.status, 200); const release = deployments.data.deployments?.[0]?.release_id; assert.ok(release, 'existing release missing');
  const deployed = await request('POST', '/deployments', { release_id: release, targets: 'primary' }); assert.ok([200,201].includes(deployed.status), `deployment status ${deployed.status}`); const deployment = deployed.data.id; assert.ok(deployment);
  db = new DatabaseSync(resolve(directory, '.zitadel/local/nextgen-data/zitadel.db'));
  const frozen = () => db.prepare('SELECT v.entries FROM variable_sets v JOIN deployment_variable_sets d ON d.project_id=v.project_id AND d.set_hash=v.content_hash WHERE d.project_id=? AND d.deployment_id=?').get(projectId, deployment)?.entries;
  const live = () => db.prepare("SELECT value FROM variables WHERE project_id=? AND name='PROVIDER_SECRET' AND kind='primary'").get(projectId)?.value;
  const frozenBefore = frozen(), liveBefore = live(); assert.ok(frozenBefore && liveBefore);
  assert.equal((await request('PATCH', '/variables', { PROVIDER_SECRET: { value: 'changed-after-deployment', secret: true } })).status, 200);
  assert.equal(frozen(), frozenBefore, 'deployed variable snapshot changed'); assert.notEqual(live(), liveBefore, 'live secret did not change');
  const revised = await request('POST', '/idps', { idp: definition('different-client') }); assert.equal(revised.status, 200); assert.notEqual(revised.data.revision_id, oldRevision);
  const old = await request('GET', `/idps/revisions/${encodeURIComponent(oldRevision)}`); assert.equal(old.status, 200); assert.equal(old.data.definition.oidc.client_id, 'synthetic');
  const cross = await request('GET', `/idps/revisions/${encodeURIComponent(oldRevision)}`, undefined, foreign.projectSecret, foreign.projectId); assert.equal(cross.status, 404);
  const vars = await request('GET', `/deployments/${encodeURIComponent(deployment)}/variables`); assert.equal(vars.status, 200); assert.ok(!JSON.stringify(vars.data).includes('synthetic-secret'));
  for (const [table,column] of [['variables','value'],['variable_sets','entries'],['events','payload'],['idp_connection_revisions','document']]) {
    const row = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id=? AND (instr(${column},?)>0 OR instr(${column},?)>0)`).get(projectId, 'synthetic-secret', 'changed-after-deployment');
    assert.equal(row.n, 0, `${table} stores secret in clear`);
  }
  const audit = db.prepare("SELECT count(*) AS n FROM events WHERE project_id=? AND event_type IN ('idp.created','idp.updated','variable.set')").get(projectId); assert.ok(audit.n >= 4);
  console.log('Native IdP revisions, frozen deployment variables, project isolation and audit redaction passed.');
} finally { db?.close(); await server?.stop(); await rm(directory, { recursive: true, force: true }); }
