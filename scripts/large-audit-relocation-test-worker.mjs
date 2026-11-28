import { syntheticHistoricalFreeze } from './synthetic-historical-freeze.mjs';
// Local-only representative fixture. All setup/bulk writes are disposable and
// happen before the real registry/owner move starts.
import { NextgenApplication } from '../worker/generated/events-audit-relocation-test-app.js';
import { ProjectRegistry } from '../worker/registry.js';
import { RelocationCoordinator } from '../worker/relocation-coordinator.js';
import { initializeOwnerFence } from '../worker/owner-fence.js';
import { exportChunk, importChunk, chunkExportStatus, chunkImportStatus } from '../worker/relocation-chunks.js';

export { ProjectRegistry, RelocationCoordinator };
const origin = 'https://large-real.example.test';
const otherOrigin = 'https://large-other.example.test';
const moveId = 'large-real-move';
const sourceName = 'large-source';
const otherName = 'large-other';
// Match the generated API's user_ and upw_ resource IDs: identifier proof
// responses carry the user ID and validate its prefix before returning.
const userId = index => `user_bulk_${String(index).padStart(8, '0')}`;
const passwordId = index => `upw_bulk_${String(index).padStart(8, '0')}`;
const eventId = index => `evt_bulk_${String(index).padStart(8, '0')}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64url = bytes => bytes.toBase64().replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const decode64 = value => Uint8Array.fromBase64(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));

// This drives the actual Go OAuth endpoints with the preserved session. A
// successful signature proves the pre-move private key remains usable.
async function verifyMovedSigning(owner, route, sessionCookie, client, jwks, expectedKey, expectedUser) {
  const project = route.projectId, redirect = 'https://shop.example/callback';
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
  const query = new URLSearchParams({ client_id: client.ClientID, redirect_uri: redirect, response_type: 'code', scope: 'openid', state: 'mapi-state', nonce: 'mapi-nonce', code_challenge: challenge, code_challenge_method: 'S256' });
  const oauth = (method, path, headers = {}, body = '') => owner.oauthRequest({ method, url: route.origin + path, headers, body: encoder.encode(body).toBase64(), peer: '192.0.2.9' }, route);
  const auth = await oauth('GET', `/oauth/${project}/authorize?${query}`);
  if (auth.status !== 302) throw Error('Moved issuer authorization failed');
  const handle = new URL(auth.headers.Location[0]).searchParams.get('mapi_oauth');
  const binding = auth.headers['Set-Cookie'][0].split(';')[0];
  const cookie = `${sessionCookie}; ${binding}`;
  const continuation = await oauth('GET', `/oauth/continue?request=${encodeURIComponent(handle)}`, { cookie: [cookie] });
  const csrf = decoder.decode(Uint8Array.fromBase64(continuation.body)).match(/name="csrf" value="([^"]+)"/)?.[1];
  if (continuation.status !== 200 || !csrf) throw Error('Moved issuer continuation failed');
  const complete = await oauth('POST', '/oauth/continue', { cookie: [cookie], origin: [route.origin], 'content-type': ['application/x-www-form-urlencoded'] }, new URLSearchParams({ request: handle, csrf }).toString());
  if (complete.status !== 303) throw Error('Moved issuer continuation failed');
  const callback = new URL(complete.headers.Location[0]);
  const code = callback.searchParams.get('code');
  if (!code || callback.searchParams.get('state') !== 'mapi-state') throw Error('Moved issuer code failed');
  const credentials = btoa(`${encodeURIComponent(client.ClientID)}:${encodeURIComponent(client.Secret)}`);
  const token = await oauth('POST', `/oauth/${project}/token`, { authorization: [`Basic ${credentials}`], 'content-type': ['application/x-www-form-urlencoded'] }, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }).toString());
  if (token.status !== 200) throw Error('Moved issuer token failed');
  const idToken = JSON.parse(decoder.decode(Uint8Array.fromBase64(token.body))).id_token;
  const [head, claimsPart, signature] = idToken.split('.');
  const header = JSON.parse(decoder.decode(decode64(head))), claims = JSON.parse(decoder.decode(decode64(claimsPart)));
  const jwk = jwks.keys.find(item => item.kid === expectedKey);
  if (!jwk || header.kid !== expectedKey || header.alg !== 'RS256' || claims.iss !== `${route.origin}/oauth/${project}` || claims.nonce !== 'mapi-nonce' || claims.sub !== expectedUser || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(client.ClientID)) throw Error('Moved issuer identity differs');
  const publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, decode64(signature), encoder.encode(`${head}.${claimsPart}`))) throw Error('Moved issuer signature invalid');
}

export class LargeOwner extends NextgenApplication {
  preFreezeRelocation(secret, route, moveId, marker) { return syntheticHistoricalFreeze(this, () => super.preFreezeRelocation(secret, route, moveId, marker), route, moveId, marker); }

  async arm(route) { initializeOwnerFence(this.ctx.storage, route); await this.ctx.storage.sync(); }
  seedOverlap(projectId) {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const schema = sql.exec('SELECT schema_url FROM mapi_project WHERE project_id = ?', projectId).one().schema_url;
      sql.exec('INSERT INTO users (project_id, id, schema_url, created_at, updated_at) VALUES (?, ?, ?, 1, 1)', projectId, userId(0), schema);
      sql.exec('INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, ?, ?)', projectId, userId(0), 'email', JSON.stringify('other-overlap@example.invalid'));
    });
  }
  overlapEmail(projectId) { return JSON.parse(this.ctx.storage.sql.exec("SELECT value FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'email'", projectId, userId(0)).one().value); }
  databaseSize() { return this.ctx.storage.sql.databaseSize; }
  // Diagnostic shape only: no identifiers, credential material, or payloads.
  bulkLoginDiagnostics(projectId, sourceUserId) {
    const sql = this.ctx.storage.sql;
    const values = sql.exec(`SELECT a.unique_team_id IS b.unique_team_id AS same_scope,
      typeof(a.value_hash) AS hash_type, length(a.value_hash) AS hash_length,
      u.schema_url = v.schema_url AS same_schema, u.status AS bulk_status,
      p.encoded_hash = q.encoded_hash AS same_password_hash
      FROM user_attributes a JOIN users u ON u.project_id = a.project_id AND u.id = a.user_id
      JOIN user_passwords p ON p.project_id = u.project_id AND p.user_id = u.id
      JOIN user_attributes b ON b.project_id = a.project_id AND b.user_id = ? AND b.key = 'email'
      JOIN users v ON v.project_id = b.project_id AND v.id = b.user_id
      JOIN user_passwords q ON q.project_id = v.project_id AND q.user_id = v.id
      WHERE a.project_id = ? AND a.user_id = ? AND a.key = 'email'`, sourceUserId, projectId, userId(0)).one();
    const checks = sql.exec(`SELECT type, failure_count, factor_payload IS NOT NULL AS verified
      FROM checks WHERE project_id = ? AND auth_attempt_id = (SELECT id FROM auth_attempts WHERE project_id = ? ORDER BY rowid DESC LIMIT 1)
      ORDER BY rowid`, projectId, projectId).toArray();
    return { values, checks };
  }
  async seedUsers(projectId, sourceUserId, start, count) {
    // These ASCII identifiers are already case-folded. Nextgen's unique
    // attribute index hashes the JSON-encoded folded value with SHA-256.
    const emails = Array.from({ length: count }, (_, index) => `bulk-${start + index}@example.invalid`);
    const valueHashes = await Promise.all(emails.map(email => crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(email)))));
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const schema = sql.exec('SELECT schema_url FROM mapi_project WHERE project_id = ?', projectId).one().schema_url;
      // Reuse the Go-created synthetic credential in this disposable fixture;
      // this avoids placeholder hashes without hashing 10,000 passwords.
      const hash = sql.exec('SELECT encoded_hash FROM user_passwords WHERE project_id = ? AND user_id = ?', projectId, sourceUserId).one().encoded_hash;
      if (typeof hash !== 'string' || !hash.startsWith('$argon2id$')) throw Error('Missing synthetic Argon2id fixture hash');
      const scope = sql.exec("SELECT unique_team_id FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'email'", projectId, sourceUserId).one().unique_team_id;
      for (let i = start; i < start + count; i++) {
        const user = userId(i);
        sql.exec('INSERT INTO users (project_id, id, schema_url, created_at, updated_at) VALUES (?, ?, ?, 1700000000000000001, 1700000000000000001)', projectId, user, schema);
        const email = emails[i - start];
        sql.exec('INSERT INTO user_attributes (project_id, user_id, key, value, unique_team_id, value_hash, search_text) VALUES (?, ?, ?, ?, ?, ?, ?)', projectId, user, 'email', JSON.stringify(email), scope, valueHashes[i - start], email);
        sql.exec('INSERT INTO user_passwords (project_id, id, user_id, encoded_hash, created_at) VALUES (?, ?, ?, ?, 1700000000000000001)', projectId, passwordId(i), user, hash);
      }
    });
  }
  seedEvents(projectId, start, count) {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const payload = JSON.stringify({ attribute_keys: ['detail'], attributes: { detail: 'x'.repeat(1400) } });
      for (let i = start; i < start + count; i++) sql.exec("INSERT INTO events (project_id, id, event_type, category, occurred_at, created_at, entity_type, entity_id, user_id, payload, metadata) VALUES (?, ?, 'user.created', 'entity', 1700000000000000001, 1700000000000000001, 'user', ?, ?, ?, '{}')", projectId, eventId(i), userId(i % 60), userId(i % 60), payload);
    });
  }
  seedDomain(projectId, realUserId) {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, ?, ?)', projectId, realUserId, 'large', JSON.stringify('x'.repeat(180000)));
      sql.exec("INSERT INTO teams (project_id, id, name, created_at, updated_at) VALUES (?, 'team_bulk_fixture', 'Bulk fixture', 1700000000000000001, 1700000000000000001)", projectId);
      sql.exec("INSERT INTO authz_membership_edges VALUES (?, 'user', ?, 'team', 'team_bulk_fixture', 1)", projectId, realUserId);
      sql.exec("INSERT INTO authz_assignments (id, project_id, catalog_id, principal_type, principal_id, object_type, relation, scope_kind, created_at, updated_at) VALUES ('grant_bulk_fixture', ?, 'cat_sys_1', 'user', ?, 'project', 'admin', 'project', 1, 1)", projectId, realUserId);
      sql.exec("INSERT INTO releases (project_id, id, content_hash, pointers, metadata, created_at) VALUES (?, 'release_bulk_fixture', ?, '[\"fixture\"]', '{}', 1)", projectId, 'a'.repeat(64));
      sql.exec("INSERT INTO deployments (project_id, id, release_id, origin_kind, metadata, deployed_at) VALUES (?, 'deployment_bulk_fixture', 'release_bulk_fixture', 'primary', '{}', 1)", projectId);
    });
  }
  exportStatus(projectId) { return chunkExportStatus(this.ctx.storage, projectId); }
  importStatus(projectId) { return chunkImportStatus(this.ctx.storage, projectId); }
  failExport(projectId, index) { return exportChunk(this.ctx.storage, projectId, 1, moveId, index, true); }
  failImport(projectId, part) { return importChunk(this.ctx.storage, projectId, part, 1); }
  replayImport(projectId, part) { return importChunk(this.ctx.storage, projectId, part); }
  exportStats(projectId) {
    return this.ctx.storage.sql.exec("SELECT COUNT(*) AS chunks, COALESCE(SUM(length(CAST(content AS BLOB))),0) AS bytes, COALESCE(MAX(length(CAST(content AS BLOB))),0) AS max_chunk, COALESCE(SUM(CASE WHEN json_type(content, '$.fragment') IS NOT NULL THEN 1 ELSE 0 END),0) AS fragments FROM mapi_chunk_export_data WHERE project_id = ?", projectId).one();
  }
  counts(projectId) {
    const sql = this.ctx.storage.sql;
    return Object.fromEntries(['projects', 'users', 'user_passwords', 'events'].map(table => [table, sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'} = ?`, projectId).one().n]));
  }
  claimAuditForTest(projectId, suffix) {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local audit fixture disabled');
    const sql = this.ctx.storage.sql, team = 'team_audit_' + suffix;
    this.ctx.storage.transactionSync(() => {
      sql.exec('INSERT INTO teams (project_id,id,name,created_at,updated_at) VALUES (?,?,?,1,1)', projectId, team, 'Local audit fixture');
      sql.exec("INSERT INTO authz_assignments (id,project_id,catalog_id,principal_type,principal_id,object_type,relation,scope_kind,created_at,updated_at) VALUES (?,?,'cat_sys_1','team',?,'project','team','project',1,1)", 'audit_grant_' + suffix, projectId, team);
    });
  }
  insertMalformedAuditForTest(projectId, id, type, payload) {
    if (this.env.MAPI_LOCAL_TEST !== '1' || !['evt_guard_unknown_field', 'evt_guard_unknown_type', 'evt_guard_duplicate'].includes(id)) throw Error('Local audit fixture disabled');
    this.ctx.storage.sql.exec("INSERT INTO events (project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES (?,?,?,'admin',9223372036854775807,9223372036854775807,?,'{}')", projectId, id, type, payload);
  }
  removeMalformedAuditForTest(projectId) {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local audit fixture disabled');
    this.ctx.storage.transactionSync(() => this.ctx.storage.sql.exec("DELETE FROM events WHERE project_id=? AND id IN ('evt_guard_unknown_field','evt_guard_unknown_type','evt_guard_duplicate')", projectId));
  }
  fk() { return this.ctx.storage.sql.exec('PRAGMA foreign_key_check').toArray().length; }
  keyRows() { return this.ctx.storage.sql.exec('SELECT project_id, key_id FROM mapi_oauth_signing_keys ORDER BY project_id, key_id').toArray(); }
}

