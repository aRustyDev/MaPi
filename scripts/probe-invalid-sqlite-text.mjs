// Local-only synthetic diagnostic. No existing object or network target is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const baseline = JSON.parse(await readFile('worker/generated/baseline.json', 'utf8'));
const tables = ['projects', 'users', 'user_attributes'].map(name => {
  const found = baseline.statements.filter(sql => new RegExp(`^CREATE TABLE ${name}\\b`, 'i').test(sql));
  if (found.length !== 1) throw Error(`Expected one ${name} table in the generated baseline`);
  return found[0];
});
const setup = [
  "INSERT INTO projects (id,name,created_at,updated_at) VALUES ('p','P',1,1)",
  "INSERT INTO users (project_id,id,schema_url,created_at,updated_at) VALUES ('p','u','s',1,1)",
  "INSERT INTO user_attributes (project_id,user_id,key,value) VALUES ('p','u','invalid',CAST(X'228022' AS TEXT))",
  "INSERT INTO user_attributes (project_id,user_id,key,value) VALUES ('p','u','replacement',CAST(X'22EFBFBD22' AS TEXT))",
];
const nativeProgram = `
import json, sqlite3, sys
x = json.load(sys.stdin)
c = sqlite3.connect(':memory:')
c.text_factory = bytes
c.execute('PRAGMA foreign_keys=ON')
for statement in x['tables'] + x['setup']: c.execute(statement)
rows = c.execute('SELECT key, typeof(value), hex(value), value FROM user_attributes ORDER BY key').fetchall()
print(json.dumps({'sqliteVersion':sqlite3.sqlite_version,'rows':[{'key':k.decode(),'type':t.decode(),'hex':h.decode(),'bytesHex':v.hex().upper()} for k,t,h,v in rows]}))
`;
const native = JSON.parse(execFileSync('python3', ['-c', nativeProgram], {
  input: JSON.stringify({ tables, setup }), encoding: 'utf8', maxBuffer: 1024 * 1024,
}));
assert.deepEqual(native.rows.map(row => [row.key, row.type, row.hex, row.bytesHex]), [
  ['invalid', 'text', '228022', '228022'],
  ['replacement', 'text', '22EFBFBD22', '22EFBFBD22'],
]);

const source = `
import { DurableObject } from 'cloudflare:workers';
import { execute } from './bridge.js';
export class Probe extends DurableObject {
  async fetch() {
    const storage = this.ctx.storage, sql = storage.sql;
    for (const statement of ${JSON.stringify([...tables, ...setup])}) sql.exec(statement);
    const inspect = () => sql.exec('SELECT key, typeof(value) AS type, hex(value) AS hex FROM user_attributes ORDER BY key').toArray();
    const before = inspect();
    const direct = sql.exec('SELECT value FROM user_attributes ORDER BY key').toArray().map(row => [...row.value].map(c => c.codePointAt(0)));
    const bridge = execute(storage, { statement: 'SELECT value FROM user_attributes ORDER BY key', args: [], query: true }).rows.map(row => [...row[0]].map(c => c.codePointAt(0)));
    const after = inspect();
    return Response.json({ before, direct, bridge, after });
  }
}
export default { fetch(request, env) { return env.PROBE.get(env.PROBE.idFromName('synthetic')).fetch(request); } };
`;
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    name: 'local-synthetic-invalid-text-probe', compatibilityDate: '2026-11-19',
    modules: [
      { type: 'ESModule', path: 'probe.js', contents: source },
      { type: 'ESModule', path: 'bridge.js', contents: await readFile('worker/sql.js', 'utf8') },
    ],
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
  }],
  host: '127.0.0.1', port: 0, telemetry: { enabled: false },
}));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/probe');
  if (response.status !== 200) throw Error(`Local workerd probe failed: ${response.status}`);
  const local = await response.json();
  assert.deepEqual(local.before, [
    { key: 'invalid', type: 'text', hex: '228022' },
    { key: 'replacement', type: 'text', hex: '22EFBFBD22' },
  ]);
  assert.deepEqual(local.after, local.before);
  assert.deepEqual(local.direct, [[34, 65533, 34], [34, 65533, 34]]);
  assert.deepEqual(local.bridge, local.direct);
  console.log(JSON.stringify({ native, local }));
} finally {
  await mf.dispose();
}
