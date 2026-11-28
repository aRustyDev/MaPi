// The manifest describes a single, fenced project object using the pinned
// baseline. Control calls that use it must be private and authenticated.
import baseline from './generated/baseline.json';
import issuerSchema from './relocation-issuer-schema.json';
import { assertRelocationTableText, execute, readRelocationRow, readRelocationBlobSlice, readRelocationDescriptors } from './sql.js';
import { assertNoForeignKeyViolations } from './foreign-keys.js';
import { sourceIdentityMatches } from './relocation-source-identity.js';
import { assertRelocationValuesRepresentable, RELOCATION_RECONCILIATION_VERSION } from './relocation-values.js';
import { readOwnerRecoveryScopes, validRecoveryStamp } from './recovery-scopes.js';
import { readRelocationSequences } from './relocation-sequences.js';
import { readTextPreflightMarker } from './relocation-text-marker.js';
import { validReconciliationCursor, validReconciliationKeys, consumeReconciliationUtf8 } from './relocation-reconcile-cursor.js';

const SHARED_TABLES = new Set([
  'authz_bundle_members', 'authz_bundles', 'authz_catalogs',
  'authz_expression_edges', 'authz_relation_closure',
  'authz_relation_references', 'authz_relations', 'goose_db_version',
]);
const RUNTIME_TABLES = new Set([
  'mapi_project', 'mapi_login_limits', 'mapi_project_origin',
  'mapi_schema_version', 'mapi_schema_history', 'mapi_recovery_epoch', 'mapi_revision_clock', 'mapi_revision_scopes',
]);
const RUNTIME_SCHEMA = {
  mapi_project: 'CREATE TABLE mapi_project (project_id TEXT PRIMARY KEY, schema_url TEXT NOT NULL)',
  mapi_login_limits: 'CREATE TABLE mapi_login_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)',
  mapi_project_origin: 'CREATE TABLE mapi_project_origin (origin TEXT NOT NULL)',
  mapi_schema_version: 'CREATE TABLE mapi_schema_version (version INTEGER PRIMARY KEY)',
  mapi_schema_history: 'CREATE TABLE mapi_schema_history (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  mapi_recovery_epoch: 'CREATE TABLE mapi_recovery_epoch (epoch TEXT NOT NULL)',
  mapi_revision_clock: 'CREATE TABLE mapi_revision_clock (id INTEGER PRIMARY KEY CHECK (id = 1), stamp INTEGER NOT NULL)',
  mapi_revision_scopes: 'CREATE TABLE mapi_revision_scopes (scope TEXT PRIMARY KEY, stamp INTEGER NOT NULL)',
};
const CONTROL_TABLES = new Set([
  'mapi_owner_fence', 'mapi_destination_reservation', 'mapi_relocation_project',
  'mapi_relocation_prepared', 'mapi_chunk_export', 'mapi_chunk_export_data',
  'mapi_chunk_import', 'mapi_chunk_import_data', 'mapi_chunk_import_fragment',
  'mapi_chunk_import_fragment_data', 'mapi_chunk_import_stream', 'mapi_chunk_import_stream_data',
  'mapi_relocation_text_preflight_seal',
]);
const ISSUER_SINGLETONS = new Set(['mapi_oauth_schema', 'mapi_private_par_schema', 'mapi_fapi_prompts']);
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const first = (storage, sql, ...args) => storage.sql.exec(sql, ...args).toArray()[0];
const toArgs = values => values.map(value => value && typeof value === 'object' && 'integer' in value
  ? { kind: 'int', value: value.integer }
  : value && typeof value === 'object' && 'blob' in value
    ? { kind: 'blob', value: value.blob }
    : { kind: 'value', value });

function pinnedSchema() {
  const expected = [];
  for (const sql of baseline.statements) {
    const match = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF NOT EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i.exec(sql);
    if (match) expected.push({ type: match[1].toLowerCase(), name: match[2] ?? match[3], sql: sql.replace(/;\s*$/, '') });
    else if (!/^INSERT\s+INTO\s+/i.test(sql)) throw Error('Unsupported pinned baseline statement');
  }
  return expected;
}

