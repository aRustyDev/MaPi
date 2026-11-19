import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startLocalZitadel } from '@zitadel/testing';
import { client } from './parity.mjs';

const directory = await mkdtemp(resolve(tmpdir(), 'mapi-native-console-management-'));
let native, db;
try {
  native = await startLocalZitadel({ dir: resolve(directory, 'native'), projectName: 'Console session parity' });
  const user = await native.seedUser();
  const fixture = { ...native.handle, user };
  const api = client(native.handle.baseUrl, fixture);
  const session = api.session(await api.exchange(await api.mint()));
  db = new DatabaseSync(resolve(directory, 'native/.zitadel/local/nextgen-data/zitadel.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const origin = new URL(native.handle.baseUrl).origin;
  const path = `/api/v1/users/query?project_id=${encodeURIComponent(fixture.projectId)}`;
  const query = async (headers = {}) => {
    const response = await fetch(new URL(path, origin), { method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: session.cookie, ...headers }, body: '{}' });
    const data = await response.json();
    return { status: response.status, data };
  };
  const before = await query();
  assert.equal(before.status, 404, 'unprivileged session had unexpected management behavior');
  const assignment = `fixture-admin-${randomUUID()}`;
  db.prepare("INSERT INTO authz_assignments (id,project_id,catalog_id,principal_type,principal_id,object_type,relation,scope_kind,created_at,updated_at) VALUES (?,?,'cat_sys_1','user',?,'project','admin','project',1800000000000000000,1800000000000000000)")
    .run(assignment, fixture.projectId, user.id);
  const granted = await query();
  assert.equal(granted.status, 200);
  assert.ok(granted.data.users.some(item => item.id === user.id));
  assert.equal((await query({ 'x-zitadel-csrf': 'invalid' })).status, 200, 'query is CSRF-token exempt');
  assert.equal((await query({ origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await query({ authorization: 'Bearer invalid' })).status, 401);
  db.prepare('UPDATE authz_assignments SET revoked_at=1800000000000000001 WHERE id=? AND project_id=?').run(assignment, fixture.projectId);
  const revoked = await query();
  assert.equal(revoked.status, 404, 'revoked grant had unexpected management behavior');
  assert.equal((await api.read(session)).status, 200, 'grant revocation revoked the session');
  console.log(JSON.stringify({ unprivileged: before.status, granted: granted.status, revoked: revoked.status, sessionAfterRevoke: 200 }));
} finally {
  db?.close();
  await native?.stop();
  await rm(directory, { recursive: true, force: true });
}
