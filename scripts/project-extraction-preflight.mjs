// Read-only, local investigation helper. This does not authorize or perform an export.
// It intentionally fails closed on unknown schema and unresolved principal kinds.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const identifier = value => '"' + value.replaceAll('"', '""') + '"';
function tables(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x => x.name);
}
function columns(db, name) {
  return db.prepare(`PRAGMA table_xinfo(${identifier(name)})`).all().map(({ name, type, notnull, pk, hidden }) => ({ name, type, notnull, pk, hidden }));
}
export function inspectProjectExtraction(db, projectId, baselineStatements) {
  if (typeof projectId !== 'string' || !projectId) throw new Error('Project ID required');
  const expected = new DatabaseSync(':memory:');
  try {
    for (const statement of baselineStatements) expected.exec(statement);
    const expectedTables = tables(expected), actualTables = tables(db);
    const unknownTables = actualTables.filter(name => !expectedTables.includes(name));
    const missingTables = expectedTables.filter(name => !actualTables.includes(name));
    const changedTables = expectedTables.filter(name => actualTables.includes(name) && JSON.stringify(columns(db, name)) !== JSON.stringify(columns(expected, name)));
    const schemaComplete = unknownTables.length === 0 && missingTables.length === 0 && changedTables.length === 0;
    const issues = { unknownTables, missingTables, changedTables, projectRows: 0, inboundUserGrants: 0, inboundTeamGrants: 0, outboundUserGrants: 0, outboundTeamGrants: 0, ambiguousPrincipalIds: 0, unresolvedMembershipUsers: 0, unresolvedLifecycleTeams: 0, unsupportedPrincipalGrants: 0, outsideUnsupportedPrincipalGrants: 0, appGroupCatalogs: 0, sharedEventSinks: 0 };
    if (schemaComplete) {
      issues.projectRows = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id=?').get(projectId).n;
      for (const [kind, table, inboundField, outboundField] of [['user', 'users', 'inboundUserGrants', 'outboundUserGrants'], ['team', 'teams', 'inboundTeamGrants', 'outboundTeamGrants']]) {
        const queryInbound = `SELECT COUNT(*) AS n FROM authz_assignments a WHERE a.project_id=? AND a.principal_type=? AND NOT EXISTS (SELECT 1 FROM ${identifier(table)} p WHERE p.project_id=a.project_id AND p.id=a.principal_id)`;
        const queryOutbound = `SELECT COUNT(*) AS n FROM authz_assignments a WHERE a.project_id<>? AND a.principal_type=? AND EXISTS (SELECT 1 FROM ${identifier(table)} p WHERE p.project_id=? AND p.id=a.principal_id)`;
        issues[inboundField] = db.prepare(queryInbound).get(projectId, kind).n;
        issues[outboundField] = db.prepare(queryOutbound).get(projectId, kind, projectId).n;
        const queryAmbiguous = `SELECT COUNT(*) AS n FROM authz_assignments a WHERE a.project_id=? AND a.principal_type=? AND EXISTS (SELECT 1 FROM ${identifier(table)} p WHERE p.project_id=? AND p.id=a.principal_id) AND EXISTS (SELECT 1 FROM ${identifier(table)} p WHERE p.project_id<>? AND p.id=a.principal_id)`;
        issues.ambiguousPrincipalIds += db.prepare(queryAmbiguous).get(projectId, kind, projectId, projectId).n;
      }
      issues.unresolvedMembershipUsers = db.prepare("SELECT COUNT(*) AS n FROM authz_membership_edges e WHERE e.project_id=? AND NOT EXISTS (SELECT 1 FROM users u WHERE u.project_id=e.project_id AND u.id=e.member_id)").get(projectId).n;
      issues.unresolvedLifecycleTeams = db.prepare("SELECT COUNT(*) AS n FROM users u WHERE u.project_id=? AND u.lifecycle_owner_team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.project_id=u.project_id AND t.id=u.lifecycle_owner_team_id)").get(projectId).n;
      // The owner and lifetime of these principal kinds need separate native analysis.
      issues.unsupportedPrincipalGrants = db.prepare("SELECT COUNT(*) AS n FROM authz_assignments WHERE project_id=? AND principal_type NOT IN ('user','team')").get(projectId).n;
      issues.outsideUnsupportedPrincipalGrants = db.prepare("SELECT COUNT(*) AS n FROM authz_assignments WHERE project_id<>? AND principal_type NOT IN ('user','team')").get(projectId).n;
      issues.appGroupCatalogs = db.prepare("SELECT COUNT(*) AS n FROM authz_catalogs WHERE catalog_kind <> 'system'").get().n;
      issues.sharedEventSinks = db.prepare('SELECT COUNT(*) AS n FROM event_sinks WHERE project_id IS NULL').get().n;
    }
    return { schemaComplete, issues, safeToExport: false,
      reason: 'Preflight only: reference-data closure, opaque payloads, all cross-project dependencies and source-write fencing remain unproven.' };
  } finally { expected.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/project-extraction-preflight.mjs SQLITE_DB PROJECT_ID');
  const db = new DatabaseSync(process.argv[2], { readOnly: true });
  try {
    const baseline = JSON.parse(readFileSync('worker/generated/baseline.json', 'utf8'));
    console.log(JSON.stringify(inspectProjectExtraction(db, process.argv[3], baseline.statements), null, 2));
  } finally { db.close(); }
}