function schemaObjects(storage, expected) {
  // Bound data returned to JS even when a corrupt or unreviewed schema has
  // many objects or unusually large definitions. The count accommodates all
  // reviewed object names, including optional issuer and control objects.
  const maxObjects = expected.length + issuerSchema.length + RUNTIME_TABLES.size + CONTROL_TABLES.size + 1;
  const encoder = new TextEncoder();
  const maxDefinitionBytes = Math.max(16 * 1024, ...expected.map(item => encoder.encode(item.sql).length), ...issuerSchema.map(item => encoder.encode(item.sql).length), ...Object.values(RUNTIME_SCHEMA).map(sql => encoder.encode(sql).length));
  const maxIdentifierBytes = 1024;
  const rows = storage.sql.exec(`SELECT type,
    CASE WHEN length(CAST(name AS BLOB)) <= ? THEN name END AS name,
    CASE WHEN length(CAST(tbl_name AS BLOB)) <= ? THEN tbl_name END AS tbl_name,
    CASE WHEN length(CAST(sql AS BLOB)) <= ? THEN sql END AS sql
    FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name <> '__miniflare_do_name'
    ORDER BY type, name LIMIT ?`, maxIdentifierBytes, maxIdentifierBytes, maxDefinitionBytes, maxObjects + 1).toArray();
  if (rows.length > maxObjects || rows.some(row => row.name === null || row.tbl_name === null || row.sql === null)) throw Error('Schema exceeds inspection bounds');
  return rows;
}

function schemaInventory(storage) {
  const expected = pinnedSchema();
  const actual = schemaObjects(storage, expected);
  const expectedNames = new Set(expected.map(item => item.name));
  const issuerObjects = new Map(issuerSchema.map(item => [item.name, item]));
  const objects = new Map(actual.map(item => [item.name, item]));
  for (const item of expected) {
    const found = objects.get(item.name);
    if (!found || found.type !== item.type || found.sql !== item.sql) throw Error(`Pinned schema differs: ${item.name}`);
  }
  for (const item of actual) {
    if (expectedNames.has(item.name)) continue;
    if (item.name === 'mapi_relocation_text_preflight_marker') {
      if (item.type !== 'view' || readTextPreflightMarker(storage) === null) throw Error('Invalid TEXT preflight marker');
      continue;
    }
    const issuer = issuerObjects.get(item.name);
    if (issuer) {
      if (issuer.type !== item.type || issuer.tbl_name !== item.tbl_name || issuer.sql !== item.sql) throw Error(`Issuer schema differs: ${item.name}`);
      continue;
    }
    if (item.type === 'table' && RUNTIME_TABLES.has(item.name)) {
      if (item.sql !== RUNTIME_SCHEMA[item.name]) throw Error(`Runtime schema differs: ${item.name}`);
      continue;
    }
    if (item.type === 'table' && CONTROL_TABLES.has(item.name)) continue;
    if (item.type === 'index' && (RUNTIME_TABLES.has(item.tbl_name) || CONTROL_TABLES.has(item.tbl_name))) throw Error(`Unexpected runtime index: ${item.name}`);
    throw Error(`Unreviewed schema object: ${item.name}`);
  }
  for (const name of RUNTIME_TABLES) {
    if (!['mapi_schema_history', 'mapi_revision_clock', 'mapi_revision_scopes'].includes(name) && !objects.has(name)) throw Error(`Missing runtime table: ${name}`);
  }
  for (const item of issuerSchema) {
    if (item.type === 'index' && objects.has(item.tbl_name) && !objects.has(item.name)) throw Error(`Missing issuer index: ${item.name}`);
  }
  return actual.filter(item => expectedNames.has(item.name) || RUNTIME_TABLES.has(item.name) || issuerObjects.has(item.name));
}

// Advisory schema check before the fence; full inspection repeats after freezing.
export function validateRelocationSourceSchema(storage, route, { textGuard = false } = {}) {
  const schema = schemaInventory(storage);
  const metadata = readSourceSchemaMetadata(storage, schema);
  validateSourceRecoveryEpoch(storage);
  validateSourceOrigin(storage, route.origin);
  validateSourceProjectIdentity(storage, route.projectId);
  assertSourceSchemaHistory(metadata);
  if (metadata.clockPresent) validateSourceClockRecord(storage);
  assertSourceClockPair(metadata);
  if (!textGuard) validateSourceText(storage, schema);
  return schema.filter(item => item.type === 'table').map(item => item.name);
}

function validateSourceText(storage, schema) {
  for (const { type, name } of schema) {
    if (type === 'table') assertRelocationTableText(storage, name);
  }
}

