// The evidence journal is indexed by move/table/cursor, while the public API
// paginates by its historical rowid. Build a separate rowid index in bounded
// batches; never synchronously index or copy an entire historical journal.
const PAGE_BATCH = 32;
const CURSOR_BYTES = 12 * 1024;
const DDL = Object.freeze({
  mapi_move_evidence_pages: 'CREATE TABLE mapi_move_evidence_pages (move_id TEXT NOT NULL, project_id TEXT NOT NULL, sequence INTEGER NOT NULL, previous INTEGER, following INTEGER, PRIMARY KEY (move_id, project_id, sequence))',
  mapi_move_evidence_index: 'CREATE TABLE mapi_move_evidence_index (move_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, table_index INTEGER, cursor TEXT, last_sequence INTEGER, complete INTEGER NOT NULL, head INTEGER, tail INTEGER)',
});
const EVIDENCE_DDL = 'CREATE TABLE mapi_move_evidence (move_id TEXT NOT NULL, project_id TEXT NOT NULL, table_index INTEGER NOT NULL, table_name TEXT NOT NULL, cursor_in TEXT NOT NULL, cursor_out TEXT, row_count INTEGER NOT NULL, digest TEXT NOT NULL, table_done INTEGER NOT NULL, UNIQUE (move_id, table_index, cursor_in))';
const one = (sql, query, ...args) => sql.exec(query, ...args).toArray()[0];

export function initializeEvidencePaging(storage) {
  for (const ddl of Object.values(DDL)) storage.sql.exec(ddl.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
}

function validateSchema(sql) {
  const evidence = sql.exec("SELECT CASE WHEN type = 'table' AND sql = ? THEN 1 ELSE 0 END AS ok FROM sqlite_schema WHERE name = 'mapi_move_evidence' COLLATE NOCASE LIMIT 2", EVIDENCE_DDL).toArray();
  if (evidence.length !== 1 || evidence[0].ok !== 1 || one(sql, "SELECT 1 FROM sqlite_schema WHERE tbl_name = 'mapi_move_evidence' COLLATE NOCASE AND type = 'trigger' LIMIT 1")) throw Error('Evidence paging schema differs');
  for (const [name, ddl] of Object.entries(DDL)) {
    const rows = sql.exec("SELECT CASE WHEN type = 'table' AND sql = ? THEN 1 ELSE 0 END AS ok FROM sqlite_schema WHERE name = ? COLLATE NOCASE LIMIT 2", ddl, name).toArray();
    if (rows.length !== 1 || rows[0].ok !== 1 || one(sql, "SELECT 1 FROM sqlite_schema WHERE tbl_name = ? COLLATE NOCASE AND type IN ('trigger', 'index') AND sql IS NOT NULL LIMIT 1", name)) throw Error('Evidence paging schema differs');
  }
}

function readState(sql, moveId, projectId) {
  const row = one(sql, `SELECT CASE WHEN project_id = ? COLLATE BINARY THEN 1 ELSE 0 END AS owner, table_index, last_sequence, complete, head, tail,
    CASE WHEN cursor IS NULL THEN 1 WHEN typeof(cursor) = 'text' AND octet_length(cursor) <= ? THEN 1 ELSE 0 END AS cursor_ok,
    CASE WHEN typeof(cursor) = 'text' AND octet_length(cursor) <= ? THEN CAST(cursor AS BLOB) END AS cursor
    FROM mapi_move_evidence_index WHERE move_id = ? LIMIT 1`, projectId, CURSOR_BYTES, CURSOR_BYTES, moveId);
  if (!row) return null;
  const validSequence = value => value === null || Number.isSafeInteger(value) && value > 0;
  if (row.owner !== 1 || ![0, 1].includes(row.complete) || row.cursor_ok !== 1 || !(row.table_index === null || Number.isSafeInteger(row.table_index) && row.table_index >= 0) || (row.table_index === null) !== (row.cursor === null) || !validSequence(row.last_sequence) || (row.table_index === null) !== (row.last_sequence === null) || !validSequence(row.head) || !validSequence(row.tail) || (row.head === null) !== (row.tail === null) || row.head !== null && row.head > row.tail) throw Error('Invalid evidence paging checkpoint');
  let cursor = null;
  if (row.cursor !== null) {
    if (!(row.cursor instanceof ArrayBuffer)) throw Error('Invalid evidence paging checkpoint');
    try { cursor = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row.cursor); }
    catch { throw Error('Invalid evidence paging checkpoint'); }
  }
  return { tableIndex: row.table_index, cursor, lastSequence: row.last_sequence, complete: row.complete === 1, head: row.head, tail: row.tail };
}

