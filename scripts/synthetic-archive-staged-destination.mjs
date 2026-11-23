// Local-only synthetic archive destination. It has no ingress or activation
// method and is not an authority boundary for a real project.
import { DurableObject } from 'cloudflare:workers';
import { beginChunkImport, importChunk, chunkImportStatus } from '../worker/relocation-chunks.js';
import { execute } from '../worker/sql.js';

const enc = new TextEncoder();
const hex64 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const fields = ['identityDigest','sealDigest','inventoryDigest','next','previous','inventory','table','complete'];
const rows = (sql, query, ...args) => sql.exec(query, ...args).toArray();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const copy = value => JSON.parse(JSON.stringify(value));
async function sha(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join(''); }

function cursor(value) {
  const verified = value && Object.hasOwn(value,'verificationHeadDigest');
  const keys = verified ? [...fields,'verificationHeadDigest'] : fields;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value,k)) ||
      (verified && !hex64(value.verificationHeadDigest)) || !hex64(value.identityDigest) || !hex64(value.sealDigest) || !hex64(value.inventoryDigest) || !Number.isSafeInteger(value.next) || value.next < 0 ||
      !Number.isSafeInteger(value.table) || value.table < 0 || typeof value.complete !== 'boolean' ||
      (value.next === 0 ? value.previous !== '' || value.inventory !== '' || value.table !== 0 : !hex64(value.previous) || !hex64(value.inventory))) throw Error('Invalid synthetic archive checkpoint');
  return Object.fromEntries(keys.map(k => [k,value[k]]));
}

function checkedConfig(input) {
  const value = copy(input), c = value?.commitment, s = value?.scope;
  if (!value || Object.keys(value).sort().join(',') !== 'commitment,destinationName,envelopeDigest,scope' || !s || !c ||
      typeof s.runId !== 'string' || !s.runId || !/^[0-9a-f]{32}$/.test(s.archiveId) || !hex64(s.manifestDigest) || !hex64(value.envelopeDigest) ||
      !['projectId','origin','objectName','moveId'].every(k => typeof c[k] === 'string' && c[k].length > 0 && c[k].length <= 256 && c[k].isWellFormed()) ||
      typeof value.destinationName !== 'string' || !value.destinationName || value.destinationName === c.objectName || value.destinationName.length > 256 || !value.destinationName.isWellFormed() ||
      !Number.isSafeInteger(c.generation) || c.generation < 1 || c.generation === Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(c.chunkCount) || c.chunkCount < 1 || c.chunkCount > 1000000 || !hex64(c.finalDigest) || c.manifestDigest !== s.manifestDigest ||
      !same(c.tables,['users','events'])) throw Error('Invalid synthetic destination configuration');
  return value;
}

function identity(config) {
  const {scope:s,commitment:c,envelopeDigest:d}=config;
  return ['mapi-archive-restore-identity-v1',1,s.runId,s.archiveId,d,c.projectId,c.origin,c.objectName,c.generation,c.moveId,c.manifestDigest,c.tables,c.chunkCount,c.finalDigest];
}

function source(content, config, expected, index, digest) {
  if (typeof content !== 'string' || !content.isWellFormed() || enc.encode(content).length > 128*1024) throw Error('Invalid synthetic source content');
  const p = JSON.parse(content), c=config.commitment;
  if (!p || p.projectId !== c.projectId || p.generation !== c.generation || p.moveId !== c.moveId || p.index !== index || p.prev !== expected.previous ||
      p.table !== c.tables[expected.table] || !Array.isArray(p.rows) || p.rows.length > 64 || p.fragment || typeof p.last !== 'boolean' || typeof p.done !== 'boolean' ||
      p.done !== (index === c.chunkCount-1) || (p.done && !p.last) ||
      !same(p.columns,p.table==='users'?['id','name']:['id','payload'])) throw Error('Synthetic source identity or shape differs');
  for (const row of p.rows) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[1] !== 'string' || !row[1].isWellFormed() || enc.encode(row[1]).length > 4096) throw Error('Invalid synthetic row');
    if (p.table === 'users') {
      if (typeof row[0] !== 'string' || !row[0] || !row[0].isWellFormed() || enc.encode(row[0]).length > 512) throw Error('Invalid synthetic user');
    } else {
      const id = row[0];
      if (!id || typeof id !== 'object' || Object.keys(id).length !== 1 || typeof id.integer !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(id.integer) || BigInt(id.integer) < -9223372036854775808n || BigInt(id.integer) > 9223372036854775807n) throw Error('Invalid synthetic event');
    }
  }
  if (!hex64(digest)) throw Error('Invalid synthetic chunk digest');
  return p;
}