// A single-project owner must not freeze until its two project identities
// agree. LIMIT 2 preserves the singleton check while bounding returned rows.
function validateSourceProjectIdentity(storage, projectId) {
  if (!sourceIdentityMatches(storage, 'project', projectId)) throw Error('Project object contains an unexpected project');
  if (!sourceIdentityMatches(storage, 'owner', projectId)) throw Error('Owner project identity differs');
}

export function validateSourceRecoveryEpoch(storage) {
  const epochs = storage.sql.exec(`SELECT CASE
    WHEN typeof(epoch) = 'text' AND length(CAST(epoch AS BLOB)) BETWEEN 1 AND 128
    THEN CAST(epoch AS BLOB) END AS bytes FROM mapi_recovery_epoch LIMIT 2`).toArray();
  if (epochs.length !== 1 || epochs[0].bytes === null) throw Error('Invalid recovery epoch');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(epochs[0].bytes);
  } catch {
    throw Error('Invalid recovery epoch');
  }
}

function validateSourceOrigin(storage, origin) {
  if (!sourceIdentityMatches(storage, 'origin', origin)) throw Error('Project origin differs');
}

// The pre-freeze check is advisory: callers must still repeat it after the
// source is fenced. Read at most two version records so malformed singleton
// metadata cannot force an unbounded result allocation.
function readSourceSchemaMetadata(storage, schema) {
  const versions = storage.sql.exec('SELECT version FROM mapi_schema_version LIMIT 2').toArray();
  if (versions.length !== 1 || ![baseline.version, 2].includes(versions[0].version)) throw Error('Unsupported application schema version');
  const tables = new Set(schema.filter(item => item.type === 'table').map(item => item.name));
  const historyPresent = tables.has('mapi_schema_history');
  const clockPresent = tables.has('mapi_revision_clock');
  const scopesPresent = tables.has('mapi_revision_scopes');
  return { schemaVersion: versions[0].version, historyPresent, clockPresent, scopesPresent };
}

function assertSourceSchemaHistory({ schemaVersion, historyPresent }) {
  if ((schemaVersion === 2) !== historyPresent) throw Error('Application schema history differs');
}

function validateSourceClockRecord(storage) {
  const clock = execute(storage, { statement: 'SELECT id, stamp FROM mapi_revision_clock LIMIT 2', args: [], query: true }).rows;
  if (clock.length !== 1 || clock[0][0]?.integer !== '1' || !validRecoveryStamp(clock[0][1]?.integer)) throw Error('Invalid revision clock');
}

function assertSourceClockPair({ clockPresent, scopesPresent }) {
  if (clockPresent !== scopesPresent) throw Error('Revision clock tables must coexist');
}

function assertSourceFence(storage, route, moveId) {
  if (!route || !moveId || !Number.isSafeInteger(route.generation) || route.generation < 1) throw Error('Invalid source route');
  const fence = first(storage, 'SELECT project_id, origin, object_name, generation, state, move_id FROM mapi_owner_fence WHERE singleton = 1');
  if (!fence || fence.project_id !== route.projectId || fence.origin !== route.origin || fence.object_name !== route.objectName || fence.generation !== route.generation || fence.state !== 'frozen' || fence.move_id !== moveId) throw Error('Source is not frozen for this move');
}

function assertDestinationFence(storage, manifest) {
  const fence = first(storage, 'SELECT project_id, object_name, generation, state, move_id FROM mapi_relocation_project WHERE project_id = ?', manifest.projectId);
  if (!fence || fence.project_id !== manifest.projectId || fence.generation !== manifest.generation + 1 || fence.state !== 'staged' || fence.move_id !== manifest.moveId) throw Error('Destination is not staged for this move');
}