// A just-created journal has no historical rows. This runs in the same
// transaction as journal creation and evidence insertion.
export function initializeNewEvidenceJournal(sql, projectId, moveId) {
  validateSchema(sql);
  if (one(sql, 'SELECT 1 FROM mapi_move_evidence WHERE move_id = ? LIMIT 1', moveId) || one(sql, 'SELECT 1 FROM mapi_move_evidence_pages WHERE move_id = ? LIMIT 1', moveId) || one(sql, 'SELECT 1 FROM mapi_move_evidence_index WHERE move_id = ? LIMIT 1', moveId)) throw Error('Existing evidence requires manual review');
  sql.exec('INSERT INTO mapi_move_evidence_index VALUES (?, ?, NULL, NULL, NULL, 1, NULL, NULL)', moveId, projectId);
}

function validLink(row) {
  return !!row && Number.isSafeInteger(row.sequence) && row.sequence > 0 &&
    (row.previous === null || Number.isSafeInteger(row.previous) && row.previous > 0 && row.previous < row.sequence) &&
    (row.following === null || Number.isSafeInteger(row.following) && row.following > row.sequence);
}

function linkEvidenceSequence(sql, projectId, moveId, sequence) {
  let state = readState(sql, moveId, projectId);
  if (!state) {
    sql.exec('INSERT INTO mapi_move_evidence_index VALUES (?, ?, NULL, NULL, NULL, 0, NULL, NULL)', moveId, projectId);
    state = readState(sql, moveId, projectId);
  }
  const existing = one(sql, 'SELECT sequence, previous, following FROM mapi_move_evidence_pages WHERE move_id = ? AND project_id = ? AND sequence = ?', moveId, projectId, sequence);
  if (existing) { if (!validLink(existing)) throw Error('Invalid evidence paging index'); return; }
  const before = one(sql, 'SELECT sequence, previous, following FROM mapi_move_evidence_pages WHERE move_id = ? AND project_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 1', moveId, projectId, sequence);
  const after = one(sql, 'SELECT sequence, previous, following FROM mapi_move_evidence_pages WHERE move_id = ? AND project_id = ? AND sequence > ? ORDER BY sequence LIMIT 1', moveId, projectId, sequence);
  if (before && !validLink(before) || after && !validLink(after) ||
      (before ? before.following !== (after?.sequence ?? null) : state.head !== (after?.sequence ?? null)) ||
      (after ? after.previous !== (before?.sequence ?? null) : state.tail !== (before?.sequence ?? null))) throw Error('Invalid evidence paging index');
  sql.exec('INSERT INTO mapi_move_evidence_pages VALUES (?, ?, ?, ?, ?)', moveId, projectId, sequence, before?.sequence ?? null, after?.sequence ?? null);
  if (before) sql.exec('UPDATE mapi_move_evidence_pages SET following = ? WHERE move_id = ? AND project_id = ? AND sequence = ?', sequence, moveId, projectId, before.sequence);
  if (after) sql.exec('UPDATE mapi_move_evidence_pages SET previous = ? WHERE move_id = ? AND project_id = ? AND sequence = ?', sequence, moveId, projectId, after.sequence);
  sql.exec('UPDATE mapi_move_evidence_index SET head = ?, tail = ? WHERE move_id = ? AND project_id = ?', before ? state.head : sequence, after ? state.tail : sequence, moveId, projectId);
}

