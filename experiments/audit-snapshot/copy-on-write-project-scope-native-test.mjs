// Distinct, test-only SQLite check of a saved project's typed byte fragments.
// It is not an authorization service or an integrated capture adapter.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE saved_project (rowid_value INTEGER NOT NULL, part INTEGER NOT NULL,
  storage_type TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(rowid_value,part));`);
const insert = db.prepare('INSERT INTO saved_project VALUES(?,?,?,?)');
for (const [rowid, storageType, project] of [[1, 'text', 'project-a'], [2, 'text', 'project-b'], [3, 'blob', 'project-a']]) {
  insert.run(rowid, 0, storageType, Buffer.from(project));
}
// Match each saved BLOB fragment to the corresponding bytes of the caller's
// expected TEXT project ID. Explicitly reject missing/extra/out-of-range
// parts and non-TEXT source types. No saved bytes are returned to the caller.
const match = db.prepare(`WITH expected AS (
    SELECT CAST(? AS BLOB) AS data, max(1,(length(CAST(? AS BLOB))+65535)/65536) AS parts
  ) SELECT CASE WHEN count(*)=expected.parts AND sum(CASE
    WHEN s.storage_type='text' AND typeof(s.data)='blob' AND s.part>=0 AND s.part<expected.parts
      AND s.data IS CASE WHEN length(expected.data)=0 THEN X'' ELSE substr(expected.data,s.part*65536+1,65536) END
    THEN 1 ELSE 0 END)=expected.parts THEN 1 ELSE 0 END AS ok
  FROM saved_project s, expected WHERE s.rowid_value=?`);
const matches = (rowid, project) => match.get(project, project, rowid).ok === 1;
assert.equal(matches(1, 'project-a'), true);
assert.equal(matches(1, 'PROJECT-A'), false);
assert.equal(matches(2, 'project-a'), false); // Foreign saved project.
assert.equal(matches(3, 'project-a'), false); // Same bytes, wrong SQLite type.
assert.equal(matches(99, 'project-a'), false);
db.prepare('UPDATE saved_project SET data=? WHERE rowid_value=1').run(Buffer.from('project-c'));
assert.equal(matches(1, 'project-a'), false);
db.close();
console.log('Native saved-project scope checks passed');