function validateOwnership(storage, projectId, tables) {
  validateSourceProjectIdentity(storage, projectId);
  for (const table of tables) {
    if (table === 'projects' || SHARED_TABLES.has(table) || RUNTIME_TABLES.has(table) || ISSUER_SINGLETONS.has(table)) continue;
    const columns = storage.sql.exec(`PRAGMA table_xinfo(${quote(table)})`).toArray();
    if (!columns.some(column => column.name === 'project_id')) throw Error(`Table lacks reviewed ownership: ${table}`);
    if (first(storage, `SELECT 1 FROM ${quote(table)} WHERE project_id IS NULL OR project_id <> ? LIMIT 1`, projectId)) throw Error(`Foreign or global row in ${table}`);
  }
  if (first(storage, "SELECT 1 FROM authz_catalogs WHERE id <> 'cat_sys_1' OR catalog_kind <> 'system' OR owner_id <> 'system' LIMIT 1")) throw Error('Unreviewed authorization catalog');
  if (first(storage, "SELECT 1 FROM authz_assignments a WHERE (a.principal_type = 'user' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.project_id = a.project_id AND u.id = a.principal_id)) OR (a.principal_type = 'team' AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.project_id = a.project_id AND t.id = a.principal_id)) OR (a.principal_type = 'sk_proj' AND a.principal_id <> a.project_id) OR a.principal_type NOT IN ('user', 'team', 'sk_proj') LIMIT 1")) throw Error('Unresolved or unsupported assignment principal');
  if (first(storage, "SELECT 1 FROM authz_membership_edges e WHERE e.member_type <> 'user' OR e.set_type <> 'team' OR NOT EXISTS (SELECT 1 FROM users u WHERE u.project_id = e.project_id AND u.id = e.member_id) OR NOT EXISTS (SELECT 1 FROM teams t WHERE t.project_id = e.project_id AND t.id = e.set_id) LIMIT 1")) throw Error('Unresolved or unsupported membership');
  const names = new Set(tables);
  for (const table of ISSUER_SINGLETONS) {
    if (!names.has(table)) continue;
    if (table === 'mapi_fapi_prompts') {
      if (!names.has('mapi_fapi_policy_bindings')) {
        if (first(storage, 'SELECT 1 FROM mapi_fapi_prompts LIMIT 1')) throw Error('Unresolved FAPI prompt');
      } else if (first(storage, "SELECT 1 FROM mapi_fapi_prompts p WHERE p.kind NOT IN ('par', 'login') OR NOT EXISTS (SELECT 1 FROM mapi_fapi_policy_bindings b WHERE b.project_id = ? AND b.kind = p.kind AND b.token_hash = p.token_hash) LIMIT 1", projectId)) {
        throw Error('Unresolved FAPI prompt');
      }
      continue;
    }
    const marker = storage.sql.exec(`SELECT singleton, version FROM ${quote(table)}`).toArray();
    const maximum = table === 'mapi_oauth_schema' ? 4 : 9;
    if (marker.length !== 1 || marker[0].singleton !== 1 || !Number.isInteger(marker[0].version) || marker[0].version < 1 || marker[0].version > maximum) throw Error(`Unsupported issuer schema version: ${table}`);
  }
  assertNoForeignKeyViolations(storage, 'Source violates foreign keys');
}


// Deleted entities can retain clocks, so validate project and call shape
// without requiring the referenced entity to still exist.
function validateRevisionScopes(storage, projectId) {
  let cursor = null, total = 0, page;
  do {
    try { page = readOwnerRecoveryScopes(storage.sql, projectId, cursor); }
    catch (error) {
      if (String(error).includes('Invalid recovery scope stamp') || String(error).includes('Invalid or foreign revision scope') || String(error).includes('Noncanonical revision scope')) throw Error('Invalid or foreign revision scope');
      throw error;
    }
    total += page.rows.length;
    cursor = page.cursor;
  } while (!page.done);
  if (!total) throw Error('Invalid or foreign revision scope');
}

function orderedTables(storage, names) {
  const pending = new Set(names);
  const ordered = [];
  while (pending.size) {
    let progressed = false;
    for (const name of [...pending]) {
      const columns = storage.sql.exec(`PRAGMA table_xinfo(${quote(name)})`).toArray();
      if (!columns.some(column => column.pk > 0)) throw Error(`Missing table primary key: ${name}`);
      const dependencies = storage.sql.exec(`PRAGMA foreign_key_list(${quote(name)})`).toArray().map(row => row.table).filter(table => table !== name);
      if (dependencies.some(table => !names.includes(table))) throw Error(`Unreviewed dependency for ${name}`);
      if (dependencies.some(table => pending.has(table))) continue;
      ordered.push(name);
      pending.delete(name);
      progressed = true;
    }
    if (!progressed) throw Error('Cyclic schema requires a coordinated importer');
  }
  return ordered;
}