export class SyntheticArchiveStagedDestination extends DurableObject {
  #abortAfterImport = 0;

  async initializeFixture(input) {
    const config=checkedConfig(input), identityDigest=await sha(JSON.stringify(identity(config)));
    this.ctx.storage.transactionSync(() => {
      const sql=this.ctx.storage.sql;
      const exists=rows(sql,"SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_test_archive_target'").length;
      if (exists) {
        const saved=rows(sql,'SELECT config, identity_digest FROM mapi_test_archive_target WHERE singleton=1');
        if (saved.length !== 1 || saved[0].config !== JSON.stringify(config) || saved[0].identity_digest !== identityDigest) throw Error('Conflicting synthetic target');
        return;
      }
      const existing=rows(sql,"SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> '__miniflare_do_name' LIMIT 10");
      if (existing.length) throw Error(`Synthetic target is not fresh: ${JSON.stringify(existing)}`);
      sql.exec('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
      sql.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
      sql.exec('CREATE TABLE mapi_test_insert_audit (kind TEXT NOT NULL)');
      sql.exec("CREATE TRIGGER mapi_test_users_insert AFTER INSERT ON users BEGIN INSERT INTO mapi_test_insert_audit VALUES ('user'); END");
      sql.exec("CREATE TRIGGER mapi_test_events_insert AFTER INSERT ON events BEGIN INSERT INTO mapi_test_insert_audit VALUES ('event'); END");
      sql.exec('CREATE TABLE mapi_test_expected_users (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
      sql.exec('CREATE TABLE mapi_test_expected_events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
      sql.exec('CREATE TABLE mapi_test_archive_target (singleton INTEGER PRIMARY KEY CHECK(singleton=1), config TEXT NOT NULL, identity_digest TEXT NOT NULL, checkpoint TEXT)');
      sql.exec('INSERT INTO mapi_test_archive_target VALUES (1, ?, ?, NULL)',JSON.stringify(config),identityDigest);
    });
    return {identityDigest};
  }

  #target() {
    const result=rows(this.ctx.storage.sql,'SELECT config, identity_digest, checkpoint FROM mapi_test_archive_target WHERE singleton=1');
    if (result.length !== 1) throw Error('Synthetic target missing');
    return {config:checkedConfig(JSON.parse(result[0].config)), identityDigest:result[0].identity_digest, checkpoint:result[0].checkpoint === null ? null : cursor(JSON.parse(result[0].checkpoint))};
  }

  #checkImporter(target, cp) {
    const c=target.config.commitment, sql=this.ctx.storage.sql, state=chunkImportStatus(this.ctx.storage,c.projectId);
    if (cp.identityDigest!==target.identityDigest || cp.next>c.chunkCount || cp.table>c.tables.length || (cp.complete && cp.next!==c.chunkCount) ||
        !state || state.project_id !== c.projectId || state.generation !== c.generation || state.move_id !== c.moveId || state.object_name !== target.config.destinationName ||
        state.tables !== JSON.stringify(c.tables) || !Number.isSafeInteger(state.next_chunk) || state.next_chunk < cp.next || state.next_chunk > cp.next+1 ||
        (state.next_chunk === cp.next && (state.chain !== cp.previous || state.table_index !== cp.table))) throw Error('Synthetic importer checkpoint differs');
    const project=rows(sql,'SELECT project_id,generation,state,move_id,digest,object_name FROM mapi_relocation_project LIMIT 2');
    if (project.length !== 1 || project[0].project_id !== c.projectId || project[0].generation !== c.generation+1 || project[0].move_id !== c.moveId || project[0].object_name !== target.config.destinationName ||
        !['importing','staged'].includes(project[0].state) || (state.done===1)!==(project[0].state==='staged')) throw Error('Synthetic destination state differs');
    if (cp.next > 0) {
      const previous=rows(sql,'SELECT digest FROM mapi_chunk_import_data WHERE project_id=? AND chunk_index=?',c.projectId,cp.next-1);
      if (previous.length!==1 || previous[0].digest!==cp.previous) throw Error('Synthetic importer previous digest differs');
    }
    if (state.next_chunk===cp.next+1) {
      const latest=rows(sql,'SELECT digest FROM mapi_chunk_import_data WHERE project_id=? AND chunk_index=?',c.projectId,cp.next);
      if (latest.length!==1 || latest[0].digest!==state.chain) throw Error('Synthetic importer unacknowledged digest differs');
    }
    if (cp.complete && (state.done!==1 || state.next_chunk!==cp.next)) throw Error('Synthetic destination completion differs');
    return state;
  }

  async load() {
    const target=this.#target(), cp=target.checkpoint;
    if (cp === null) return null;
    if (cp.identityDigest!==target.identityDigest) throw Error('Synthetic target identity differs');
    this.#checkImporter(target,cp);
    return cp;
  }

  async begin(value) {
    const cp=cursor(copy(value)), target=this.#target(), c=target.config.commitment;
    if (cp.identityDigest!==target.identityDigest || cp.next!==0 || cp.complete) throw Error('Invalid synthetic begin');
    if (target.checkpoint !== null) { if (!same(target.checkpoint,cp)) throw Error('Conflicting synthetic begin'); this.#checkImporter(target,cp); return; }
    beginChunkImport(this.ctx.storage,c.projectId,c.generation,c.moveId,target.config.destinationName,c.tables);
    this.ctx.storage.transactionSync(() => {
      const fresh=this.#target();
      if (fresh.checkpoint!==null && !same(fresh.checkpoint,cp)) throw Error('Conflicting synthetic begin');
      if (fresh.checkpoint===null) this.ctx.storage.sql.exec('UPDATE mapi_test_archive_target SET checkpoint=? WHERE singleton=1',JSON.stringify(cp));
      this.#checkImporter({...fresh,checkpoint:cp},cp);
    });
  }

  async apply(input) {
    const value=copy(input), expected=cursor(value.expected), next=cursor(value.next), target=this.#target(), c=target.config.commitment;
    if (!Number.isSafeInteger(value.index) || value.index!==expected.next || expected.complete || value.index>=c.chunkCount || !hex64(value.selectorDigest) || !hex64(value.recordDigest) || !hex64(value.digest)) throw Error('Invalid synthetic apply');
    const p=source(value.content,target.config,expected,value.index,value.digest);
    if (await sha(value.content)!==value.digest) throw Error('Synthetic content digest differs');
    const inventory=await sha(JSON.stringify(['mapi-archive-inventory-v1',expected.inventory,value.index,value.selectorDigest,value.recordDigest]));
    const wanted={...expected,next:value.index+1,previous:value.digest,inventory,table:expected.table+(p.last?1:0)};
    if (!same(next,wanted) || next.table>c.tables.length || (value.index<c.chunkCount-1 && next.table>=c.tables.length)) throw Error('Synthetic archive progress differs');
    const current=this.#target();
    if (same(current.checkpoint,next)) { this.#checkImporter(current,next); return; }
    if (!same(current.checkpoint,expected)) throw Error('Synthetic archive checkpoint differs');
    this.#checkImporter(current,expected);
    await importChunk(this.ctx.storage,c.projectId,{content:value.content,digest:value.digest});
    if (this.#abortAfterImport > 0 && --this.#abortAfterImport === 0) {
      await this.ctx.storage.sync();
      this.ctx.abort('Injected interruption after importer commit');
    }
    this.ctx.storage.transactionSync(() => {
      const now=this.#target();
      if (same(now.checkpoint,next)) { this.#checkImporter(now,next); return; }
      if (!same(now.checkpoint,expected)) throw Error('Synthetic archive checkpoint differs');
      const state=this.#checkImporter(now,expected);
      if (state.next_chunk!==next.next || state.chain!==value.digest || state.table_index!==next.table) throw Error('Synthetic importer did not commit chunk');
      for (const row of p.rows) {
        if (p.table==='users') this.ctx.storage.sql.exec('INSERT INTO mapi_test_expected_users VALUES (?, ?)',row[0],row[1]);
        else execute(this.ctx.storage,{statement:'INSERT INTO mapi_test_expected_events VALUES (?, ?)',args:[{kind:'int',value:row[0].integer},{kind:'value',value:row[1]}],query:false});
      }
      this.ctx.storage.sql.exec('UPDATE mapi_test_archive_target SET checkpoint=? WHERE singleton=1',JSON.stringify(next));
    });
  }

  async finish(value) {
    const cp=cursor(copy(value));
    this.ctx.storage.transactionSync(() => {
      const target=this.#target(), c=target.config.commitment;
      const already=same(target.checkpoint,{...cp,complete:true});
      if ((!same(target.checkpoint,cp) && !already) || cp.complete || cp.next!==c.chunkCount || cp.table!==c.tables.length || cp.previous!==c.finalDigest || cp.inventory!==cp.inventoryDigest) throw Error('Synthetic destination incomplete');
      const state=this.#checkImporter(target,cp);
      if (state.done!==1 || state.next_chunk!==cp.next || state.chain!==c.finalDigest) throw Error('Synthetic importer incomplete');
      const sql=this.ctx.storage.sql;
      for (const [table,expected] of [['users','mapi_test_expected_users'],['events','mapi_test_expected_events']]) {
        const a=rows(sql,`SELECT COUNT(*) AS n FROM "${table}"`)[0].n, b=rows(sql,`SELECT COUNT(*) AS n FROM "${expected}"`)[0].n;
        if (a!==b || rows(sql,`SELECT 1 FROM (SELECT * FROM "${table}" EXCEPT SELECT * FROM "${expected}") LIMIT 1`).length || rows(sql,`SELECT 1 FROM (SELECT * FROM "${expected}" EXCEPT SELECT * FROM "${table}") LIMIT 1`).length) throw Error('Synthetic staged rows differ');
      }
      if (!already) sql.exec('UPDATE mapi_test_archive_target SET checkpoint=? WHERE singleton=1',JSON.stringify({...cp,complete:true}));
    });
  }

  // Test controls are never mounted in the application or a deployed Worker.
  async abortAfterNextImport() { this.#abortAfterImport=1; }
  async abortAfterImports(count) { if (!Number.isSafeInteger(count) || count < 1 || count > 2) throw Error('Invalid fixture interruption count'); this.#abortAfterImport=count; }
  async fixtureState() {
    const sql=this.ctx.storage.sql;
    return { checkpoint:await this.load(), users:rows(sql,'SELECT id,name FROM users ORDER BY id'), events:rows(sql,'SELECT CAST(id AS TEXT) AS id,payload FROM events ORDER BY id'), importer:chunkImportStatus(this.ctx.storage,this.#target().config.commitment.projectId), inserts:rows(sql,'SELECT kind, COUNT(*) AS count FROM mapi_test_insert_audit GROUP BY kind ORDER BY kind') };
  }
  async corruptCheckpointForTest(value) { this.ctx.storage.sql.exec('UPDATE mapi_test_archive_target SET checkpoint=? WHERE singleton=1',value); }
  async restoreRowsForTest() { this.ctx.storage.sql.exec("UPDATE users SET name='Alice' WHERE id='u1'"); }
  async corruptRowsForTest() { this.ctx.storage.sql.exec("UPDATE users SET name='tampered' WHERE id='u1'"); }
}