// Called immediately after inserting an evidence row, in the same transaction.
export function recordEvidencePage(sql, projectId, moveId) {
  validateSchema(sql);
  const row = one(sql, 'SELECT last_insert_rowid() AS sequence');
  if (!Number.isSafeInteger(row?.sequence) || row.sequence < 1) throw Error('Invalid evidence sequence');
  linkEvidenceSequence(sql, projectId, moveId, row.sequence);
  const state = readState(sql, moveId, projectId);
  if (state.complete) {
    const item = one(sql, `SELECT table_index, CASE WHEN move_id = ? COLLATE BINARY AND project_id = ? COLLATE BINARY THEN 1 ELSE 0 END AS owner,
      CASE WHEN typeof(cursor_in) = 'text' AND octet_length(cursor_in) <= ? THEN CAST(cursor_in AS BLOB) END AS cursor
      FROM mapi_move_evidence WHERE rowid = ?`, moveId, projectId, CURSOR_BYTES, row.sequence);
    if (item?.owner !== 1 || !Number.isSafeInteger(item.table_index) || item.table_index < 0 || !(item.cursor instanceof ArrayBuffer)) throw Error('Invalid evidence sequence');
    let cursor;
    try { cursor = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(item.cursor); }
    catch { throw Error('Invalid evidence sequence'); }
    // Maintain a keyset high-water mark even for newly created journals, so a
    // corrupted completion bit cannot conceal unindexed historical rows.
    sql.exec('UPDATE mapi_move_evidence_index SET table_index = ?, cursor = ?, last_sequence = ? WHERE move_id = ? AND project_id = ? AND (table_index IS NULL OR (table_index, cursor) < (?, ?))', item.table_index, cursor, row.sequence, moveId, projectId, item.table_index, cursor);
  }
}

function verifyCheckpoint(sql, projectId, moveId, state) {
  if (state.lastSequence === null) return;
  // Bind the keyset cursor to its independently stored rowid and to a page
  // mapping. A valid-looking later key cannot skip unindexed historical rows.
  if (!one(sql, 'SELECT 1 FROM mapi_move_evidence WHERE rowid = ? AND move_id = ? AND project_id = ? AND table_index = ? AND cursor_in = ? LIMIT 1', state.lastSequence, moveId, projectId, state.tableIndex, state.cursor) ||
      !one(sql, 'SELECT 1 FROM mapi_move_evidence_pages WHERE move_id = ? AND project_id = ? AND sequence = ? LIMIT 1', moveId, projectId, state.lastSequence)) throw Error('Invalid evidence paging checkpoint');
}

function verifyComplete(sql, projectId, moveId, state) {
  const seek = state.tableIndex === null ? '' : 'AND (table_index, cursor_in) > (?, ?)';
  const args = state.tableIndex === null ? [] : [state.tableIndex, state.cursor];
  if (one(sql, `SELECT 1 FROM mapi_move_evidence INDEXED BY sqlite_autoindex_mapi_move_evidence_1 WHERE move_id = ? ${seek} LIMIT 1`, moveId, ...args)) throw Error('Evidence paging checkpoint is incomplete');
  if (state.tableIndex !== null) {
    const high = one(sql, 'SELECT rowid AS sequence FROM mapi_move_evidence INDEXED BY sqlite_autoindex_mapi_move_evidence_1 WHERE move_id = ? AND table_index = ? AND cursor_in = ? LIMIT 1', moveId, state.tableIndex, state.cursor);
    if (!Number.isSafeInteger(high?.sequence) || !one(sql, 'SELECT 1 FROM mapi_move_evidence_pages WHERE move_id = ? AND project_id = ? AND sequence = ? LIMIT 1', moveId, projectId, high.sequence)) throw Error('Evidence paging checkpoint is incomplete');
  }
}

// Called before inserting a new evidence row, in the same transaction as the
// eventual insert and dual-write. A corrupt completion flag must be checked
// before a new high-water mark can conceal unindexed historical evidence.
export function assertEvidenceAppendAllowed(sql, projectId, moveId) {
  validateSchema(sql);
  const state = readState(sql, moveId, projectId);
  if (!state) return; // A pre-index legacy journal will be backfilled later.
  verifyCheckpoint(sql, projectId, moveId, state);
  if (state.complete) verifyComplete(sql, projectId, moveId, state);
}