// Prepare only a reserved, demonstrably empty owner. All DDL comes from the
// pinned build, never from the caller's manifest. The durable marker makes
// retries after the first imported row non-destructive.
export function prepareRelocationDestination(storage, manifest, route) {
  return storage.transactionSync(() => {
    if (!manifest || manifest.version !== 1 || !route || route.projectId !== manifest.projectId || route.origin !== manifest.origin || route.generation !== manifest.generation + 1 || !route.objectName || route.objectName === manifest.objectName || !manifest.moveId) throw Error('Invalid destination route');
    const reservation = first(storage, 'SELECT project_id, origin, object_name, generation, move_id FROM mapi_destination_reservation WHERE singleton = 1');
    if (!reservation || reservation.project_id !== route.projectId || reservation.origin !== route.origin || reservation.object_name !== route.objectName || reservation.generation !== route.generation || reservation.move_id !== manifest.moveId) throw Error('Destination reservation mismatch');
    const markerDDL = 'CREATE TABLE mapi_relocation_prepared (singleton INTEGER PRIMARY KEY, manifest TEXT NOT NULL, destination TEXT NOT NULL)';
    const marker = first(storage, "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_relocation_prepared'");
    if (marker) {
      if (marker.sql !== markerDDL) throw Error('Invalid preparation marker');
      const saved = first(storage, 'SELECT manifest, destination FROM mapi_relocation_prepared WHERE singleton = 1');
      if (!saved || saved.manifest !== JSON.stringify(manifest) || saved.destination !== JSON.stringify(route)) throw Error('Conflicting destination preparation');
      return;
    }
    if (first(storage, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name IN ('mapi_owner_fence', 'mapi_relocation_project')")) throw Error('Destination is not fresh');
    const existing = schemaInventory(storage);
    const existingNames = new Set(existing.map(item => item.name));
    if (!Array.isArray(manifest.schema) || !Array.isArray(manifest.tables) || ![baseline.version, 2].includes(manifest.schemaVersion)) throw Error('Invalid source manifest');
    const requested = new Set(manifest.schema.map(item => item.name));
    if (requested.has('mapi_revision_clock') && !existingNames.has('mapi_revision_clock')) storage.sql.exec(RUNTIME_SCHEMA.mapi_revision_clock);
    if (requested.has('mapi_revision_scopes') && !existingNames.has('mapi_revision_scopes')) storage.sql.exec(RUNTIME_SCHEMA.mapi_revision_scopes);
    for (const item of issuerSchema.filter(item => requested.has(item.name) && item.type === 'table' && !existingNames.has(item.name))) storage.sql.exec(item.sql);
    for (const item of issuerSchema.filter(item => requested.has(item.name) && item.type === 'index' && !existingNames.has(item.name))) storage.sql.exec(item.sql);
    const versions = storage.sql.exec('SELECT version FROM mapi_schema_version').toArray();
    if (versions.length !== 1 || versions[0].version !== baseline.version) throw Error('Destination application schema version differs');
    if (manifest.schemaVersion === 2) {
      storage.sql.exec(RUNTIME_SCHEMA.mapi_schema_history);
      storage.sql.exec('UPDATE mapi_schema_version SET version = 2');
    }
    const schema = schemaInventory(storage);
    if (JSON.stringify(schema) !== JSON.stringify(manifest.schema)) throw Error('Destination schema differs');
    const tables = orderedTables(storage, [...schema.filter(item => item.type === 'table' && !RUNTIME_TABLES.has(item.name)).map(item => item.name), 'mapi_project', 'mapi_login_limits', ...(manifest.schemaVersion === 2 ? ['mapi_schema_history'] : []), ...(requested.has('mapi_revision_clock') ? ['mapi_revision_clock'] : []), ...(requested.has('mapi_revision_scopes') ? ['mapi_revision_scopes'] : [])]);
    if (JSON.stringify(tables) !== JSON.stringify(manifest.tables)) throw Error('Destination table manifest differs');
    if (!baseline.referenceRows || Object.keys(baseline.referenceRows).length !== SHARED_TABLES.size) throw Error('Baseline reference manifest missing');
    for (const name of tables) {
      if (SHARED_TABLES.has(name)) {
        const expected = baseline.referenceRows[name];
        if (!expected) throw Error(`Missing reference rows: ${name}`);
        const actual = execute(storage, { statement: `SELECT ${expected.columns.map(quote).join(', ')} FROM ${quote(name)}`, args: [], query: true });
        actual.rows.sort((a, b) => { const left = JSON.stringify(a), right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; });
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`Destination reference rows differ: ${name}`);
      } else if (first(storage, `SELECT 1 FROM ${quote(name)} LIMIT 1`)) throw Error(`Destination contains records: ${name}`);
    }
    if (first(storage, 'SELECT 1 FROM mapi_project_origin LIMIT 1')) throw Error('Destination has an origin');
    const epochs = storage.sql.exec('SELECT epoch FROM mapi_recovery_epoch').toArray();
    if (epochs.length !== 1 || epochs[0].epoch !== '0') throw Error('Destination recovery epoch differs');
    for (const name of orderedTables(storage, [...SHARED_TABLES]).reverse()) storage.sql.exec(`DELETE FROM ${quote(name)}`);
    assertNoForeignKeyViolations(storage, 'Destination violates foreign keys');
    storage.sql.exec(markerDDL);
    storage.sql.exec('INSERT INTO mapi_relocation_prepared VALUES (1, ?, ?)', JSON.stringify(manifest), JSON.stringify(route));
  });
}

// Call after all writers have adopted the fence and the source has frozen.
export function inspectRelocationSource(storage, route, moveId, { textGuard = false } = {}) {
  return storage.transactionSync(() => {
    assertSourceFence(storage, route, moveId);
    const schema = schemaInventory(storage);
    const recoveryEpoch = validateSourceRecoveryEpoch(storage);
    if (!textGuard) validateSourceText(storage, schema);
    const pinnedTables = schema.filter(item => item.type === 'table' && !RUNTIME_TABLES.has(item.name)).map(item => item.name);
    validateOwnership(storage, route.projectId, pinnedTables);
    const { schemaVersion, historyPresent, clockPresent, scopesPresent } = readSourceSchemaMetadata(storage, schema);
    validateSourceOrigin(storage, route.origin);
    assertSourceSchemaHistory({ schemaVersion, historyPresent });
    if (clockPresent) validateSourceClockRecord(storage);
    assertSourceClockPair({ clockPresent, scopesPresent });
    if (scopesPresent) {
      validateRevisionScopes(storage, route.projectId);
      if (first(storage, 'SELECT 1 FROM mapi_revision_scopes WHERE stamp > (SELECT stamp FROM mapi_revision_clock WHERE id = 1) LIMIT 1')) throw Error('Revision clock is below a scope');
    }
    const tables = orderedTables(storage, [...pinnedTables, 'mapi_project', 'mapi_login_limits', ...(historyPresent ? ['mapi_schema_history'] : []), ...(clockPresent ? ['mapi_revision_clock'] : []), ...(scopesPresent ? ['mapi_revision_scopes'] : [])]);
    return { version: 1, projectId: route.projectId, origin: route.origin, objectName: route.objectName, generation: route.generation, moveId, schemaVersion, recoveryEpoch, tables, schema, sequences: readRelocationSequences(storage) };
  });
}

// Apply the separately represented origin, recovery epoch and AUTOINCREMENT
// metadata only after the destination has finished staging the row data.
export function restoreRelocationMetadata(storage, manifest) {
  return storage.transactionSync(() => {
    assertDestinationFence(storage, manifest);
    const versions = storage.sql.exec('SELECT version FROM mapi_schema_version').toArray();
    if (versions.length !== 1 || versions[0].version !== manifest.schemaVersion) throw Error('Destination application schema version differs');
    const origins = storage.sql.exec('SELECT origin FROM mapi_project_origin').toArray();
    if (origins.length > 1 || (origins.length === 1 && origins[0].origin !== manifest.origin)) throw Error('Destination origin conflicts');
    if (!origins.length) storage.sql.exec('INSERT INTO mapi_project_origin VALUES (?)', manifest.origin);
    const epochs = storage.sql.exec('SELECT epoch FROM mapi_recovery_epoch').toArray();
    if (epochs.length !== 1) throw Error('Invalid destination recovery epoch');
    if (epochs[0].epoch !== manifest.recoveryEpoch) storage.sql.exec('UPDATE mapi_recovery_epoch SET epoch = ?', manifest.recoveryEpoch);
    const existing = readRelocationSequences(storage);
    if (!Array.isArray(manifest.sequences) || JSON.stringify(existing.map(row => row[0])) !== JSON.stringify(manifest.sequences.map(row => row[0]))) throw Error('Destination SQLite sequences differ');
    for (const [name, value] of manifest.sequences) {
      if (name !== 'goose_db_version' || !value || typeof value.integer !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.integer) || BigInt(value.integer) > 9223372036854775807n) throw Error('Invalid source SQLite sequence');
      const result = execute(storage, { statement: 'UPDATE sqlite_sequence SET seq = ? WHERE name = ? AND seq <= ?', args: [{ kind: 'int', value: value.integer }, { kind: 'value', value: name }, { kind: 'int', value: value.integer }], query: false });
      if (result.changes !== 1) throw Error('Destination SQLite sequence is ahead of source');
    }
  });
}

