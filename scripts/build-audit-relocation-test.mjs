// Builds a disposable local-only event-capable relocation owner. The event
// graph exceeds the Phase 1 upload budget and must never be deployed.
import { readFile, writeFile } from 'node:fs/promises';

await import('./build-events-combined-test.mjs');
const appPath = 'worker/generated/events-combined-test-app.js';
let app = await readFile(appPath, 'utf8');
if (!app.includes('  testManagementToken(route) {') || !app.includes('if (!this.#admitRoute(route)) throw new Error("Invalid test route");')) throw Error('Fenced local token hook missing');

let worker = await readFile('scripts/real-relocation-test-worker.mjs', 'utf8');
const add = (anchor, extra) => {
  if (!worker.includes(anchor)) throw Error('Audit relocation source anchor missing');
  worker = worker.replace(anchor, extra + anchor);
};
worker = worker.replace('import { NextgenApplication } from "../worker/app.js";', 'import { NextgenApplication } from "./events-combined-test-app.js";');
worker = worker.replaceAll('from "../worker/', 'from "../');
add('  schemaVersion() {', `  claimAuditForTest(projectId, suffix) {
    if (this.env.MAPI_LOCAL_TEST !== "1" || this.projectId() !== projectId) throw Error("Invalid audit fixture");
    const team = "team_audit_" + suffix, sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT INTO teams (project_id,id,name,created_at,updated_at) VALUES (?,?,?,1,1)", projectId, team, "Local audit fixture");
      sql.exec("INSERT INTO authz_assignments (id,project_id,catalog_id,principal_type,principal_id,object_type,relation,scope_kind,created_at,updated_at) VALUES (?,?,'cat_sys_1','team',?,'project','team','project',1,1)", "audit_grant_" + suffix, projectId, team);
    });
  }
  auditIdsForTest(projectId) { return this.ctx.storage.sql.exec("SELECT id FROM events WHERE project_id = ? ORDER BY id", projectId).toArray().map(row => row.id); }
  userAuditIdForTest(projectId, userId) { return this.ctx.storage.sql.exec("SELECT id FROM events WHERE project_id = ? AND entity_id = ? AND event_type = 'user.created'", projectId, userId).one().id; }
`);
add('      const sourceCounts = await source.testCounts(), tables = await source.manifest();', `      await source.claimAuditForTest(projectId, 'source');
      await other.claimAuditForTest(otherProject, 'other');
      const sourceToken = await source.testManagementToken(route), otherToken = await other.testManagementToken(otherRoute);
      const auditRequest = async (owner, authority, token, path) => {
        const response = await owner.handleRequest({ method: "GET", url: authority.origin + path, headers: { authorization: ["Bearer " + token], accept: ["application/json"] }, body: "", peer: "127.0.0.1" }, authority);
        let data = null;
        if (response.body) data = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(response.body)));
        return { status: response.status, data };
      };
      const sourceAuditIds = await source.auditIdsForTest(projectId);
      check(sourceAuditIds.length > 0, "No real Go-created user audit event");
      const sourceAuditPath = "/api/v1/events?project_id=" + encodeURIComponent(projectId) + "&limit=100";
      const sourceAudit = await auditRequest(source, route, sourceToken, sourceAuditPath);
      check(sourceAudit.status === 200 && !sourceAudit.data?.next_page_token && Array.isArray(sourceAudit.data?.events) && JSON.stringify(sourceAudit.data.events.map(event => event.id).sort()) === JSON.stringify(sourceAuditIds), "Go source audit list differs from actual historical rows");
      const userAuditId = await source.userAuditIdForTest(projectId, user.userId);
      check(sourceAuditIds.includes(userAuditId), "Go-created user audit is absent");
      const eventPath = "/api/v1/events/" + encodeURIComponent(userAuditId) + "?project_id=" + encodeURIComponent(projectId);
      const sourceEvent = await auditRequest(source, route, sourceToken, eventPath);
      check(sourceEvent.status === 200 && sourceEvent.data?.id === userAuditId, "Go source audit event read failed");
`);
add('      const movedCounts = await target.testCounts();', `      const movedAudit = await auditRequest(target, next, sourceToken, sourceAuditPath);
      const movedEvent = await auditRequest(target, next, sourceToken, eventPath);
      const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
      const auditJsonKeyOrderDiffers = JSON.stringify(movedAudit.data) !== JSON.stringify(sourceAudit.data);
      if (JSON.stringify(canonical(movedAudit.data)) !== JSON.stringify(canonical(sourceAudit.data))) {
        const before = sourceAudit.data?.events ?? [], after = movedAudit.data?.events ?? [];
        const byId = new Map(before.map(e => [e.id, e]));
        const fields = new Set();
        for (const event of after) {
          const prior = byId.get(event.id);
          if (!prior) continue;
          for (const key of new Set([...Object.keys(prior), ...Object.keys(event)])) if (JSON.stringify(canonical(prior[key])) !== JSON.stringify(canonical(event[key]))) fields.add(key);
        }
        throw Error("Go audit comparison: " + JSON.stringify({ status: movedAudit.status, before: before.length, after: after.length, identicalIdSet: JSON.stringify(before.map(e => e.id).sort()) === JSON.stringify(after.map(e => e.id).sort()), equalWhenSorted: JSON.stringify(canonical([...before].sort((a, b) => a.id.localeCompare(b.id)))) === JSON.stringify(canonical([...after].sort((a, b) => a.id.localeCompare(b.id)))), differingFields: [...fields].sort() }));
      }
      check(movedAudit.status === 200, "Go audit history unavailable after relocation");
      check(movedEvent.status === 200 && JSON.stringify(canonical(movedEvent.data)) === JSON.stringify(canonical(sourceEvent.data)), "Go audit event changed after relocation");
      check([401, 403, 404].includes((await auditRequest(target, next, otherToken, sourceAuditPath)).status), "Other project credential was not rejected by the audit handler");
      const otherAuditPath = "/api/v1/events?project_id=" + encodeURIComponent(otherProject) + "&limit=100";
      const otherAudit = await auditRequest(other, otherRoute, otherToken, otherAuditPath);
      const otherIds = await other.auditIdsForTest(otherProject);
      check(otherAudit.status === 200 && !otherAudit.data?.next_page_token && otherIds.length > 0 && Array.isArray(otherAudit.data?.events) && JSON.stringify(otherAudit.data.events.map(event => event.id).sort()) === JSON.stringify(otherIds) && otherAudit.data.events.every(event => !sourceAuditIds.includes(event.id)), "Other project audit read leaked or lost events");
      check([401, 403, 404].includes((await auditRequest(other, otherRoute, sourceToken, otherAuditPath)).status), "Moved project credential was not rejected by the other audit handler");
`);
worker = worker.replace('return Response.json({ ok: true, tables: tables.length, users: movedCounts.users, events: movedCounts.events });', 'return Response.json({ ok: true, tables: tables.length, users: movedCounts.users, events: movedCounts.events, goAuditRead: true, auditIsolation: true, auditJsonKeyOrderDiffers });');
await writeFile('worker/generated/audit-relocation-test-worker.mjs', worker);
const config = JSON.parse(await readFile('scripts/real-relocation-test.wrangler.jsonc', 'utf8'));
config.name = 'mapi-audit-relocation-local-test';
config.main = 'audit-relocation-test-worker.mjs';
await writeFile('worker/generated/audit-relocation-test.wrangler.jsonc', JSON.stringify(config, null, 2));
console.log('Built local-only audit relocation test owner.');