export default {
  async fetch(request, env) {
    try {
      if (env.MAPI_LOCAL_TEST !== '1' || new URL(request.url).hostname !== '127.0.0.1') return new Response(null, { status: 404 });
      const body = await request.json();
      const registry = env.PROJECT_REGISTRY.getByName('projects');
      const source = env.NEXTGEN_APPLICATION.getByName(sourceName);
      const other = env.NEXTGEN_APPLICATION.getByName(otherName);
      const coordinator = env.COORDINATOR.getByName('large-coordinator');
      if (body.action === 'setup') {
        await registry.reserve(origin, sourceName); await registry.reserve(otherOrigin, otherName);
        const projectId = (await source.provision('Large real project', origin, { projectId: null, origin, objectName: sourceName, generation: 1 })).projectId;
        const otherProject = (await other.provision('Other real project', otherOrigin, { projectId: null, origin: otherOrigin, objectName: otherName, generation: 1 })).projectId;
        await registry.activate(origin, sourceName, projectId); await registry.activate(otherOrigin, otherName, otherProject);
        const sourceRoute = { projectId, origin, objectName: sourceName, generation: 1 };
        const otherRoute = { projectId: otherProject, origin: otherOrigin, objectName: otherName, generation: 1 };
        const sourceIssuer = await source.oauthAdmin('initialize', {}, sourceRoute);
        const otherIssuer = await other.oauthAdmin('initialize', {}, otherRoute);
        if (!sourceIssuer.keyId || !otherIssuer.keyId || sourceIssuer.keyId === otherIssuer.keyId) throw Error('Synthetic issuer keys not distinct');
        const registered = await source.oauthAdmin('register', { document: { slug: 'shop', name: 'Shop', clients: [{ slug: 'web', type: 'confidential', grant_types: ['authorization_code'], redirect_uris: ['https://shop.example/callback'] }] } }, sourceRoute);
        if (registered.Secrets?.length !== 1 || !registered.Secrets[0].Secret) throw Error('Synthetic client registration failed');
        const jwksResult = await source.oauthRequest({ method: 'GET', url: `${origin}/oauth/${projectId}/jwks`, headers: {}, body: '', peer: '192.0.2.9' }, sourceRoute);
        if (jwksResult.status !== 200) throw Error('Source JWKS request failed');
        const jwks = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(jwksResult.body)));
        if (jwks.keys.length !== 1 || jwks.keys[0].kid !== sourceIssuer.keyId || jwks.keys.some(key => key.d)) throw Error('Source JWKS mismatch');
        const user = await source.addUser('real-source@example.test', 'Real-source-password-123!', sourceRoute);
        await other.addUser('real-other@example.test', 'Real-other-password-123!', otherRoute);
        const first = await source.login('real-source@example.test', 'Real-source-password-123!', 'fixture', sourceRoute);
        const revoked = await source.login('real-source@example.test', 'Real-source-password-123!', 'fixture', sourceRoute);
        const second = await other.login('real-other@example.test', 'Real-other-password-123!', 'fixture', otherRoute);
        await other.seedOverlap(otherProject);
        if (first.status !== 200 || revoked.status !== 200 || second.status !== 200) throw Error('Initial Go login failed');
        const oldCookie = revoked.cookie.split(';', 1)[0];
        const csrf = await source.session(oldCookie, 'csrf', '', sourceRoute);
        if (csrf.status !== 200 || (await source.session(oldCookie, 'logout', csrf.data.csrf_token, sourceRoute)).status !== 204) throw Error('Initial revocation failed');
        await other.arm(otherRoute);
        return Response.json({ projectId, userId: user.userId, otherProject, cookie: first.cookie.split(';', 1)[0], revokedCookie: oldCookie, otherCookie: second.cookie.split(';', 1)[0], sourceKeyId: sourceIssuer.keyId, otherKeyId: otherIssuer.keyId, client: registered.Secrets[0], jwks });
      }
      if (body.action === 'users') return Response.json(await source.seedUsers(body.projectId, body.userId, body.start, body.count) ?? true);
      if (body.action === 'events') return Response.json(await source.seedEvents(body.projectId, body.start, body.count) ?? true);
      if (body.action === 'domain') return Response.json(await source.seedDomain(body.projectId, body.userId) ?? true);
      if (body.action === 'claimAudit') {
        await source.claimAuditForTest(body.projectId, 'source');
        await other.claimAuditForTest(body.otherProject, 'other');
        return Response.json(true);
      }
      if (body.action === 'audit') {
        const routeRow = await registry.resolve(origin);
        const route = { projectId: routeRow.project_id, origin: routeRow.origin, objectName: routeRow.object_name, generation: routeRow.generation };
        const owner = env.NEXTGEN_APPLICATION.getByName(route.objectName);
        const otherRoute = { projectId: body.otherProject, origin: otherOrigin, objectName: otherName, generation: 1 };
        const token = await owner.testManagementToken(route), otherToken = await other.testManagementToken(otherRoute);
        const document = await owner.handleRequest({ method: 'GET', url: route.origin + '/api/v1/openapi.json', headers: { accept: ['application/json'] }, body: '', peer: '127.0.0.1' }, route);
        if (document.status !== 200 || !document.body || !/^[0-9a-f]{64}$/.test(env.MAPI_EXPECTED_OPENAPI_SHA256 ?? '')) throw Error('Local OpenAPI document unavailable');
        const documentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.fromBase64(document.body))), byte => byte.toString(16).padStart(2, '0')).join('');
        if (documentHash !== env.MAPI_EXPECTED_OPENAPI_SHA256) throw Error('Served OpenAPI document differs from generated bundle');
        const auditRequest = async (which, authority, credential, path) => {
          const response = await which.handleRequest({ method: 'GET', url: authority.origin + path, headers: { authorization: ['Bearer ' + credential], accept: ['application/json'] }, body: '', peer: '127.0.0.1' }, authority);
          let data = null;
          if (response.body) data = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(response.body)));
          return { status: response.status, data };
        };
        const path = '/api/v1/events?project_id=' + encodeURIComponent(body.projectId) + '&event_type=user.created&order=asc&limit=10';
        const unfilteredPath = '/api/v1/events?project_id=' + encodeURIComponent(body.projectId) + '&limit=100';
        const unfiltered = await auditRequest(owner, route, token, unfilteredPath);
        const signingEvent = unfiltered.data?.events?.find(event => event.event_type === 'mapi.oauth.signing_key.rotated');
        if (unfiltered.status !== 200 || !signingEvent || signingEvent.project_id !== body.projectId || JSON.stringify(signingEvent.payload) !== '{}') throw Error('Unfiltered moved-project audit lost signing event');
        const signingRead = await auditRequest(owner, route, token, '/api/v1/events/' + encodeURIComponent(signingEvent.id) + '?project_id=' + encodeURIComponent(body.projectId));
        if (signingRead.status !== 200 || signingRead.data?.event_type !== signingEvent.event_type || signingRead.data?.id !== signingEvent.id || JSON.stringify(signingRead.data?.payload) !== '{}') throw Error('Signing event direct read failed');
        const first = await auditRequest(owner, route, token, path);
        if (first.status !== 200 || !first.data?.next_page_token || first.data?.events?.length !== 10) throw Error('Go audit first page unavailable');
        const second = await auditRequest(owner, route, token, path + '&page_token=' + encodeURIComponent(first.data.next_page_token));
        if (second.status !== 200 || !second.data?.next_page_token || second.data?.events?.length !== 10) throw Error('Go audit second page unavailable');
        const sampled = [...first.data.events, ...second.data.events];
        if (new Set(sampled.map(event => event.id)).size !== 20 || sampled.some(event => !event.id.startsWith('evt_bulk_') || event.event_type !== 'user.created' || event.project_id !== body.projectId || event.payload?.attributes?.detail !== 'x'.repeat(1400))) throw Error('Go audit page data differs');
        const last = await auditRequest(owner, route, token, '/api/v1/events/' + encodeURIComponent(eventId(body.lastEvent)) + '?project_id=' + encodeURIComponent(body.projectId));
        if (last.status !== 200 || last.data?.id !== eventId(body.lastEvent) || last.data?.payload?.attributes?.detail !== 'x'.repeat(1400)) throw Error('Go audit seeded event read failed');
        const foreign = await auditRequest(owner, route, otherToken, path);
        if (![401, 403, 404].includes(foreign.status)) throw Error('Other project credential was accepted');
        const otherPath = '/api/v1/events?project_id=' + encodeURIComponent(body.otherProject) + '&limit=100';
        const otherAudit = await auditRequest(other, otherRoute, otherToken, otherPath);
        if (otherAudit.status !== 200) {
          const signing = await auditRequest(other, otherRoute, otherToken, otherPath + '&event_type=mapi.oauth.signing_key.rotated');
          throw Error('Unfiltered other-project audit failed: ' + JSON.stringify({ status: otherAudit.status, code: otherAudit.data?.code, signingKeyEventStatus: signing.status }));
        }
        if (otherAudit.status !== 200 || !otherAudit.data?.events?.length || otherAudit.data.events.some(event => event.project_id !== body.otherProject || event.id.startsWith('evt_bulk_'))) throw Error('Other project audit is unavailable or leaked: ' + JSON.stringify({ status: otherAudit.status, count: otherAudit.data?.events?.length ?? null, foreignProjectCount: otherAudit.data?.events?.filter(event => event.project_id !== body.otherProject).length ?? null, seededCount: otherAudit.data?.events?.filter(event => event.id.startsWith('evt_bulk_')).length ?? null }));
        if (!otherAudit.data.events.some(event => event.event_type === 'mapi.oauth.signing_key.rotated' && JSON.stringify(event.payload) === '{}')) throw Error('Other project signing event missing');
        const otherForeign = await auditRequest(other, otherRoute, token, otherPath);
        if (![401, 403, 404].includes(otherForeign.status)) throw Error('Moved project credential was accepted by other project');
        return Response.json({ first, second, last, signingRead });
      }
      if (body.action === 'auditGuard') {
        const routeRow = await registry.resolve(origin);
        const route = { projectId: routeRow.project_id, origin: routeRow.origin, objectName: routeRow.object_name, generation: routeRow.generation };
        const owner = env.NEXTGEN_APPLICATION.getByName(route.objectName), token = await owner.testManagementToken(route);
        const get = async path => owner.handleRequest({ method: 'GET', url: route.origin + path, headers: { authorization: ['Bearer ' + token], accept: ['application/json'] }, body: '', peer: '127.0.0.1' }, route);
        const before = await owner.counts(body.projectId);
        let result;
        try {
          await owner.insertMalformedAuditForTest(body.projectId, 'evt_guard_duplicate', 'mapi.oauth.logout_uri.registered', '{"uri":"LOCAL_DUPLICATE_FIRST","uri":"LOCAL_DUPLICATE_SECOND"}');
          const duplicate = await get('/api/v1/events/evt_guard_duplicate?project_id=' + encodeURIComponent(body.projectId));
          const duplicateList = await get('/api/v1/events?project_id=' + encodeURIComponent(body.projectId) + '&limit=100');
          await owner.removeMalformedAuditForTest(body.projectId);
          await owner.insertMalformedAuditForTest(body.projectId, 'evt_guard_unknown_field', 'mapi.oauth.signing_key.rotated', '{"unexpected":"LOCAL_ONLY_GUARD_SENTINEL"}');
          const field = await get('/api/v1/events/evt_guard_unknown_field?project_id=' + encodeURIComponent(body.projectId));
          const list = await get('/api/v1/events?project_id=' + encodeURIComponent(body.projectId) + '&limit=100');
          await owner.insertMalformedAuditForTest(body.projectId, 'evt_guard_unknown_type', 'mapi.unknown.future', '{}');
          const unknown = await get('/api/v1/events/evt_guard_unknown_type?project_id=' + encodeURIComponent(body.projectId));
          if ([field, list, unknown, duplicate, duplicateList].some(response => response.status !== 500)) throw Error('Unsupported audit data did not fail closed');
          for (const response of [field, list, unknown, duplicate, duplicateList]) if (response.body && /LOCAL_ONLY_GUARD_SENTINEL|LOCAL_DUPLICATE_FIRST|LOCAL_DUPLICATE_SECOND/.test(new TextDecoder().decode(Uint8Array.fromBase64(response.body)))) throw Error('Audit error exposed payload');
          result = { unsupportedFieldGet: field.status, unsupportedFieldList: list.status, unknownTypeGet: unknown.status, duplicateFieldGet: duplicate.status, duplicateFieldList: duplicateList.status };
        } finally { await owner.removeMalformedAuditForTest(body.projectId); }
        if (JSON.stringify(await owner.counts(body.projectId)) !== JSON.stringify(before)) throw Error('Fault probe changed project counts');
        return Response.json(result);
      }
      if (body.action === 'counts') return Response.json(await env.NEXTGEN_APPLICATION.getByName(body.name).counts(body.projectId));
      if (body.action === 'databaseSize') return Response.json(await env.NEXTGEN_APPLICATION.getByName(body.name).databaseSize());
      if (body.action === 'bulkLogin') {
        const route = { projectId: body.projectId, origin, objectName: sourceName, generation: 1 };
        const result = await source.login('bulk-0@example.invalid', 'Real-source-password-123!', 'fixture', route);
        if (result.status !== 200 || !result.cookie) return Response.json({ status: result.status, sessionUserMatches: false, diagnostics: await source.bulkLoginDiagnostics(body.projectId, body.userId) });
        const session = await source.session(result.cookie.split(';', 1)[0], 'read', '', route);
        return Response.json({ status: result.status, sessionUserMatches: session.status === 200 && session.data?.project_id === body.projectId && session.data?.user_id === userId(0) });
      }
      if (body.action === 'advance') {
        const delayResponse = body.testDelayAfterAdvance === true;
        if (delayResponse && (env.MAPI_LOCAL_TEST !== '1' || env.MAPI_LOCAL_TIMEOUT_REGRESSION !== '1' || new URL(request.url).hostname !== '127.0.0.1')) throw Error('Local timeout test disabled');
        const [progress, isolation] = await Promise.all([
          coordinator.advance('large-move-secret', origin, body.projectId, moveId),
          other.session(body.otherCookie, 'read', '', { projectId: body.otherProject, origin: otherOrigin, objectName: otherName, generation: 1 }),
        ]);
        if (isolation.status !== 200) throw Error('Other project session failed during move');
        // Delay only after both local RPCs completed: model a lost response
        // without changing owner state or retrying the operation.
        if (delayResponse) {
          console.error('LOCAL_TIMEOUT_TEST_DELAY_REACHED');
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
        return Response.json(progress);
      }
      const status = await registry.relocationStatus('large-move-secret', body.projectId);
      const { move } = status;
      if (!move || move.move_id !== moveId) throw Error('Move is unavailable');
      if (body.action === 'moveStatus') {
        return Response.json({ storedRouteState: status.route?.state ?? null, phase: status.move?.phase ?? null, finalized: status.move?.finalized === true });
      }
      const target = env.NEXTGEN_APPLICATION.getByName(move.destination_object);
      if (body.action === 'exportStatus') return Response.json(await source.exportStatus(body.projectId));
      if (body.action === 'importStatus') return Response.json(await target.importStatus(body.projectId));
      if (body.action === 'exportStats') return Response.json(await source.exportStats(body.projectId));
      if (body.action === 'peek') return Response.json(await source.exportRelocationChunk('large-move-secret', body.projectId, moveId, body.index));
      if (body.action === 'failExport') return Response.json(await source.failExport(body.projectId, body.index));
      if (body.action === 'failImport') {
        const part = await source.exportRelocationChunk('large-move-secret', body.projectId, moveId, body.index);
        return Response.json(await target.failImport(body.projectId, part));
      }
      if (body.action === 'corruptImport') {
        const part = await source.exportRelocationChunk('large-move-secret', body.projectId, moveId, body.index);
        return Response.json(await target.replayImport(body.projectId, { ...part, content: part.content + ' ' }));
      }
      if (body.action === 'replayImport') {
        const part = await source.exportRelocationChunk('large-move-secret', body.projectId, moveId, body.index);
        return Response.json(await target.replayImport(body.projectId, part) ?? true);
      }
      if (body.action === 'evictSource') return Response.json(await source.evict());
      if (body.action === 'evictTarget') return Response.json(await target.evict());
      if (body.action === 'evidence') return Response.json(await coordinator.evidence('large-move-secret', body.projectId, moveId, body.after));
      if (body.action === 'verify') {
        const routeRow = await registry.resolve(origin);
        const route = { projectId: routeRow.project_id, origin: routeRow.origin, objectName: routeRow.object_name, generation: routeRow.generation };
        if (route.projectId !== body.projectId || route.generation !== 2) throw Error('Moved route identity differs');
        const moved = env.NEXTGEN_APPLICATION.getByName(route.objectName);
        const active = await moved.session(body.cookie, 'read', '', route);
        const revoked = await moved.session(body.revokedCookie, 'read', '', route);
        const login = await moved.login('real-source@example.test', 'Real-source-password-123!', 'fixture', route);
        const bulkLogin = await moved.login('bulk-0@example.invalid', 'Real-source-password-123!', 'fixture', route);
        const bulkSession = bulkLogin.status === 200 && bulkLogin.cookie ? await moved.session(bulkLogin.cookie.split(';', 1)[0], 'read', '', route) : null;
        const otherRoute = { projectId: body.otherProject, origin: otherOrigin, objectName: otherName, generation: 1 };
        const foreign = await other.login('real-source@example.test', 'Real-source-password-123!', 'fixture', otherRoute);
        const foreignBulk = await other.login('bulk-0@example.invalid', 'Real-source-password-123!', 'fixture', otherRoute);
        const otherSession = await other.session(body.otherCookie, 'read', '', otherRoute);
        const jwksResult = await moved.oauthRequest({ method: 'GET', url: `${origin}/oauth/${body.projectId}/jwks`, headers: {}, body: '', peer: '192.0.2.9' }, route);
        if (jwksResult.status !== 200) throw Error('Destination JWKS request failed');
        const jwks = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(jwksResult.body)));
        if (JSON.stringify(jwks) !== JSON.stringify(body.jwks)) throw Error('JWKS changed during move');
        if (JSON.stringify(await moved.keyRows()) !== JSON.stringify([{ project_id: body.projectId, key_id: body.sourceKeyId }]) || JSON.stringify(await other.keyRows()) !== JSON.stringify([{ project_id: body.otherProject, key_id: body.otherKeyId }])) throw Error('Issuer key IDs changed or leaked');
        await verifyMovedSigning(moved, route, body.cookie, body.client, jwks, body.sourceKeyId, body.userId);
        let staleRejected = false;
        try { await source.addUser('stale@example.invalid', 'Stale-password-123!', { projectId: body.projectId, origin, objectName: sourceName, generation: 1 }); }
        catch (error) { staleRejected = String(error).includes('Owner is fenced or route is stale'); }
        return Response.json({ projectId: route.projectId, objectName: route.objectName, generation: route.generation, active: active.status, revoked: revoked.status, login: login.status, bulkLogin: bulkLogin.status, bulkSessionMatched: bulkSession?.status === 200 && bulkSession.data?.project_id === body.projectId && bulkSession.data?.user_id === userId(0), foreign: foreign.status, foreignBulk: foreignBulk.status, otherSession: otherSession.status, staleRejected, fk: await moved.fk(), counts: await moved.counts(body.projectId), movedOverlapEmail: await moved.overlapEmail(body.projectId), otherOverlapEmail: await other.overlapEmail(body.otherProject) });
      }
      throw Error('Unknown action');
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
};