// A coordinator compares this result to the source manifest before cutover.
export function inspectRelocationDestination(storage, manifest) {
  return storage.transactionSync(() => {
    assertDestinationFence(storage, manifest);
    const schema = schemaInventory(storage);
    validateOwnership(storage, manifest.projectId, schema.filter(item => item.type === 'table' && !RUNTIME_TABLES.has(item.name)).map(item => item.name));
    const versions = storage.sql.exec('SELECT version FROM mapi_schema_version').toArray();
    const epochs = storage.sql.exec('SELECT epoch FROM mapi_recovery_epoch').toArray();
    const origins = storage.sql.exec('SELECT origin FROM mapi_project_origin').toArray();
    if (versions.length !== 1 || versions[0].version !== manifest.schemaVersion || epochs.length !== 1 || epochs[0].epoch !== manifest.recoveryEpoch || origins.length !== 1 || origins[0].origin !== manifest.origin) throw Error('Destination metadata differs');
    if (JSON.stringify(schema) !== JSON.stringify(manifest.schema)) throw Error('Destination schema differs');
    if (JSON.stringify(readRelocationSequences(storage)) !== JSON.stringify(manifest.sequences)) throw Error('Destination SQLite sequences differ');
    return { projectId: manifest.projectId, origin: manifest.origin, schemaVersion: manifest.schemaVersion, recoveryEpoch: manifest.recoveryEpoch, tables: manifest.tables };
  });
}

