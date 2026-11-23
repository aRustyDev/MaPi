// Extract the exact issuer DDL retained by SQLite from the checked-in overlay.
// Run with --check to detect schema drift without writing the manifest.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const roots = ['upstream/overlay/apps/api/internal/mapioauth', 'upstream/overlay/apps/api/internal/mapidpop'];
const statements = [];
for (const root of roots) {
  for (const file of (await readdir(root)).sort()) {
    if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
    const source = await readFile(`${root}/${file}`, 'utf8');
    const pattern = /`(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+mapi_[\s\S]*?)`/g;
    for (const match of source.matchAll(pattern)) statements.push(match[1]);
  }
}
const db = new DatabaseSync(':memory:');
try {
  for (const statement of statements.filter(statement => /^CREATE\s+TABLE/i.test(statement))) db.exec(statement);
  for (const statement of statements.filter(statement => /^CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(statement))) db.exec(statement);
  const entries = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type, name").all();
  assert.equal(entries.filter(entry => entry.type === 'table').length, 26, 'issuer table count changed');
  assert.equal(entries.filter(entry => entry.type === 'index').length, 13, 'issuer index count changed');
  const json = JSON.stringify(entries, null, 2) + '\n';
  const output = 'worker/relocation-issuer-schema.json';
  if (process.argv.includes('--check')) assert.equal(await readFile(output, 'utf8'), json, 'issuer relocation schema is stale');
  else await writeFile(output, json);
  console.log('Pinned issuer relocation schema matches the checked-in overlay.');
} finally { db.close(); }