// Caller commits this transaction before returning the retryable error.
export function advanceEvidencePaging(storage, projectId, moveId) {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    validateSchema(sql);
    if (!one(sql, 'SELECT 1 FROM mapi_move_journals WHERE move_id = ? AND project_id = ? LIMIT 1', moveId, projectId)) throw Error('Move evidence not available');
    let state = readState(sql, moveId, projectId);
    if (!state) {
      sql.exec('INSERT INTO mapi_move_evidence_index VALUES (?, ?, NULL, NULL, NULL, 0, NULL, NULL)', moveId, projectId);
      state = { tableIndex: null, cursor: null, lastSequence: null, complete: false, head: null, tail: null };
    }
    verifyCheckpoint(sql, projectId, moveId, state);
    if (state.complete) { verifyComplete(sql, projectId, moveId, state); return true; }
    const seek = state.tableIndex === null ? '' : 'AND (table_index, cursor_in) > (?, ?)';
    const args = state.tableIndex === null ? [] : [state.tableIndex, state.cursor];
    // The pre-existing UNIQUE(move_id, table_index, cursor_in) index supports
    // this ordered seek. Check ownership before copying an original rowid.
    const rows = sql.exec(`SELECT rowid AS sequence, table_index,
      CASE WHEN project_id = ? COLLATE BINARY THEN 1 ELSE 0 END AS owner,
      CASE WHEN typeof(cursor_in) = 'text' AND octet_length(cursor_in) <= ? THEN CAST(cursor_in AS BLOB) END AS cursor
      FROM mapi_move_evidence INDEXED BY sqlite_autoindex_mapi_move_evidence_1 WHERE move_id = ? ${seek} ORDER BY table_index, cursor_in LIMIT ?`, projectId, CURSOR_BYTES, moveId, ...args, PAGE_BATCH + 1).toArray();
    const batch = rows.slice(0, PAGE_BATCH);
    let last = state;
    for (const row of batch) {
      if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || !Number.isSafeInteger(row.table_index) || row.table_index < 0 || row.owner !== 1 || !(row.cursor instanceof ArrayBuffer)) throw Error('Invalid historical evidence');
      let cursor;
      try { cursor = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row.cursor); }
      catch { throw Error('Invalid historical evidence'); }
      linkEvidenceSequence(sql, projectId, moveId, row.sequence);
      last = { tableIndex: row.table_index, cursor, lastSequence: row.sequence };
    }
    const complete = rows.length <= PAGE_BATCH;
    sql.exec('UPDATE mapi_move_evidence_index SET table_index = ?, cursor = ?, last_sequence = ?, complete = ? WHERE move_id = ? AND project_id = ?', last.tableIndex, last.cursor, last.lastSequence, complete ? 1 : 0, moveId, projectId);
    return complete;
  });
}

// Validate continuity around an indexed page, including empty pages and an
// arbitrary caller-provided after cursor. A missing mapping must fail closed.
export function verifyEvidencePage(sql, projectId, moveId, after, rows) {
  const state = readState(sql, moveId, projectId);
  if (!state?.complete) throw Error('Evidence index preparation in progress; retry');
  const prior = one(sql, 'SELECT sequence, previous, following FROM mapi_move_evidence_pages WHERE move_id = ? AND project_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1', moveId, projectId, after);
  if (prior && !validLink(prior)) throw Error('Invalid evidence paging index');
  let expected = prior ? prior.following : state.head, previous = prior?.sequence ?? null;
  if (expected !== null && expected <= after) throw Error('Invalid evidence paging index');
  for (const row of rows) {
    if (!validLink(row) || row.sequence !== expected || row.previous !== previous || row.owner !== 1) throw Error('Invalid evidence paging index');
    previous = row.sequence; expected = row.following;
  }
  if (rows.length < 33 && (expected !== null || previous !== state.tail)) throw Error('Invalid evidence paging index');
}