// Pages are either bounded ordinary rows or a single bounded cell slice.
// Large-row progress contains keysets, column and UTF-8 continuation state,
// never a source rowid: corresponding owners can have different rowids.
export async function digestRelocationPage(storage, manifest, role, table, cursor = null) {
  if (!manifest || manifest.version !== 1 || !manifest.tables.includes(table) || !['source', 'destination'].includes(role) || !validReconciliationCursor(cursor)) throw Error('Invalid reconciliation request');
  const assertFence = () => role === 'source'
    ? assertSourceFence(storage, { projectId: manifest.projectId, origin: manifest.origin, objectName: manifest.objectName, generation: manifest.generation }, manifest.moveId)
    : assertDestinationFence(storage, manifest);
  const page = storage.transactionSync(() => {
    assertFence();
    // A damaged schema must not cause unbounded metadata or SQL text to cross
    // the bridge. Read only needed columns with bounded name bytes and rows.
    const rawInfo = storage.sql.exec(`SELECT CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) BETWEEN 1 AND 1024 THEN CAST(name AS BLOB) END AS name, pk, hidden FROM pragma_table_xinfo(?) LIMIT 101`, table).toArray();
    if (!rawInfo.length || rawInfo.length > 100) throw Error('Invalid reconciliation schema');
    const info = rawInfo.map(column => {
      if (!(column.name instanceof ArrayBuffer) || !Number.isInteger(column.pk) || column.pk < 0 || column.pk > 100 || !Number.isInteger(column.hidden) || column.hidden < 0 || column.hidden > 3) throw Error('Invalid reconciliation schema');
      let name; try { name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(column.name); } catch { throw Error('Invalid reconciliation schema'); }
      return { name, pk: column.pk, hidden: column.hidden };
    });
    const names = info.filter(column => column.hidden === 0).map(column => column.name);
    const keys = info.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
    if (!keys.length || names.length > 100 || keys.some(key => !names.includes(key))) throw Error('Invalid reconciliation schema');
    const isSlice = cursor !== null && !Array.isArray(cursor);
    let current = isSlice ? cursor.after : cursor;
    if (current !== null && current.length !== keys.length || isSlice && (cursor.key.length !== keys.length || cursor.column >= names.length)) throw Error('Invalid reconciliation cursor');
    const definitions = storage.sql.exec("SELECT CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 16384 THEN CAST(sql AS BLOB) END AS ddl FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 2", table).toArray();
    if (definitions.length !== 1 || !(definitions[0].ddl instanceof ArrayBuffer)) throw Error('Invalid reconciliation schema');
    let definition; try { definition = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(definitions[0].ddl); } catch { throw Error('Invalid reconciliation schema'); }
    const order = keys.map(key => quote(key) + (/\bCOLLATE\b/i.test(definition) ? ' COLLATE BINARY' : '')).join(', ');
    const rows = [];
    let size = 0, done = false;
    for (let i = 0; i < 64; i++) {
      const where = current ? ` WHERE (${order}) > (${keys.map(() => '?').join(', ')})` : '';
      const source = `FROM ${quote(table)}${where} ORDER BY ${order} LIMIT 1`;
      const args = current ? toArgs(current) : [];
      // One bounded descriptor per column; avoid pulling any complete TEXT or
      // BLOB across the JS bridge merely to decide whether the row is large.
      const descriptor = names.map(name => `json_array(typeof(${quote(name)}),CASE WHEN typeof(${quote(name)}) IN ('text','blob') THEN octet_length(${quote(name)}) ELSE 8 END)`).join(', ');
      const result = readRelocationDescriptors(storage, `SELECT ${descriptor} ${source}`, args);
      if (!result.length) { if (isSlice) throw Error('Reconciliation row changed'); done = true; break; }
      const kinds = result[0].map(value => {
        let data; try { data = JSON.parse(value); } catch { throw Error('Invalid reconciliation descriptor'); }
        if (!Array.isArray(data) || data.length !== 2 || !['null','integer','real','text','blob'].includes(data[0]) || !Number.isSafeInteger(data[1]) || data[1] < 0 || data[1] > 8388608) throw Error('Invalid reconciliation descriptor');
        return data;
      });
      const keyBytes = keys.reduce((total, key) => total + kinds[names.indexOf(key)][1], 0);
      if (keyBytes > 4096) throw Error('Reconciliation primary key exceeds limit');
      const nextKey = readRelocationRow(storage, keys, source, args);
      if (!validReconciliationKeys(nextKey)) throw Error('Invalid reconciliation primary key');
      const large = kinds.reduce((total, item) => total + item[1], 0) > 32768;
      if (isSlice || large) {
        if (rows.length) break;
        const state = isSlice ? { ...cursor } : { v: 1, after: current, key: nextKey, column: 0, offset: 0, remaining: 0, minimum: 128, maximum: 191 };
        if (JSON.stringify(state.key) !== JSON.stringify(nextKey)) throw Error('Reconciliation row changed');
        const [kind, total] = kinds[state.column], column = quote(names[state.column]);
        if (state.offset > total || (state.offset > 0 && state.offset === total) || (kind !== 'text' && (state.remaining || state.minimum !== 128 || state.maximum !== 191))) throw Error('Invalid reconciliation offset');
        let value, end;
        if (kind === 'text' || kind === 'blob') {
          const amount = Math.min(64 * 1024, total - state.offset);
          const raw = readRelocationBlobSlice(storage, `SELECT substr(CAST(${column} AS BLOB), ${state.offset + 1}, ${amount}) ${source}`, args);
          if (raw.length !== amount) throw Error('Invalid reconciliation slice');
          if (kind === 'text') consumeReconciliationUtf8(state, raw);
          value = raw.toBase64();
          end = state.offset + amount;
          if (end === total && state.remaining) throw Error('Invalid UTF-8 TEXT in relocation row');
        } else {
          if (state.offset !== 0) throw Error('Invalid reconciliation offset');
          const result = execute(storage, { statement: `SELECT ${column} ${source}`, args, query: true }).rows;
          if (result.length !== 1) throw Error('Reconciliation row changed');
          value = result[0][0];
          assertRelocationValuesRepresentable([value]);
          end = total;
        }
        const payload = { table, columns: names, key: state.key, column: state.column, kind, total, offset: state.offset, value };
        let next;
        if (end === total) {
          state.column++; state.offset = 0; state.remaining = 0; state.minimum = 128; state.maximum = 191;
          next = state.column === names.length ? state.key : state;
        } else { state.offset = end; next = state; }
        return { payload, cursor: next, count: Array.isArray(next) ? 1 : 0, done: false };
      }
      const row = readRelocationRow(storage, names, source, args);
      assertRelocationValuesRepresentable(row);
      const encodedSize = new TextEncoder().encode(JSON.stringify(row)).length;
      if (rows.length && size + encodedSize > 128 * 1024) break;
      rows.push(row); size += encodedSize; current = nextKey;
    }
    return { payload: { table, columns: names, rows }, cursor: current, count: rows.length, done };
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(page.payload)));
  storage.transactionSync(assertFence);
  return { guardVersion: RELOCATION_RECONCILIATION_VERSION, count: page.count, cursor: page.cursor, done: page.done, digest: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
}
