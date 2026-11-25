import assert from 'node:assert/strict';
import { assertNoTextPreflightMarkerAccess as check } from '../worker/relocation-text-marker.js';

const marker = 'mapi_relocation_text_preflight_marker';
const seal = 'mapi_relocation_text_preflight_seal';
const ordinary = [
  `SELECT '${marker}'`,
  `INSERT INTO examples (x) VALUES ('${marker}')`,
  `UPDATE examples SET x = '${seal}'`,
  `CREATE VIEW other_view AS SELECT '${marker}'`,
  `CREATE TABLE examples (x TEXT DEFAULT '${seal}')`,
  `SELECT 'a''${marker}''b'`,
  `INSERT INTO examples (x) VALUES ('${seal}') /* ${marker} */`,
  `SELECT 1 -- ${marker}`,
  `SELECT 'prefix ${marker} suffix'`,
  `SELECT α${marker} FROM examples`,
  `SELECT ${seal}中 FROM examples`,
  `SELECT 1 AS ${marker}`,
  `SELECT 1 AS "${seal}"`,
  `WITH x AS (SELECT 1) SELECT 1 AS ${marker}`,
  `CREATE TABLE other AS SELECT 1 AS ${marker}`,
  `CREATE VIEW other_view AS SELECT 1 AS "${marker}"`,
];
for (const sql of ordinary) assert.doesNotThrow(() => check(sql), sql);

const reserved = [
  `CREATE VIEW '${marker}' AS SELECT 1`,
  `CREATE VIEW IF NOT EXISTS "${marker}" AS SELECT 1`,
  `CREATE TEMP VIEW IF /* comment */ NOT EXISTS main.'${marker}' AS SELECT 1`,
  `DROP VIEW main.[${marker}]`,
  `INSERT INTO '${seal}' VALUES (1)`,
  `UPDATE OR REPLACE main.'${seal}' SET marker='x'`,
  `DELETE FROM '${seal}'`,
  `CREATE TRIGGER t INSTEAD OF INSERT ON '${marker}' BEGIN SELECT 1; END`,
  `SELECT 1; CREATE VIEW '${marker}' AS SELECT 1`,
  `SELECT 1 AS ${marker}; CREATE VIEW "${marker}" AS SELECT 1`,
  `ALTER TABLE ordinary RENAME TO "${marker}"`,
];
for (const sql of reserved) assert.throws(() => check(sql), /Reserved TEXT preflight marker/, sql);
console.log('TEXT preflight SQL guard checks passed.');
