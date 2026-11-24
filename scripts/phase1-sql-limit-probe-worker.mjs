import { DurableObject } from 'cloudflare:workers';
import { execute } from '../worker/sql.js';

const encode = new TextEncoder();
const bytes = value => encode.encode(value).length;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const rejects = (action, match) => {
  try { action(); } catch (error) {
    if (match && !String(error).includes(match)) throw error;
    return String(error);
  }
  throw new Error('Expected rejected SQL');
};
const sizedSQL = (prefix, suffix, size) => {
  const missing = size - bytes(prefix) - bytes(suffix);
  assert(missing >= 0, 'Invalid SQL test length');
  return prefix + 'x'.repeat(missing) + suffix;
};
const request = (statement, args = [], query = true) => ({ statement, args, query });

export class SQLLimitProbe extends DurableObject {
  runEscapedTextReturningExact(kind = 'blob-tag') {
    const storage=this.ctx.storage, sql=storage.sql, textBytes=8388636, abort='rollback boundary proof';
    sql.exec('CREATE TABLE IF NOT EXISTS pinned_text_escape(value TEXT)');
    sql.exec('CREATE TABLE IF NOT EXISTS pinned_text_audit(count INTEGER NOT NULL)');
    sql.exec('DELETE FROM pinned_text_escape'); sql.exec('DELETE FROM pinned_text_audit'); sql.exec('INSERT INTO pinned_text_audit VALUES(0)');
    sql.exec('CREATE TRIGGER IF NOT EXISTS pinned_text_delete AFTER DELETE ON pinned_text_escape BEGIN UPDATE pinned_text_audit SET count=count+1; END');
    const prefix=kind === 'nested' ? "char(0)||'t'||char(0)||'t'" : kind === 'escape-tag' ? "char(0)||'t'" : "char(0)||'b'";
    const expectedPrefix=kind === 'nested' ? '\0t\0t' : kind === 'escape-tag' ? '\0t' : '\0b';
    const bodyBytes=textBytes-expectedPrefix.length;
    const insert=()=>sql.exec(`INSERT INTO pinned_text_escape VALUES (${prefix}||substr(hex(zeroblob((?+1)/2)),1,?))`,bodyBytes,bodyBytes);
    const statement='DELETE FROM pinned_text_escape RETURNING value';
    let directLength, bridgeError;
    try { storage.transactionSync(()=>{insert();directLength=sql.exec(statement).raw().toArray()[0][0].length;throw Error(abort);}); }
    catch(error) { if(error.message!==abort) throw error; }
    assert(directLength===textBytes,'Direct escaped-TEXT payload length changed');
    try { storage.transactionSync(()=>{insert();const value=execute(storage,request(statement)).rows[0][0];assert(value.length===textBytes && value.startsWith(expectedPrefix),'Bridge escaped TEXT changed');throw Error(abort);}); }
    catch(error) { if(error.message!==abort) bridgeError=String(error); }
    const rows=sql.exec('SELECT count(*) AS n FROM pinned_text_escape').one().n, audit=sql.exec('SELECT count FROM pinned_text_audit').one().count;
    assert(rows===0 && audit===0,'Escaped-TEXT boundary probe did not roll back business and audit rows');
    if (!bridgeError) {
      storage.transactionSync(()=>{insert();const value=execute(storage,request(statement)).rows[0][0];assert(value.length===textBytes && value.startsWith(expectedPrefix),'Committed tagged TEXT changed');});
      assert(sql.exec('SELECT count(*) AS n FROM pinned_text_escape').one().n===0 && sql.exec('SELECT count FROM pinned_text_audit').one().count===1,'Committed tagged-TEXT delete or audit count changed');
    }
    return {ok:!bridgeError,error:bridgeError||null,directLength,rows,audit};
  }
  runEscapedBlobReturningExact(repeatedMarker = false, blobBytes = 8388630, tailBytes = 0, wide = false, tailValue = -1, longNames = false, blobAtEnd = false) {
    const storage=this.ctx.storage, sql=storage.sql, abort='rollback boundary proof';
    const extra = wide ? Array.from({length:wide === true ? 50 : wide - 1}, (_, i) => longNames ? `column_identifier_for_test_${i}${longNames === 'extreme' ? '_'.repeat(512) : longNames === 'very' ? '_'.repeat(80) : ''}` : `c${i}`) : [];
    sql.exec(`CREATE TABLE IF NOT EXISTS pinned_blob_shape(value BLOB${extra.map(name => `, ${name}`).join('')})`);
    sql.exec('CREATE TABLE IF NOT EXISTS pinned_blob_audit(count INTEGER NOT NULL)');
    sql.exec('DELETE FROM pinned_blob_shape'); sql.exec('DELETE FROM pinned_blob_audit'); sql.exec('INSERT INTO pinned_blob_audit VALUES(0)');
    sql.exec('CREATE TRIGGER IF NOT EXISTS pinned_blob_delete_audit AFTER DELETE ON pinned_blob_shape BEGIN UPDATE pinned_blob_audit SET count=count+1; END');
    const repeated = repeatedMarker ? new Uint8Array(blobBytes) : null;
    if (repeated) { for (let i=0;i<repeated.length-tailBytes;i+=9) repeated[i]=255; for (let i=0;i<tailBytes;i++) repeated[repeated.length-tailBytes+i]=tailValue < 0 ? i+1 : tailValue; }
    const valueColumn=blobAtEnd ? extra[extra.length-1] : 'value', valueIndex=blobAtEnd ? extra.length : 0;
    const insert=()=>repeated ? sql.exec(`INSERT INTO pinned_blob_shape(${valueColumn}) VALUES (?)`, repeated.buffer) : sql.exec(`INSERT INTO pinned_blob_shape(${valueColumn}) VALUES (CAST(X'FF0000000000000000'||zeroblob(${blobBytes-9}) AS BLOB))`);
    const matches=value=>value.length===blobBytes && value.every((byte,index)=>byte===(tailBytes && index>=blobBytes-tailBytes ? (tailValue < 0 ? index-(blobBytes-tailBytes)+1 : tailValue) : index===0 || (repeatedMarker && index%9===0) ? 255 : 0));
    const statement=`DELETE FROM pinned_blob_shape RETURNING value${extra.map(name => `,${name}`).join('')}`;
    let directLength, bridgeError;
    try { storage.transactionSync(()=>{insert();directLength=sql.exec(statement).raw().toArray()[0][valueIndex].byteLength;throw Error(abort);}); }
    catch(error) { if(error.message!==abort) throw error; }
    assert(directLength===blobBytes,'Direct escaped-BLOB payload length changed');
    try { storage.transactionSync(()=>{insert();const result=execute(storage,request(statement));const value=Uint8Array.fromBase64(result.rows[0][valueIndex].blob);assert(result.columns.length===extra.length+1 && result.rows[0].every((value,index)=>index===valueIndex || value===null),'Bridge wide NULL columns changed');assert(matches(value),'Bridge escaped BLOB changed');throw Error(abort);}); }
    catch(error) { if(error.message!==abort) bridgeError=String(error); }
    const rows=sql.exec('SELECT count(*) AS n FROM pinned_blob_shape').one().n, audit=sql.exec('SELECT count FROM pinned_blob_audit').one().count;
    assert(rows===0 && audit===0,'Escaped-BLOB boundary probe did not roll back business and audit rows');
    if (!bridgeError) {
      storage.transactionSync(()=>{insert();const result=execute(storage,request(statement));assert(result.columns.length===extra.length+1 && result.rows[0].every((value,index)=>index===valueIndex || value===null),'Committed wide NULL columns changed');const value=Uint8Array.fromBase64(result.rows[0][valueIndex].blob);assert(matches(value),'Committed escaped BLOB changed');});
      assert(sql.exec('SELECT count(*) AS n FROM pinned_blob_shape').one().n===0 && sql.exec('SELECT count FROM pinned_blob_audit').one().count===1,'Committed escaped-BLOB delete or audit count changed');
    }
    return {ok:!bridgeError,error:bridgeError||null,directLength,rows,audit};
  }
  runManyIntegerReturningExact() {
    const storage=this.ctx.storage, sql=storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS pinned_many_shape(a,b,c,d,e,payload)');
    sql.exec('CREATE TABLE IF NOT EXISTS pinned_many_audit(count INTEGER NOT NULL)');
    sql.exec('DELETE FROM pinned_many_shape'); sql.exec('DELETE FROM pinned_many_audit'); sql.exec('INSERT INTO pinned_many_audit VALUES(0)');
    sql.exec('CREATE TRIGGER IF NOT EXISTS pinned_many_delete_audit AFTER DELETE ON pinned_many_shape BEGIN UPDATE pinned_many_audit SET count=count+1; END');
    const payloadBytes=8388602, n=payloadBytes-2, abort='rollback boundary proof';
    const insert=()=>sql.exec(`INSERT INTO pinned_many_shape VALUES (0,0,0,0,0,'"'||substr(hex(zeroblob((?+1)/2)),1,?)||'"')`,n,n);
    const statement='DELETE FROM pinned_many_shape RETURNING a,b,c,d,e,payload';
    let directLength, bridgeError;
    try { storage.transactionSync(()=>{insert();directLength=sql.exec(statement).raw().toArray()[0][5].length;throw Error(abort);}); }
    catch(error) { if(error.message!==abort) throw error; }
    assert(directLength===payloadBytes,'Direct multi-integer payload length changed');
    try { storage.transactionSync(()=>{insert();const result=execute(storage,request(statement));assert(result.rows.length===1 && result.rows[0][5].length===payloadBytes && result.rows[0].slice(0,5).every(value=>value?.integer==='0'),'Bridge multi-integer values changed');throw Error(abort);}); }
    catch(error) { if(error.message!==abort) bridgeError=String(error); }
    const rows=sql.exec('SELECT count(*) AS n FROM pinned_many_shape').one().n, audit=sql.exec('SELECT count FROM pinned_many_audit').one().count;
    assert(rows===0 && audit===0,'Multi-integer boundary probe did not roll back business and audit rows');
    return {ok:!bridgeError,error:bridgeError||null,directLength,rows,audit};
  }
  runPinnedReturningExact(kind = 'safe') {
    const storage = this.ctx.storage, sql = storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS pinned_json_shape(project_id TEXT NOT NULL, url TEXT NOT NULL, object_type TEXT, kind TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id,url))');
    sql.exec('CREATE TABLE IF NOT EXISTS pinned_json_audit(count INTEGER NOT NULL)');
    sql.exec('DELETE FROM pinned_json_shape'); sql.exec('DELETE FROM pinned_json_audit'); sql.exec('INSERT INTO pinned_json_audit VALUES(0)');
    sql.exec('CREATE TRIGGER IF NOT EXISTS pinned_json_delete_audit AFTER DELETE ON pinned_json_shape BEGIN UPDATE pinned_json_audit SET count=count+1; END');
    const payloadBytes=8388602, n=payloadBytes-2;
    const createdAt = kind === 'int64' ? '9223372036854775807' : kind === 'real' ? '1.2345678901234567' : '1';
    const insert = () => sql.exec(`INSERT INTO pinned_json_shape VALUES ('p','u',NULL,'user-schema',${createdAt}, '"'||substr(hex(zeroblob((?+1)/2)),1,?)||'"')`,n,n);
    const statement = "DELETE FROM pinned_json_shape WHERE project_id='p' AND url='u' RETURNING project_id,url,object_type,kind,created_at,payload";
    const abort='rollback boundary proof';
    let directLength;
    try { storage.transactionSync(() => { insert(); const row=sql.exec(statement).raw().toArray()[0]; directLength=row[5].length; assert(sql.exec('SELECT count FROM pinned_json_audit').one().count===1,'Direct delete audit missing'); throw Error(abort); }); }
    catch(e) { if(e.message!==abort) throw e; }
    assert(directLength===payloadBytes,'Direct JSON payload length changed');
    let bridgeError;
    try { storage.transactionSync(() => { insert(); const result=execute(storage,request(statement)); assert(result.rows.length===1 && result.rows[0][5].length===payloadBytes,'Bridge JSON payload changed'); assert(sql.exec('SELECT count FROM pinned_json_audit').one().count===1,'Bridge delete audit missing'); throw Error(abort); }); }
    catch(e) { if(e.message!==abort) bridgeError=String(e); }
    const rows=sql.exec('SELECT count(*) AS n FROM pinned_json_shape').one().n;
    const audit=sql.exec('SELECT count FROM pinned_json_audit').one().count;
    assert(rows===0 && audit===0,'Boundary probe did not roll back business and audit rows');
    if (!bridgeError) {
      storage.transactionSync(() => {
        insert();
        const result=execute(storage,request(statement));
        assert(result.rows.length===1 && result.rows[0][0]==='p' && result.rows[0][1]==='u' && result.rows[0][2]===null &&
          result.rows[0][3]==='user-schema' && (kind === 'real' ? result.rows[0][4]===Number(createdAt) : result.rows[0][4]?.integer===createdAt) && result.rows[0][5].length===payloadBytes &&
          result.rows[0][5][0]==='"' && result.rows[0][5][payloadBytes-1]==='"','Committed bridge RETURNING values changed');
      });
      assert(sql.exec('SELECT count(*) AS n FROM pinned_json_shape').one().n===0 && sql.exec('SELECT count FROM pinned_json_audit').one().count===1,'Committed delete or audit count changed');
    }
    return {ok:!bridgeError, error:bridgeError || null, directLength, rows, audit};
  }
  run() {
    const storage = this.ctx.storage, sql = storage.sql;
    storage.transactionSync(() => {
      sql.exec('CREATE TABLE IF NOT EXISTS limit_probe_business (id INTEGER PRIMARY KEY)');
      sql.exec('CREATE TABLE IF NOT EXISTS limit_probe_audit (id INTEGER PRIMARY KEY)');
      sql.exec('DELETE FROM limit_probe_business');
      sql.exec('DELETE FROM limit_probe_audit');
    });
    // Cursor implementations must not leak internal staging writes into
    // SQLite connection-local state, either between source rows or afterward.
    sql.exec('CREATE TABLE IF NOT EXISTS limit_probe_connection (id INTEGER PRIMARY KEY)');
    sql.exec('DELETE FROM limit_probe_connection');
    sql.exec('INSERT INTO limit_probe_connection VALUES (123456789),(123456790),(123456791)');
    const connectionState = () => sql.exec('SELECT changes() AS changes, last_insert_rowid() AS rowid').one();
    const before = connectionState();
    assert(before.changes === 3 && before.rowid === 123456791, 'Connection-state fixture failed');
    const stateQuery = 'SELECT id, changes() AS changes, last_insert_rowid() AS rowid FROM limit_probe_connection ORDER BY id';
    const directStateRows = sql.exec(stateQuery).raw().toArray();
    assert(JSON.stringify(directStateRows) === JSON.stringify([123456789, 123456790, 123456791].map(id => [id, 3, 123456791])), 'Direct SQLite connection-state oracle changed');
    const afterDirect = connectionState();
    const bridgedStateRows = execute(storage, request(stateQuery)).rows;
    const afterBridge = connectionState();
    const expectedStateRows = directStateRows.map(row => row.map(value => ({ integer: String(value) })));
    assert(JSON.stringify(bridgedStateRows) === JSON.stringify(expectedStateRows), 'Bridge changed connection-local state between SELECT rows');
    assert(JSON.stringify(afterDirect) === JSON.stringify(before) && JSON.stringify(afterBridge) === JSON.stringify(before), 'Bridge SELECT changed connection-local state');
    const wideNames = Array.from({ length: 100 }, (_, index) => `c${index}`);
    const wideSchema = wideNames.map((name, index) => `${name} ${index === 0 || index === 5 ? 'INTEGER' : index === 1 ? 'BLOB' : index === 3 ? 'REAL' : 'TEXT'}`).join(',');
    sql.exec(`CREATE TABLE IF NOT EXISTS limit_probe_wide (${wideSchema})`);
    sql.exec('DELETE FROM limit_probe_wide');
    sql.exec('CREATE TABLE IF NOT EXISTS limit_probe_trigger (count INTEGER NOT NULL)');
    sql.exec('DELETE FROM limit_probe_trigger');
    sql.exec('INSERT INTO limit_probe_trigger VALUES (0)');
    sql.exec('CREATE TRIGGER IF NOT EXISTS limit_probe_after_insert AFTER INSERT ON limit_probe_wide BEGIN UPDATE limit_probe_trigger SET count = count + 1; END');
    sql.exec('CREATE TRIGGER IF NOT EXISTS limit_probe_after_business AFTER INSERT ON limit_probe_business BEGIN INSERT INTO limit_probe_audit VALUES (new.id + 1000); END');
    rejects(() => sql.exec(`CREATE TABLE limit_probe_invalid (${Array.from({ length: 101 }, (_, index) => `c${index} TEXT`).join(',')})`), 'too many columns');
    const wideValues = wideNames.map((_name, index) => index === 0 ? "CAST('-9223372036854775808' AS INTEGER)" : index === 1 ? "x'00FF'" : index === 2 ? "'text' || char(0) || 'tail'" : index === 3 ? '0.25' : index === 4 ? "'9007199254740993'" : index === 5 ? "CAST('9223372036854775807' AS INTEGER)" : index === 6 ? "'🙂 𐀀'" : index === 7 ? "'{not-valid-json: [}'" : 'NULL');
    const names = wideNames.join(',');
    const inserted = execute(storage, request(`INSERT INTO limit_probe_wide (${names}) VALUES (${wideValues.join(',')}) RETURNING ${names}`));
    assert(inserted.columns.length === 100 && inserted.rows.length === 1, 'Wide RETURNING shape changed');
    const expected = [{ integer: '-9223372036854775808' }, { blob: 'AP8=' }, 'text\0tail', 0.25, '9007199254740993', { integer: '9223372036854775807' }, '🙂 𐀀', '{not-valid-json: [}', null];
    assert(JSON.stringify(inserted.rows[0].slice(0, 9)) === JSON.stringify(expected), 'Wide RETURNING types changed');
    const selected = execute(storage, request(`SELECT ${names} FROM limit_probe_wide`));
    assert(JSON.stringify(selected.rows) === JSON.stringify(inserted.rows), 'Wide SELECT types differ from RETURNING');
    assert(sql.exec('SELECT count(*) AS n FROM limit_probe_wide').one().n === 1, 'RETURNING write ran more than once');
    assert(sql.exec('SELECT count FROM limit_probe_trigger').one().count === 1, 'RETURNING triggered more than one write');
    const duplicates = execute(storage, request(`SELECT ${wideNames.map(name => `${name} AS repeated`).join(',')} FROM limit_probe_wide`));
    assert(duplicates.columns.length === 100 && duplicates.columns.every(name => name === 'repeated'), 'Duplicate column names changed');
    assert(JSON.stringify(duplicates.rows) === JSON.stringify(inserted.rows), 'Duplicate-name result values changed');
    // A 64-column RETURNING uses the full encoding when its SQL fits. Check
    // integer extrema, BLOB, REAL, embedded NUL and NULL alongside one write.
    const columns64 = wideNames.slice(0, 64);
    const values64 = wideValues.slice(0, 64);
    sql.exec(`CREATE TABLE IF NOT EXISTS limit_probe_64 (${wideSchema.split(',').slice(0,64).join(',')})`);
    sql.exec('DELETE FROM limit_probe_64');
    sql.exec('CREATE TRIGGER IF NOT EXISTS limit_probe_64_after_insert AFTER INSERT ON limit_probe_64 BEGIN UPDATE limit_probe_trigger SET count = count + 1; END');
    const triggerBefore64 = sql.exec('SELECT count FROM limit_probe_trigger').one().count;
    const result64 = execute(storage, request(`INSERT INTO limit_probe_64 (${columns64.join(',')}) VALUES (${values64.join(',')}) RETURNING ${columns64.join(',')}`));
    assert(result64.columns.length === 64 && JSON.stringify(result64.rows[0].slice(0,9)) === JSON.stringify(expected), '64-column RETURNING changed types');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_64').one().n === 1 && sql.exec('SELECT count FROM limit_probe_trigger').one().count === triggerBefore64 + 1, '64-column RETURNING executed more than once');
    // Exercise a wide correlated rewrite with names also used as internal
    // aliases. Each suffix byte cycles across all 256 values and v crosses
    // every supported signed-width boundary. Rollback and commit must
    // produce the same values and trigger exactly one effect per row.
    const collisionColumns = ['id','v','l','m', ...Array.from({length:62}, (_, i) => `z${i}`)];
    sql.exec(`CREATE TABLE wide_scope_probe (id INTEGER PRIMARY KEY,v,l,m,${Array.from({length:62}, (_, i) => `z${i}`).join(',')})`);
    sql.exec('CREATE TABLE wide_scope_audit (n INTEGER NOT NULL)'); sql.exec('INSERT INTO wide_scope_audit VALUES(0)');
    sql.exec('CREATE TRIGGER wide_scope_delete AFTER DELETE ON wide_scope_probe BEGIN UPDATE wide_scope_audit SET n=n+1; END');
    const scopeMarker = [255,0,0,0,0,0,0,0,0];
    const scopeInts = ['-9223372036854775808','-140737488355329','-140737488355328','-2147483649','-2147483648','-8388609','-8388608','-32769','-32768','-129','-128','-1','0','1','127','128','32767','32768','8388607','8388608','2147483647','2147483648','140737488355327','140737488355328','9223372036854775807'];
    const scopeValues = [];
    let integerSeed=0xaad8236710fe85c9n;
    for (let i=0;i<256;i++) {
      const tail = Array.from({length:8}, (_, index) => (i + index * 37) & 255);
      const value = Uint8Array.from([...scopeMarker, ...tail]);
      integerSeed=BigInt.asUintN(64,integerSeed*6364136223846793005n+1442695040888963407n);
      const integer = i<scopeInts.length ? scopeInts[i] : BigInt.asIntN(64,integerSeed).toString();
      scopeValues.push({integer, blob:value.toBase64()});
      sql.exec('INSERT INTO wide_scope_probe(id,v,l,m) VALUES (?, CAST(? AS INTEGER), ?, ?)', i, integer, value.buffer, 'text\0' + i);
    }
    // Values shaped like the unified tag, its nested escape, and its
    // unprefixed form must remain data through a wide result.
    for (const first of [1,2,257,512]) for (const second of [1,2,256]) {
      const tag = [...scopeMarker,255,...Array.from({length:first},()=>scopeMarker).flat(),0,...Array.from({length:second},()=>scopeMarker).flat(),0,255,83,0,255,83];
      for (const source of [tag,[...scopeMarker,...tag],tag.slice(9)]) {
        const id=scopeValues.length, value=Uint8Array.from(source), integer=scopeInts[id % scopeInts.length];
        scopeValues.push({integer, blob:value.toBase64()});
        sql.exec('INSERT INTO wide_scope_probe(id,v,l,m) VALUES (?, CAST(? AS INTEGER), ?, ?)', id, integer, value.buffer, 'text\0' + id);
      }
    }
    // Cross the low-count rollover for every compact tail shape in the
    // actual wide codec, including zero, padding and suffix-byte paths.
    for (const count of [65535,65536]) for (const tail of [[],[0,255,83],[0,255,83,0],[0,255,83,0,255,83],[0,255,83,0,255,83,0,255]]) {
      const id=scopeValues.length, value=new Uint8Array(count*9+tail.length), integer=scopeInts[id % scopeInts.length];
      for (let i=0;i<count*9;i+=9) value[i]=255;
      value.set(tail,count*9); scopeValues.push({integer,blob:value.toBase64()});
      sql.exec('INSERT INTO wide_scope_probe(id,v,l,m) VALUES (?, CAST(? AS INTEGER), ?, ?)', id, integer, value.buffer, 'text\0'+id);
    }
    // UPDATE must observe each updated row through the correlated rewrite,
    // including columns named like its internal aliases.
    sql.exec('CREATE TABLE wide_scope_update_audit (n INTEGER NOT NULL)'); sql.exec('INSERT INTO wide_scope_update_audit VALUES(0)');
    sql.exec('CREATE TRIGGER wide_scope_update AFTER UPDATE ON wide_scope_probe BEGIN UPDATE wide_scope_update_audit SET n=n+1; END');
    const scopeUpdate = () => execute(storage, request(`UPDATE wide_scope_probe SET m=m||'#' WHERE id<3 RETURNING ${collisionColumns.join(',')}`));
    const checkUpdate = result => {
      assert(result.columns.length===66 && result.rows.length===3, 'Wide update result shape changed');
      for (const row of result.rows) {
        const id=Number(row[0]?.integer), expected=scopeValues[id];
        assert(id>=0 && id<3 && row[1]?.integer===expected.integer && row[2]?.blob===expected.blob && row[3]==='text\0'+id+'#', `Wide updated row changed at ${id}`);
      }
    };
    try { storage.transactionSync(() => { checkUpdate(scopeUpdate()); assert(sql.exec('SELECT n FROM wide_scope_update_audit').one().n===3, 'Wide update trigger count changed'); throw Error('update rollback'); }); }
    catch(error) { if(error.message!=='update rollback') throw error; }
    assert(sql.exec('SELECT n FROM wide_scope_update_audit').one().n===0, 'Wide update rollback changed audit');
    checkUpdate(scopeUpdate());
    assert(sql.exec('SELECT n FROM wide_scope_update_audit').one().n===3, 'Wide update ran more than once');
    const checkScope = result => {
      assert(result.columns.length===66 && result.rows.length===scopeValues.length, 'Wide scope result shape changed');
      for (const row of result.rows) {
        const id = Number(row[0]?.integer), expected = scopeValues[id];
        assert(expected && row[1]?.integer===expected.integer && row[2]?.blob===expected.blob && row[3]==='text\0'+id+(id<3?'#':'') && row.slice(4).every(value=>value===null), `Wide scope data changed at ${id}`);
      }
    };
    const scopeDelete = () => execute(storage, request(`DELETE FROM wide_scope_probe RETURNING ${collisionColumns.join(',')}`));
    try { storage.transactionSync(() => { checkScope(scopeDelete()); throw Error('scope rollback'); }); }
    catch(error) { if(error.message!=='scope rollback') throw error; }
    assert(sql.exec('SELECT COUNT(*) AS n FROM wide_scope_probe').one().n===scopeValues.length && sql.exec('SELECT n FROM wide_scope_audit').one().n===0, 'Wide scope rollback changed rows or audit');
    checkScope(scopeDelete());
    assert(sql.exec('SELECT COUNT(*) AS n FROM wide_scope_probe').one().n===0 && sql.exec('SELECT n FROM wide_scope_audit').one().n===scopeValues.length, 'Wide scope delete ran more than once');
    // Long names take the nested correlated form. Test byte and integer
    // boundaries, per-row update scope, rollback and trigger side effects.
    const longScopeNames=Array.from({length:65},(_,i)=>`wide_scope_long_identifier_${i}${'_'.repeat(80)}`);
    const longScopeColumns=['id',...longScopeNames];
    sql.exec(`CREATE TABLE wide_long_scope (id INTEGER PRIMARY KEY,${longScopeNames.join(',')})`);
    sql.exec('CREATE TABLE wide_long_audit (updated INTEGER NOT NULL,deleted INTEGER NOT NULL)'); sql.exec('INSERT INTO wide_long_audit VALUES(0,0)');
    sql.exec('CREATE TRIGGER wide_long_update AFTER UPDATE ON wide_long_scope BEGIN UPDATE wide_long_audit SET updated=updated+1; END');
    sql.exec('CREATE TRIGGER wide_long_delete AFTER DELETE ON wide_long_scope BEGIN UPDATE wide_long_audit SET deleted=deleted+1; END');
    for (let i=0;i<256;i++) {
      const tail=Array.from({length:8},(_,index)=>(i+index*37)&255), value=Uint8Array.from([...scopeMarker,...tail]), integer=scopeValues[i].integer;
      sql.exec(`INSERT INTO wide_long_scope(id,${longScopeNames.slice(0,3).join(',')}) VALUES (?, ?, CAST(? AS INTEGER), ?)`,i,value.buffer,integer,'text\0'+i);
    }
    const longUpdate=()=>execute(storage,request(`UPDATE wide_long_scope SET ${longScopeNames[2]}=${longScopeNames[2]}||'#' WHERE id<3 RETURNING ${longScopeColumns.join(',')}`));
    const checkLongUpdate=result=>{
      assert(result.columns.length===66 && result.rows.length===3,'Long-name update shape changed');
      for(const row of result.rows) { const id=Number(row[0]?.integer), expected=scopeValues[id]; assert(id>=0 && id<3 && row[1]?.blob===expected.blob && row[2]?.integer===expected.integer && row[3]==='text\0'+id+'#','Long-name updated row changed'); }
    };
    try { storage.transactionSync(()=>{checkLongUpdate(longUpdate()); throw Error('long update rollback');}); } catch(error) { if(error.message!=='long update rollback') throw error; }
    assert(sql.exec('SELECT updated FROM wide_long_audit').one().updated===0,'Long-name update rollback changed audit');
    checkLongUpdate(longUpdate()); assert(sql.exec('SELECT updated FROM wide_long_audit').one().updated===3,'Long-name update ran more than once');
    const longDelete=()=>execute(storage,request(`DELETE FROM wide_long_scope RETURNING ${longScopeColumns.join(',')}`));
    const checkLongDelete=result=>{
      assert(result.columns.length===66 && result.rows.length===256,'Long-name delete shape changed');
      for(const row of result.rows) { const id=Number(row[0]?.integer), expected=scopeValues[id]; assert(expected && row[1]?.blob===expected.blob && row[2]?.integer===expected.integer && row[3]==='text\0'+id+(id<3?'#':'') && row.slice(4).every(value=>value===null),`Long-name delete changed row ${id}`); }
    };
    try { storage.transactionSync(()=>{checkLongDelete(longDelete());throw Error('long delete rollback');}); } catch(error) { if(error.message!=='long delete rollback') throw error; }
    assert(sql.exec('SELECT deleted FROM wide_long_audit').one().deleted===0 && sql.exec('SELECT COUNT(*) AS n FROM wide_long_scope').one().n===256,'Long-name delete rollback changed rows or audit');
    checkLongDelete(longDelete()); assert(sql.exec('SELECT deleted FROM wide_long_audit').one().deleted===256,'Long-name delete ran more than once');
    // RETURNING uses compact type tags so an ordinary near-limit TEXT value
    // is not copied into a wider record merely to carry its SQLite type.
    // Exercise SQLite's dynamic types, tag collisions and binary64 round trips.
    sql.exec('CREATE TABLE IF NOT EXISTS compact_returning_integer (value)');
    for (const decimal of ['-9223372036854775808', '-9007199254740992', '-140737488355329', '-140737488355328', '-2147483649', '-2147483648', '-8388609', '-8388608', '-32769', '-32768', '-129', '-128', '-1', '0', '1', '127', '128', '32767', '32768', '8388607', '8388608', '2147483647', '2147483648', '140737488355327', '140737488355328', '9007199254740991', '9007199254740992', '9223372036854775807']) {
      const result = execute(storage, request(`INSERT INTO compact_returning_integer VALUES (CAST('${decimal}' AS INTEGER)) RETURNING value`));
      assert(result.rows[0][0]?.integer === decimal, `Compact RETURNING integer changed: ${decimal}`);
    }
    sql.exec('CREATE TABLE IF NOT EXISTS compact_returning_text (value TEXT)');
    for (const value of ['', '\0', '\0b', '\0b00', '\0bFF00', '\0b'+'A'.repeat(16), '\0b'+'A'.repeat(17), '\0b'+'🙂'.repeat(5), '\0t', '\0tfoo', '\0t\0b01', '\0t\0b'+'🙂'.repeat(5), '\0t\0tfoo', '\0i1', '\0r3', 'i42', '🙂', 'x\0y']) {
      const result = execute(storage, request('INSERT INTO compact_returning_text VALUES (?1) RETURNING value', [{ kind: 'value', value }]));
      assert(result.rows[0][0] === value, 'Compact RETURNING text tag collided');
    }
    sql.exec('CREATE TABLE IF NOT EXISTS compact_returning_blob (value BLOB)');
    for (let length = 0; length <= 24; length++) for (const first of [0, 127, 255]) {
      const value = new Uint8Array(length);
      for (let i = 0; i < length; i++) value[i] = (first + i * 73) & 255;
      const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
      assert(result.rows[0][0]?.blob === value.toBase64(), `Compact RETURNING BLOB tag collided at length ${length}`);
    }
    for (const suffix of [[], [255], [0, 255, 0]]) {
      const value = Uint8Array.from([255, 0, 0, 0, 0, 0, 0, 0, 0, ...suffix]);
      const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
      assert(result.rows[0][0]?.blob === value.toBase64(), 'Compact RETURNING BLOB escape-prefix collision');
    }
    for (let byte = 0; byte < 256; byte++) {
      const value = Uint8Array.of(byte);
      const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
      assert(result.rows[0][0]?.blob === value.toBase64(), `Compact RETURNING one-byte BLOB changed: ${byte}`);
    }
    const marker = [255, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let count = 1; count <= 4; count++) for (let length = 0; length <= 12; length++) {
      for (const extra of [[], [13, ...marker, 0, 255]]) {
        const value = Uint8Array.from([...Array.from({length:count}, () => marker).flat(), ...extra, ...Array.from({length}, (_, i) => (i * 97) & 255)]);
        const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
        assert(result.rows[0][0]?.blob === value.toBase64(), `Compact RETURNING repeated-marker BLOB changed at ${count}/${length}`);
      }
    }
    // Every possible final byte and interspersed byte must survive. A byte
    // before the final marker is not a trailing byte and must not be compacted.
    for (let byte = 0; byte < 256; byte++) for (const count of [1, 2, 4]) {
      const run = Array.from({length:count}, () => marker).flat();
      for (const source of [[...run, byte], [...run, byte, ...marker]]) {
        const value = Uint8Array.from(source);
        const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
        assert(result.rows[0][0]?.blob === value.toBase64(), `Compact marker-run byte changed: ${count}/${byte}`);
      }
    }
    // Two trailing bytes may contain zero or marker bytes. Interspersed
    // bytes must never be mistaken for a suffix, even with a final marker.
    for (let byte = 0; byte < 256; byte++) {
      for (const tail of [[0, byte], [255, byte], [byte, 0], [byte, 255], [byte, 255-byte]]) {
        for (const source of [[...marker, ...marker, ...tail], [...marker, tail[0], ...marker, tail[1]], [...marker, ...tail, ...marker]]) {
          const value = Uint8Array.from(source);
          const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
          assert(result.rows[0][0]?.blob === value.toBase64(), `Compact two-byte marker-run changed: ${tail}`);
        }
      }
    }
    // Test three/four-byte tails, including the tag padding value.
    // Bytes before the final marker must not be mistaken for a suffix.
    for (let byte = 0; byte < 256; byte++) {
      for (const tail of [[byte, 0, 83], [255, byte, 83], [0, byte, 255], [byte, 0, 255, 83], [255, byte, 0, 83]]) {
        for (const source of [[...marker, ...marker, ...tail], [...marker, tail[0], ...marker, ...tail.slice(1)], [...marker, ...tail, ...marker]]) {
          const value = Uint8Array.from(source);
          const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
          assert(result.rows[0][0]?.blob === value.toBase64(), `Compact long marker-tail changed: ${tail}`);
        }
      }
    }
    // Six trailing bytes include every possible byte at each position;
    // a marker after an interspersed byte must not be treated as a run.
    for (let byte = 0; byte < 256; byte++) for (let index = 0; index < 6; index++) {
      const tail = [0, 255, 83, 0, 255, 83]; tail[index] = byte;
      for (const source of [[...marker, ...marker, ...tail], [...marker, tail[0], ...marker, ...tail.slice(1)]]) {
        const value = Uint8Array.from(source);
        const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
        assert(result.rows[0][0]?.blob === value.toBase64(), `Six-byte marker-tail changed: ${index}/${byte}`);
      }
    }
    // Counts crossing the two-byte boundary exercise the marker-count field.
    for (const count of [65535, 65536, 131071, 131072]) for (const tail of [[], [0, 255, 83], [0, 255, 83, 0], [0, 255, 83, 0, 255, 83]]) {
      const value = new Uint8Array(count * 9 + tail.length);
      for (let i = 0; i < count * 9; i += 9) value[i] = 255;
      value.set(tail, count * 9);
      const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
      assert(result.rows[0][0]?.blob === value.toBase64(), `Compact marker-count boundary changed: ${count}/${tail.length}`);
    }
    // Tags with low count bytes FF 00, maximal marker counts, flags and
    // nested prefixes remain source data, not synthetic compressed runs.
    for (const markers of [1, 2, 3, 29, 255, 256, 257]) for (const low of [[0, 0], [255, 0], [255, 255]]) {
      for (const tail of [[], [0], [255, 83], [0, 255, 83, 83], [0, 255, 83, 0, 255, 83]]) {
        const tag = [...marker, ...low, ...Array.from({length:markers}, () => marker).flat(), ...tail];
        for (const source of [tag, [...marker, ...tag], [...low, ...Array.from({length:markers}, () => marker).flat(), ...tail]]) {
          const value = Uint8Array.from(source);
          const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
          assert(result.rows[0][0]?.blob === value.toBase64(), `Marker-count tag collision: ${markers}/${low}/${tail.length}`);
        }
      }
    }
    // Eight-byte suffixes exercise both independently encoded marker-run
    // lengths and interspersed data, including every possible byte.
    for (let byte = 0; byte < 256; byte++) for (let index = 0; index < 8; index++) {
      const tail = [0, 255, 83, 0, 255, 83, 0, 255]; tail[index] = byte;
      for (const source of [[...marker, ...marker, ...tail], [...marker, tail[0], ...marker, ...tail.slice(1)]]) {
        const value = Uint8Array.from(source);
        const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
        assert(result.rows[0][0]?.blob === value.toBase64(), `Eight-byte marker-tail changed: ${index}/${byte}`);
      }
    }
    // The eight-byte format has two marker runs separated by count bytes.
    for (const first of [1, 2, 255, 256, 257]) for (const second of [1, 2, 255, 256]) for (const low of [0, 255]) {
      const tag = [...marker, low, ...Array.from({length:first}, () => marker).flat(), low, ...Array.from({length:second}, () => marker).flat(), 0, 255, 83, 0, 255, 83];
      for (const source of [tag, [...marker, ...tag], tag.slice(9)]) {
        const value = Uint8Array.from(source);
        const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
        assert(result.rows[0][0]?.blob === value.toBase64(), `Eight-byte tag collision: ${first}/${second}/${low}`);
      }
    }
    // A real source BLOB may itself look exactly like a compact run tag. It
    // must be returned as data, not expanded as if it were a marker run.
    for (const count of [0, 1, 2, 257, 65535, 8388607, 8388608, 8388609]) {
      const encodedCount = [(count >>> 16) & 255, (count >>> 8) & 255, count & 255];
      for (const source of [[...marker, 83, ...marker, ...encodedCount], [...marker, ...marker, 83, ...marker, ...encodedCount], [83, ...marker, ...encodedCount], ...[[], [0], [255]].flatMap(tail => [[...marker, ...encodedCount, ...marker, ...tail], [...marker, ...marker, ...encodedCount, ...marker, ...tail], [...encodedCount, ...marker, ...tail]])]) {
        const value = Uint8Array.from(source);
        const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
        assert(result.rows[0][0]?.blob === value.toBase64(), `Compact run-tag collision for count ${count}`);
      }
      for (const tail of [[0, 0], [0, 255], [255, 0], [255, 255]]) {
        const tag = [...marker, ...encodedCount, ...marker, ...tail, 83];
        for (const source of [tag, [...marker, ...tag], [...encodedCount, ...marker, ...tail, 83]]) {
          const value = Uint8Array.from(source);
          const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
          assert(result.rows[0][0]?.blob === value.toBase64(), `Two-byte compact tag collision for count ${count}`);
        }
      }
      for (const tail of [[0, 0, 83], [255, 0, 255], [0, 255, 0, 83, 83], [255, 255, 0, 0, 83]]) {
        const tag = [...marker, ...encodedCount, ...marker, ...tail];
        for (const source of [tag, [...marker, ...tag], [...encodedCount, ...marker, ...tail]]) {
          const value = Uint8Array.from(source);
          const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
          assert(result.rows[0][0]?.blob === value.toBase64(), `Long compact tag collision for count ${count}`);
        }
      }
    }
    let blobSeed = 0x2c71e895;
    for (let sample = 0; sample < 512; sample++) {
      const value = new Uint8Array(9 + (sample % 193));
      for (let i = 0; i < value.length; i++) { blobSeed = (Math.imul(blobSeed, 1664525) + 1013904223) >>> 0; value[i] = blobSeed >>> 24; }
      value.set(marker);
      if (value.length >= 28 && sample % 3 === 0) value.set(marker, 12);
      const result = execute(storage, request('INSERT INTO compact_returning_blob VALUES (?1) RETURNING value', [{ kind: 'blob', value: value.toBase64() }]));
      assert(result.rows[0][0]?.blob === value.toBase64(), `Compact RETURNING arbitrary-byte BLOB changed at sample ${sample}`);
    }
    sql.exec('CREATE TABLE IF NOT EXISTS compact_returning_real (id INTEGER PRIMARY KEY, value REAL)');
    const bits = new DataView(new ArrayBuffer(8));
    let seed = 0x7fa31c42;
    for (let i = 0; i < 2048; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bits.setUint32(0, seed);
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bits.setUint32(4, seed);
      const value = bits.getFloat64(0);
      if (!Number.isFinite(value)) continue;
      sql.exec('INSERT INTO compact_returning_real VALUES (?, ?)', i, value);
      const expected = sql.exec('SELECT value FROM compact_returning_real WHERE id = ?', i).one().value;
      const actual = execute(storage, request('DELETE FROM compact_returning_real WHERE id = ?1 RETURNING value', [{ kind: 'value', value: i }])).rows[0][0];
      assert(Object.is(actual, expected), `Compact RETURNING REAL changed at sample ${i}`);
    }
    for (const expression of ['1e999', '-1e999', '-0.0', '0.0', '1.0', '-1.0', '4.9406564584124654e-324']) {
      sql.exec(`INSERT INTO compact_returning_real VALUES (1, ${expression})`);
      const expected = sql.exec('SELECT value FROM compact_returning_real').one().value;
      const actual = execute(storage, request('DELETE FROM compact_returning_real RETURNING value')).rows[0][0];
      assert(Object.is(actual, expected), `Compact RETURNING REAL edge changed: ${expression}`);
    }
    const largeBlob = execute(storage, request('SELECT ' + Array.from({ length: 51 }, (_, index) => index === 0 ? 'zeroblob(8000000) AS c0' : `${index} AS c${index}`).join(',')));
    assert(largeBlob.rows[0][0]?.blob?.length === 10666668, 'Wide BLOB was not preserved');
    const largeText = execute(storage, request('SELECT ' + Array.from({ length: 51 }, (_, index) => index === 0 ? 'CAST(zeroblob(8000000) AS TEXT) AS c0' : `${index} AS c${index}`).join(',')));
    assert(largeText.rows[0][0].length === 8000000 && largeText.rows[0][0][7999999] === '\0', 'Wide text was not preserved');
    rejects(() => execute(storage, request('SELECT ' + Array.from({ length: 101 }, (_, index) => `${index} AS c${index}`).join(','))), 'too many columns');

    const raw100k = sizedSQL('SELECT 1 AS value /*é', '*/', 100000);
    assert(sql.exec(raw100k).one().value === 1, 'Direct 100,000-byte SQL failed');
    rejects(() => sql.exec(sizedSQL('SELECT 1 AS value /*é', '*/', 100001)).toArray(), 'statement too long');
    const calls = [];
    const observed = { sql: { exec(statement, ...args) { calls.push(bytes(statement)); return sql.exec(statement, ...args); } } };
    const mkSelect = size => sizedSQL('SELECT ?1 AS value /*é', '*/', size);
    const intArg = [{ kind: 'int', value: '9007199254740993' }];
    const initialSize = 90000;
    assert(execute(observed, request(mkSelect(initialSize), intArg)).rows[0][0].integer === '9007199254740993', 'SQL binding precision changed');
    assert(calls.length === 2, 'SELECT metadata and result statements were not both observed');
    const overhead = calls[1] - initialSize;
    calls.length = 0;
    const boundary = 100000 - overhead;
    assert(execute(observed, request(mkSelect(boundary), intArg)).rows[0][0].integer === '9007199254740993', 'Rewritten 100,000-byte SELECT failed');
    assert(calls[1] === 100000, 'Rewritten SELECT byte limit not reached');
    calls.length = 0;
    rejects(() => execute(observed, request(mkSelect(boundary + 1), intArg)), 'statement too long');
    assert(calls[1] === 100001, 'Rewritten rejected SELECT byte limit differed');

    const mkWrite = (id, size) => sizedSQL(`INSERT INTO limit_probe_audit VALUES (${id}) /*é`, '*/ RETURNING id', size);
    calls.length = 0;
    execute(observed, request(mkWrite(1, 90000)));
    const writeOverhead = calls[0] - 90000;
    const writeBoundary = 100000 - writeOverhead;
    calls.length = 0;
    execute(observed, request(mkWrite(2, writeBoundary)));
    assert(calls[0] === 100000, 'Rewritten RETURNING boundary differed');
    const priorAudits = sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n;
    calls.length = 0;
    rejects(() => storage.transactionSync(() => {
      sql.exec('INSERT INTO limit_probe_business VALUES (1)');
      execute(observed, request(mkWrite(3, writeBoundary + 1)));
    }), 'statement too long');
    assert(calls[0] === 100001, 'Rejected RETURNING statement was not 100,001 bytes');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_business').one().n === 0, 'Rejected write left a business row');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits, 'Rejected write left an audit row');

    // For a wide RETURNING, check the UTF-8 SQL size boundary. If neither
    // codec fits, reject before the write and preserve the trigger count.
    const wideBoundaryNames = ['a','b','c',...Array.from({length:48}, () => 'd')];
    sql.exec('CREATE TABLE limit_probe_wide_boundary (a,b,c,d)');
    sql.exec('CREATE TRIGGER limit_probe_wide_boundary_insert AFTER INSERT ON limit_probe_wide_boundary BEGIN UPDATE limit_probe_trigger SET count = count + 1; END');
    const wideProjection = wideBoundaryNames.join(',');
    const wideValuesForBoundary = ["X'FF00000000000000000102030405060708'", "CAST('9223372036854775807' AS INTEGER)", "'text'", 'NULL'].join(',');
    const wideBoundaryExpected = [{blob: Uint8Array.from([255,0,0,0,0,0,0,0,0,1,2,3,4,5,6,7,8]).toBase64()}, {integer:'9223372036854775807'}, 'text'];
    const checkWideBoundary = result => assert(JSON.stringify(result.rows[0].slice(0,3))===JSON.stringify(wideBoundaryExpected) && result.rows[0].slice(3).every(value=>value===null), 'Wide size test changed values');
    const wideWrite = size => sizedSQL(`INSERT INTO limit_probe_wide_boundary (a,b,c,d) VALUES (${wideValuesForBoundary}) /*é`, `*/ RETURNING ${wideProjection}`, size);
    const initialWideSize = 5000;
    const beforeWideTrigger = sql.exec('SELECT count FROM limit_probe_trigger').one().count;
    calls.length = 0;
    checkWideBoundary(execute(observed, request(wideWrite(initialWideSize))));
    const wideOverhead = calls[0] - initialWideSize;
    const wideBoundary = 100000 - wideOverhead;
    calls.length = 0;
    execute(observed, request(wideWrite(wideBoundary)));
    assert(calls[0] === 100000, 'Full wide RETURNING missed the byte boundary');
    calls.length = 0;
    rejects(() => storage.transactionSync(() => execute(observed, request(wideWrite(wideBoundary + 1)))), 'statement too long');
    assert(calls.length === 1 && calls[0] === 100001, 'Wide RETURNING rejection did not occur at the UTF-8 boundary');
    assert(sql.exec('SELECT count FROM limit_probe_trigger').one().count === beforeWideTrigger + 2, 'Rejected wide RETURNING changed trigger effects');

    // Query-mode must not execute a write hidden in a comment or second SQL
    // statement. The trigger makes accidental writes visible in audit too.
    const hiddenWrites = [
      'INSERT INTO limit_probe_business VALUES (11) -- RETURNING id',
      'INSERT INTO limit_probe_business VALUES (12) /* RETURNING id */',
      'INSERT INTO limit_probe_business VALUES (13) /* RETURNING id',
      'SELECT 1; INSERT INTO limit_probe_business VALUES (14)',
      'WITH x AS (SELECT 1) SELECT * FROM x; INSERT INTO limit_probe_business VALUES (15)',
    ];
    for (const statement of hiddenWrites) rejects(() => execute(storage, request(statement)));
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_business').one().n === 0, 'Query-mode executed a hidden write');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits, 'Query-mode left hidden audit rows');
    const harmless = execute(storage, request("SELECT 'RETURNING id; SELECT 2' AS quoted -- RETURNING id"));
    assert(harmless.rows[0][0] === 'RETURNING id; SELECT 2', 'Quoted/comment SQL changed');

    // A CTE-backed write is row-producing but must never be run once for
    // metadata and again for data. Check both the successful path and an
    // enclosing transaction rollback with the real trigger-backed audit row.
    const cteWrite = 'WITH source(id) AS (SELECT ?1) INSERT INTO limit_probe_business SELECT id FROM source RETURNING id';
    const cteArg = [{ kind: 'int', value: '-9223372036854775808' }];
    let cteCalls = 0;
    const cteObserved = { sql: { exec(statement, ...args) { cteCalls++; return sql.exec(statement, ...args); } } };
    const assertCteResult = () => {
      const result = execute(cteObserved, request(cteWrite, cteArg));
      assert(cteCalls === 1 && result.columns.length === 1 && result.columns[0] === 'id' && result.rows.length === 1 && result.rows[0][0]?.integer === '-9223372036854775808', 'CTE RETURNING executed twice or lost int64 precision');
      assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_business').one().n === 1, 'CTE write count changed');
      assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits + 1, 'CTE audit count changed');
    };
    rejects(() => storage.transactionSync(() => { assertCteResult(); throw Error('CTE rollback probe'); }), 'CTE rollback probe');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_business').one().n === 0, 'CTE rollback left a business row');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits, 'CTE rollback left an audit row');
    cteCalls = 0;
    storage.transactionSync(assertCteResult);
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_business').one().n === 1, 'Committed CTE business row missing');
    assert(sql.exec("SELECT printf('%lld', id) AS id FROM limit_probe_business").one().id === '-9223372036854775808', 'Committed CTE business value changed');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits + 1, 'Committed CTE audit row missing');
    assert(sql.exec("SELECT printf('%lld', id) AS id FROM limit_probe_audit WHERE id < 0").one().id === '-9223372036854774808', 'Committed CTE audit value changed');
    sql.exec('DELETE FROM limit_probe_business');
    sql.exec('DELETE FROM limit_probe_audit WHERE id < 0');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits, 'CTE cleanup altered prior audits');

    // SQLite accepts an unterminated trailing block comment. Its apparent
    // placeholders and semicolons are comment text, and wrappers must not be
    // appended inside it. Include a write to catch accidental double execution.
    const commented = execute(storage, request('SELECT ?1 AS value; /* ?2 ;', [{ kind: 'int', value: '9223372036854775807' }]));
    assert(commented.rows.length === 1 && commented.rows[0][0]?.integer === '9223372036854775807', 'Trailing comment changed a query or parameter');
    const commentLiteral = execute(storage, request("SELECT '/* ?2' AS value /* ?1"));
    assert(commentLiteral.rows[0][0] === '/* ?2', 'Comment-like text in a string changed');
    assert(execute(storage, request('SELECT 7 AS value /*/')).rows[0][0]?.integer === '7', 'Overlapping block-comment delimiter changed a query');
    assert(execute(storage, request('SELECT 8 AS value /**/')).rows[0][0]?.integer === '8', 'Closed empty block comment changed a query');
    let commentedCalls = 0;
    const commentedStorage = { sql: { exec(statement, ...args) { commentedCalls++; return sql.exec(statement, ...args); } } };
    const commentedWrite = () => execute(commentedStorage, request('INSERT INTO limit_probe_business VALUES (?1) RETURNING id /* ?2 ;', [{ kind: 'int', value: '42' }]));
    rejects(() => storage.transactionSync(() => { commentedWrite(); throw Error('Commented write rollback'); }), 'Commented write rollback');
    assert(commentedCalls === 1 && sql.exec('SELECT COUNT(*) AS n FROM limit_probe_business').one().n === 0 && sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits, 'Commented write rollback changed business or audit rows');
    commentedCalls = 0;
    const committedCommentedWrite = storage.transactionSync(commentedWrite);
    assert(commentedCalls === 1 && committedCommentedWrite.rows[0][0]?.integer === '42', 'Trailing comment changed or repeated a RETURNING write');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_business').one().n === 1 && sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits + 1, 'Commented write or audit count changed');
    sql.exec('DELETE FROM limit_probe_business');
    sql.exec('DELETE FROM limit_probe_audit WHERE id = 1042');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits, 'Commented write cleanup altered prior audits');

    // Closed comments, including line comments, are whitespace in a simple
    // RETURNING projection. Preserve duplicate result names and execute once.
    const closedWrite = () => execute(commentedStorage, request('INSERT INTO limit_probe_business VALUES (?1) RETURNING /* ignored ?2 */ id /* middle */, -- next\n id /**/', [{ kind: 'int', value: '43' }]));
    commentedCalls = 0;
    rejects(() => storage.transactionSync(() => { closedWrite(); throw Error('Closed comment rollback'); }), 'Closed comment rollback');
    assert(commentedCalls === 1 && sql.exec('SELECT COUNT(*) AS n FROM limit_probe_business').one().n === 0 && sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits, 'Closed-comment rollback changed business or audit rows');
    commentedCalls = 0;
    const closedResult = storage.transactionSync(closedWrite);
    assert(commentedCalls === 1 && JSON.stringify(closedResult.columns) === JSON.stringify(['id', 'id']) && closedResult.rows[0][0]?.integer === '43' && closedResult.rows[0][1]?.integer === '43', 'Closed comments changed or repeated a RETURNING write');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_business').one().n === 1 && sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits + 1, 'Closed-comment write or audit count changed');
    sql.exec('DELETE FROM limit_probe_business');
    sql.exec('DELETE FROM limit_probe_audit WHERE id = 1043');
    commentedCalls = 0;
    rejects(() => execute(commentedStorage, request('INSERT INTO limit_probe_business VALUES (44) RETURNING id /**/; INSERT INTO limit_probe_business VALUES (45)')));
    assert(commentedCalls === 0 && sql.exec('SELECT COUNT(*) AS n FROM limit_probe_business').one().n === 0 && sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === priorAudits, 'Closed comment hid a second write');

    // sql.exec steps a first row before columnNames is read. The metadata
    // statement must therefore have an effective zero limit, and the real
    // query must be materialized before type encoding inspects each value.
    const statements = [];
    let metadataRowsRead;
    const checked = { sql: { exec(statement, ...args) {
      statements.push(statement);
      const cursor = sql.exec(statement, ...args);
      if (statements.length === 1) metadataRowsRead = cursor.rowsRead;
      return cursor;
    } } };
    const randomQuery = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
      SELECT CASE WHEN random() & 1 THEN CAST('9223372036854775807' AS INTEGER) ELSE 'not-an-integer' END AS value FROM n`;
    const randomRows = execute(checked, request(randomQuery)).rows;
    assert(metadataRowsRead === 0 && randomRows.length === 500, 'Metadata probe evaluated source rows');
    assert(randomRows.every(row => row[0] === 'not-an-integer' || row[0]?.integer === '9223372036854775807'), 'Volatile result was evaluated inconsistently');
    const plan = sql.exec('EXPLAIN QUERY PLAN ' + statements[1]).toArray();
    assert(plan.some(row => /MATERIALIZE mapi_rows/i.test(row.detail)), 'Typed query did not materialize source rows');
    const twoArgs = [{ kind: 'int', value: '1' }, { kind: 'int', value: '2' }];
    const limited = execute(storage, request('SELECT c0 AS repeated,c5 AS repeated FROM limit_probe_wide LIMIT ?2 OFFSET ?1', twoArgs));
    assert(limited.rows.length === 0 && limited.columns[0] === 'repeated' && limited.columns[1] === 'repeated', 'LIMIT/OFFSET metadata changed');
    const commaLimit = execute(storage, request('SELECT c0 AS first FROM limit_probe_wide LIMIT ?1, ?2', [{ kind: 'int', value: '0' }, { kind: 'int', value: '1' }]));
    assert(commaLimit.rows[0][0]?.integer === '-9223372036854775808', 'Comma LIMIT bindings changed');
    sql.exec('CREATE TABLE IF NOT EXISTS mapi_rows (id INTEGER PRIMARY KEY)');
    sql.exec('INSERT OR IGNORE INTO mapi_rows VALUES (17)');
    assert(execute(storage, request('SELECT id FROM mapi_rows')).rows[0][0]?.integer === '17', 'Bridge CTE shadowed a source table');
    assert(execute(storage, request('WITH mapi_rows(id) AS (SELECT 19) SELECT id FROM mapi_rows')).rows[0][0]?.integer === '19', 'Bridge CTE shadowed a source CTE');
    assert(execute(storage, request('WITH replace AS (SELECT 1 AS n) SELECT n FROM replace')).rows[0][0]?.integer === '1', 'CTE named replace was misclassified as a write');
    assert(execute(storage, request('WITH replaceé AS (SELECT 3 AS n) SELECT n FROM replaceé')).rows[0][0]?.integer === '3', 'Unicode keyword-prefix CTE was misclassified');
    assert(execute(storage, request('WITH aſ(x) AS (SELECT 5) SELECT x FROM aſ')).rows[0][0]?.integer === '5', 'Unicode case folding misclassified a CTE identifier');
    assert(execute(storage, request('WITH "replace"(id) AS NOT MATERIALIZED (SELECT 2), q AS MATERIALIZED (SELECT id FROM "replace") SELECT id FROM q')).rows[0][0]?.integer === '2', 'Quoted or multi-CTE query was misclassified');
    assert(execute(storage, request('SELECT 4 AS limité')).rows[0][0]?.integer === '4', 'Unicode keyword-prefix alias was misclassified');
    assert(execute(storage, request('SELECT 6 AS lımıt')).rows[0][0]?.integer === '6', 'Unicode case folding misclassified a LIMIT identifier');

    const p50 = 'a'.repeat(50), p51 = 'a'.repeat(51);
    assert(sql.exec('SELECT ? LIKE ? AS result', p50, p50).one().result === 1, '50-byte LIKE pattern failed');
    rejects(() => sql.exec('SELECT ? LIKE ? AS result', p51, p51).one(), 'pattern too complex');
    assert(sql.exec('SELECT ? GLOB ? AS result', p50, p50).one().result === 1, '50-byte GLOB pattern failed');
    rejects(() => sql.exec('SELECT ? GLOB ? AS result', p51, p51).one(), 'pattern too complex');
    const sqlFunction = n => `SELECT printf(${Array.from({ length: n }, (_, index) => index === 0 ? "'%s'" : "'x'").join(',')}) AS value`;
    assert(sql.exec(sqlFunction(32)).one().value === 'x', '32-argument SQL function failed');
    let function33 = 'accepted';
    try { sql.exec(sqlFunction(33)).one(); } catch { function33 = 'rejected'; }
    sql.exec('CREATE TABLE IF NOT EXISTS limit_probe_large (value BLOB)');
    const largeRows = [];
    for (const size of [1_000_000, 8_000_000, 8_388_638]) {
      try {
        sql.exec('DELETE FROM limit_probe_large');
        sql.exec('INSERT INTO limit_probe_large VALUES (zeroblob(?))', size);
        largeRows.push({ size, accepted: sql.exec('SELECT length(value) AS n FROM limit_probe_large').one().n === size });
      } catch { largeRows.push({ size, accepted: false }); }
    }
    assert(largeRows[0].accepted, 'Representative 1 MB BLOB failed');
    assert(!largeRows[2].accepted, 'Expected local row-size rejection did not occur');
    const auditBeforeLarge = sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n;
    rejects(() => storage.transactionSync(() => {
      sql.exec('INSERT INTO limit_probe_business VALUES (2)');
      sql.exec('INSERT INTO limit_probe_audit VALUES (9)');
      sql.exec('INSERT INTO limit_probe_large VALUES (zeroblob(8388638))');
    }), 'too big');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_business').one().n === 0, 'Oversized row left a business row');
    assert(sql.exec('SELECT COUNT(*) AS n FROM limit_probe_audit').one().n === auditBeforeLarge, 'Oversized row left an audit row');
    return { ok: true, wideColumns: 100, directSQLBytes: 100000, rewrittenSelectBytes: 100000, rewrittenReturningBytes: 100000, rejectedBytes: 100001, function33, largeRows };
  }
}
export default { async fetch(request, env) { const probe=env.PROBE.getByName(crypto.randomUUID()), params=new URL(request.url).searchParams; return Response.json(params.has('exact-text-nested') ? await probe.runEscapedTextReturningExact('nested') : params.has('exact-text-tag') ? await probe.runEscapedTextReturningExact('escape-tag') : params.has('exact-text') ? await probe.runEscapedTextReturningExact() : params.has('exact-blob-repeat-tail8-ff') ? await probe.runEscapedBlobReturningExact(true,8388629,8,false,255) : params.has('exact-blob-repeat-tail8-zero') ? await probe.runEscapedBlobReturningExact(true,8388629,8,false,0) : params.has('exact-blob-repeat-tail8-wide-ff') ? await probe.runEscapedBlobReturningExact(true,8388584,8,true,255) : params.has('exact-blob-repeat-tail8-wide-zero') ? await probe.runEscapedBlobReturningExact(true,8388584,8,true,0) : params.has('exact-blob-repeat-tail8-wide64-ff') ? await probe.runEscapedBlobReturningExact(true,8388566,8,64,255) : params.has('exact-blob-repeat-tail8-wide64-zero') ? await probe.runEscapedBlobReturningExact(true,8388566,8,64,0) : params.has('exact-blob-repeat-tail8-wide100-very-long-last') ? await probe.runEscapedBlobReturningExact(true,8388530,8,100,-1,'very',true) : params.has('exact-blob-repeat-tail8-wide100-very-long-ff') ? await probe.runEscapedBlobReturningExact(true,8388530,8,100,255,'very') : params.has('exact-blob-repeat-tail8-wide100-very-long-zero') ? await probe.runEscapedBlobReturningExact(true,8388530,8,100,0,'very') : params.has('exact-blob-repeat-tail8-wide100-extreme') ? await probe.runEscapedBlobReturningExact(true,8388530,8,100,-1,'extreme') : params.has('exact-blob-repeat-tail8-wide100-very-long') ? await probe.runEscapedBlobReturningExact(true,8388530,8,100,-1,'very') : params.has('exact-blob-repeat-tail8-wide100-long-ff') ? await probe.runEscapedBlobReturningExact(true,8388530,8,100,255,true) : params.has('exact-blob-repeat-tail8-wide100-long-zero') ? await probe.runEscapedBlobReturningExact(true,8388530,8,100,0,true) : params.has('exact-blob-repeat-tail8-wide100-long') ? await probe.runEscapedBlobReturningExact(true,8388530,8,100,-1,true) : params.has('exact-blob-repeat-tail8-wide100-ff') ? await probe.runEscapedBlobReturningExact(true,8388530,8,100,255) : params.has('exact-blob-repeat-tail8-wide100-zero') ? await probe.runEscapedBlobReturningExact(true,8388530,8,100,0) : params.has('exact-blob-repeat-tail8-wide100') ? await probe.runEscapedBlobReturningExact(true,8388530,8,100) : params.has('exact-blob-repeat-tail8-wide66') ? await probe.runEscapedBlobReturningExact(true,8388566,8,66) : params.has('exact-blob-repeat-tail8-wide65') ? await probe.runEscapedBlobReturningExact(true,8388566,8,65) : params.has('exact-blob-repeat-tail8-wide64') ? await probe.runEscapedBlobReturningExact(true,8388566,8,64) : params.has('exact-blob-repeat-tail8-wide63') ? await probe.runEscapedBlobReturningExact(true,8388566,8,63) : params.has('exact-blob-repeat-tail8-wide') ? await probe.runEscapedBlobReturningExact(true,8388584,8,true) : params.has('exact-blob-repeat-tail11') ? await probe.runEscapedBlobReturningExact(true,8388632,11) : params.has('exact-blob-repeat-tail8') ? await probe.runEscapedBlobReturningExact(true,8388629,8) : params.has('exact-blob-repeat-tail6') ? await probe.runEscapedBlobReturningExact(true,8388636,6) : params.has('exact-blob-repeat-tail5') ? await probe.runEscapedBlobReturningExact(true,8388635,5) : params.has('exact-blob-repeat-tail4') ? await probe.runEscapedBlobReturningExact(true,8388634,4) : params.has('exact-blob-repeat-tail3') ? await probe.runEscapedBlobReturningExact(true,8388633,3) : params.has('exact-blob-repeat-tail2') ? await probe.runEscapedBlobReturningExact(true,8388632,2) : params.has('exact-blob-repeat-tail') ? await probe.runEscapedBlobReturningExact(true,8388631,1) : params.has('exact-blob-repeat-safe') ? await probe.runEscapedBlobReturningExact(true,8000001) : params.has('exact-blob-repeat') ? await probe.runEscapedBlobReturningExact(true) : params.has('exact-blob') ? await probe.runEscapedBlobReturningExact() : params.has('exact-many') ? await probe.runManyIntegerReturningExact() : params.has('exact-real') ? await probe.runPinnedReturningExact('real') : params.has('exact64') ? await probe.runPinnedReturningExact('int64') : params.has('exact') ? await probe.runPinnedReturningExact() : await probe.run()); } };
