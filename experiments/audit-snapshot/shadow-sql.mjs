// Unmounted native experiment only. The caller supplies the exact trusted
// pinned schema and must execute this under its own authorization, fence and
// synchronous transaction. This does not implement a snapshot lifecycle.
import { auditSourceColumns as columns } from '../../worker/audit-source-capture.js';

// Lifecycle callers may compose installation and their durable state in the
// same synchronous transaction. This function must only be called by such a
// caller; the public diagnostic wrapper below provides the transaction.
export function installShadowSQLInTransaction(storage, sourceDDL, sourceIndexes, authorize) {
  if (typeof sourceDDL !== 'string' || !sourceDDL.startsWith('CREATE TABLE events (') || !Array.isArray(sourceIndexes)) throw Error('Invalid pinned schema');
  if (!storage || typeof storage.transactionSync !== 'function' || typeof storage.sql?.exec !== 'function' || typeof authorize !== 'function') throw Error('Invalid shadow authority');
  const sql=storage.sql, all=(q,...args)=>sql.exec(q,...args).toArray();
  if (authorize() !== true) throw Error('Shadow authority denied');
  const source = all("SELECT CASE WHEN sql=? THEN 1 ELSE 0 END AS matches FROM sqlite_schema WHERE type='table' AND name='events'",sourceDDL);
  if (source.length !== 1 || source[0].matches !== 1) throw Error('Source schema differs');
  const existing = all("SELECT name, sql FROM sqlite_schema WHERE type='index' AND tbl_name='events' COLLATE NOCASE AND sql IS NOT NULL ORDER BY name");
  const expected = sourceIndexes.map(sql => {
    const match = /^CREATE INDEX (idx_events_[a-z0-9_]+)\s+ON events\s*\(/.exec(sql);
    if (!match) throw Error('Unsupported source index');
    return {name:match[1], sql};
  }).sort((a,b) => a.name.localeCompare(b.name));
  if (JSON.stringify(existing) !== JSON.stringify(expected)) throw Error('Source indexes differ');
  if (all("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name='events' COLLATE NOCASE LIMIT 1").length) throw Error('Unexpected source trigger');
  const unique = all("SELECT origin FROM pragma_index_list('events') WHERE \"unique\"=1");
  if (unique.length !== 1 || unique[0].origin !== 'pk') throw Error('Unsupported source uniqueness');
  sql.exec(sourceDDL.replace(/^CREATE TABLE events /, 'CREATE TABLE mapi_shadow_events '));
  for (const {name,sql} of expected) {
    storage.sql.exec(sql.replace(`CREATE INDEX ${name}`, `CREATE INDEX mapi_shadow_${name}`).replace(/\bON events\s*\(/, 'ON mapi_shadow_events ('));
  }
  sql.exec('CREATE TABLE mapi_shadow_after (event_rowid INTEGER PRIMARY KEY)');
  const names=columns.join(', '), sourceNames=columns.map(c=>`e.${c}`).join(', ');
  const save = predicate => `INSERT INTO mapi_shadow_events (rowid, ${names}) SELECT e.rowid, ${sourceNames} FROM events e
    WHERE (${predicate}) AND NOT EXISTS (SELECT 1 FROM mapi_shadow_after a WHERE a.event_rowid=e.rowid)
      AND NOT EXISTS (SELECT 1 FROM mapi_shadow_events s WHERE s.rowid=e.rowid);`;
  const conflict='e.rowid=NEW.rowid OR (e.project_id=NEW.project_id AND e.id=NEW.id)';
  const mark='INSERT INTO mapi_shadow_after SELECT NEW.rowid WHERE NOT EXISTS (SELECT 1 FROM mapi_shadow_after WHERE event_rowid=NEW.rowid);';
  for (const trigger of [
    `CREATE TRIGGER mapi_shadow_before_insert BEFORE INSERT ON events BEGIN ${save(conflict)} END`,
    `CREATE TRIGGER mapi_shadow_before_update BEFORE UPDATE ON events BEGIN ${save(`e.rowid=OLD.rowid OR ${conflict}`)} END`,
    `CREATE TRIGGER mapi_shadow_before_delete BEFORE DELETE ON events BEGIN ${save('e.rowid=OLD.rowid')} END`,
    `CREATE TRIGGER mapi_shadow_after_insert AFTER INSERT ON events BEGIN ${mark} END`,
    `CREATE TRIGGER mapi_shadow_after_update AFTER UPDATE ON events BEGIN ${mark} END`,
  ]) sql.exec(trigger);
  sql.exec(`CREATE VIEW mapi_shadow_snapshot AS SELECT s.rowid AS source_rowid, ${columns.map(c=>`s.${c}`).join(', ')} FROM mapi_shadow_events s
    UNION ALL SELECT e.rowid AS source_rowid, ${sourceNames} FROM events e
    WHERE NOT EXISTS (SELECT 1 FROM mapi_shadow_after a WHERE a.event_rowid=e.rowid)
      AND NOT EXISTS (SELECT 1 FROM mapi_shadow_events s WHERE s.rowid=e.rowid)`);
  if (authorize() !== true) throw Error('Shadow authority denied');
}

export function installShadowSQL(storage, sourceDDL, sourceIndexes, authorize) {
  return storage.transactionSync(() => installShadowSQLInTransaction(storage, sourceDDL, sourceIndexes, authorize));
}
