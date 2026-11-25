import { DurableObject } from 'cloudflare:workers';
import { ensureStreamImportSchema, validateStreamImportSchema, streamImportStatus, importStream } from '../worker/relocation-stream-import.js';
const check = (value, message) => { if (!value) throw Error(message); };
const textBytes = 8_300_000, blobBytes = 257, slice = 64 * 1024;
const pattern = new Uint8Array([0, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]);
// A valid sequence, padded to a whole number of UTF-8 code points.
function makeText(offset, length) { const out = new Uint8Array(length); for (let i = 0; i < length; i++) out[i] = offset + i < textBytes - 2 ? pattern[(offset + i) % pattern.length] : 0x41; return out; }
function makeBlob(offset, length) { const out = new Uint8Array(length); for (let i = 0; i < length; i++) out[i] = (offset + i) % 256; return out; }
export class StreamOwner extends DurableObject {
 constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.s = ctx.storage; this.s.sql.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, value TEXT NOT NULL, raw BLOB NOT NULL, precise INTEGER NOT NULL, amount REAL NOT NULL, optional TEXT, CHECK(precise > 0))'); this.s.sql.exec('CREATE TABLE IF NOT EXISTS events (count INTEGER NOT NULL)'); this.s.sql.exec('CREATE TRIGGER IF NOT EXISTS on_item AFTER INSERT ON items BEGIN INSERT INTO events VALUES (1); END'); ensureStreamImportSchema(this.s); }
 receive(index, stream, fail = false) { return this.s.transactionSync(() => { validateStreamImportSchema(this.s, 'p'); return importStream(this.s, { projectId: 'p', table: 'items', names: ['id', 'value', 'raw', 'precise', 'amount', 'optional'], rowOffset: 0, index, stream, failAfterRows: fail ? 1 : 0 }); }); }
 state() { const state = streamImportStatus(this.s, 'p'); return { state, count: this.s.sql.exec('SELECT COUNT(*) AS n FROM items').one().n, events: this.s.sql.exec('SELECT COUNT(*) AS n FROM events').one().n }; }
 corrupt(kind) {
  if (kind === 'metadata') this.s.sql.exec('UPDATE mapi_chunk_import_stream SET cursor = ?', 'x'.repeat(100000));
  else if (kind === 'pieces') for (let i = 1; i <= 200; i++) this.s.sql.exec('INSERT INTO mapi_chunk_import_stream_data VALUES (?, 2, ?, ?)', 'p', i, new Uint8Array([1]).buffer);
  else throw Error('Unknown corruption fixture');
 }
 evict() { this.ctx.abort('synthetic owner eviction'); }
 check(offset, data, kind) { const col = kind === 'text' ? 'value' : 'raw'; return this.s.sql.exec(`SELECT CAST(substr(CAST(${col} AS BLOB), ?, ?) AS BLOB) = ? AS ok FROM items WHERE id = 'key'`, offset + 1, data.byteLength, data).one().ok === 1; }
 metadata() { return this.s.sql.exec("SELECT typeof(value) AS text_type, length(CAST(value AS BLOB)) AS text_size, typeof(raw) AS blob_type, length(raw) AS blob_size, CAST(precise AS TEXT) AS precise, typeof(amount) AS real_type, amount, optional IS NULL AS nil FROM items WHERE id = 'key'").one(); }
}
export default { async fetch(request, env) {
 try {
  const tag = crypto.randomUUID(); let owner = env.OWNER.getByName(tag), index = 0;
  const types = [{kind:'text',length:3},{kind:'text',length:textBytes},{kind:'blob',length:blobBytes},{kind:'integer',value:'9223372036854775807'},{kind:'real',value:1.25},{kind:'null'}];
  const cursor = ['key'];
  let stream = {v:2,column:0,offset:0,total:3,kind:'text',data:new TextEncoder().encode('key').toBase64(),cursor,rowDone:false,nextColumn:1,nextOffset:0,types};
  check(await owner.receive(index++,stream) === false, 'start completed early');
  // Reject a wrong continuation without mutating the existing durable row.
  const invalid = {v:2,column:1,offset:2,total:textBytes,kind:'text',data:'QQ==',cursor,rowDone:false,nextColumn:1,nextOffset:3};
  try { await owner.receive(index, invalid); throw Error('bad offset accepted'); } catch (error) { if (String(error).includes('bad offset accepted')) throw error; }
  try { await owner.evict(); } catch {} owner = env.OWNER.getByName(tag);
  check((await owner.state()).state?.last_chunk === 0, 'checkpoint did not survive eviction');
  for (let offset = 0; offset < textBytes; offset += slice) {
   const length = Math.min(slice, textBytes - offset), done = offset + length === textBytes;
   stream = {v:2,column:1,offset,total:textBytes,kind:'text',data:makeText(offset,length).toBase64(),cursor,rowDone:false,nextColumn:done?2:1,nextOffset:done?0:offset+length};
   check(await owner.receive(index++, stream) === false, 'text completed row early');
  }
  stream = {v:2,column:2,offset:0,total:blobBytes,kind:'blob',data:makeBlob(0,blobBytes).toBase64(),cursor,rowDone:true,nextColumn:null,nextOffset:null};
  try { await owner.receive(index,stream,true); throw Error('injected failure accepted'); } catch(error) { if (String(error).includes('injected failure accepted')) throw error; }
  let state = await owner.state(); check(state.count === 0 && state.events === 0 && state.state?.last_chunk === index - 1, 'failed insert did not roll back');
  try { await owner.evict(); } catch {} owner = env.OWNER.getByName(tag);
  check(await owner.receive(index,stream) === true, 'final fragment did not commit');
  state = await owner.state(); check(state.count === 1 && state.events === 1 && state.state === null, 'row or trigger state differs');
  const metadata = await owner.metadata(); check(metadata.text_type === 'text' && metadata.text_size === textBytes && metadata.blob_type === 'blob' && metadata.blob_size === blobBytes && metadata.precise === '9223372036854775807' && metadata.real_type === 'real' && metadata.amount === 1.25 && metadata.nil === 1, 'row types changed');
  for (let offset = 0; offset < textBytes; offset += slice) { const length = Math.min(slice,textBytes-offset); check(await owner.check(offset,makeText(offset,length).buffer,'text'), 'text bytes changed'); }
  check(await owner.check(0,makeBlob(0,blobBytes).buffer,'blob'), 'blob bytes changed');
  let empty = env.OWNER.getByName(`${tag}-empty`), emptyIndex = 0;
  const emptyTypes = [{kind:'text',length:3},{kind:'text',length:0},{kind:'blob',length:0},{kind:'integer',value:'1'},{kind:'real',value:2.5},{kind:'null'}];
  const emptyCursor = ['key'];
  const key = {v:2,column:0,offset:0,total:3,kind:'text',data:'a2V5',cursor:emptyCursor,rowDone:false,nextColumn:1,nextOffset:0,types:emptyTypes};
  const emptyText = {v:2,column:1,offset:0,total:0,kind:'text',data:'',cursor:emptyCursor,rowDone:false,nextColumn:2,nextOffset:0};
  const emptyBlob = {v:2,column:2,offset:0,total:0,kind:'blob',data:'',cursor:emptyCursor,rowDone:true,nextColumn:null,nextOffset:null};
  await empty.receive(emptyIndex++,key); await empty.receive(emptyIndex++,emptyText); check(await empty.receive(emptyIndex,emptyBlob) === true, 'empty values did not commit');
  const emptyMetadata = await empty.metadata(); check(emptyMetadata.text_type === 'text' && emptyMetadata.text_size === 0 && emptyMetadata.blob_type === 'blob' && emptyMetadata.blob_size === 0, 'empty TEXT or BLOB type changed');
  let malformed = env.OWNER.getByName(`${tag}-bad`); const badTypes = [{kind:'text',length:3},{kind:'text',length:1},{kind:'blob',length:0},{kind:'integer',value:'1'},{kind:'real',value:2.5},{kind:'null'}];
  await malformed.receive(0,{...key,types:badTypes});
  const badText = {...emptyText,total:1,data:'gA=='};
  try { await malformed.receive(1,badText); throw Error('invalid UTF-8 accepted'); } catch(error) { if (String(error).includes('invalid UTF-8 accepted')) throw error; }
  const badState = await malformed.state(); check(badState.state?.last_chunk === 0 && badState.count === 0 && badState.events === 0, 'invalid UTF-8 changed state');
  let wrongKey = env.OWNER.getByName(`${tag}-wrong-key`);
  await wrongKey.receive(0, {...key, cursor:['bad']}); await wrongKey.receive(1, {...emptyText,cursor:['bad']});
  try { await wrongKey.receive(2,{...emptyBlob,cursor:['bad']}); throw Error('mismatched key accepted'); } catch(error) { if (String(error).includes('mismatched key accepted')) throw error; }
  const wrongState = await wrongKey.state(); check(wrongState.state?.last_chunk === 1 && wrongState.count === 0 && wrongState.events === 0, 'bad cursor changed state');
  const badInteger = env.OWNER.getByName(`${tag}-bad-integer`), invalidTypes = emptyTypes.map(item=>item.kind === 'integer' ? {...item,value:'1\n'} : item);
  try { await badInteger.receive(0,{...key,types:invalidTypes}); throw Error('noncanonical integer accepted'); } catch(error) { if (String(error).includes('noncanonical integer accepted')) throw error; }
  const integerState = await badInteger.state(); check(integerState.state === null && integerState.count === 0 && integerState.events === 0, 'invalid integer changed state');
  const corruptMetadata = env.OWNER.getByName(`${tag}-metadata`); await corruptMetadata.receive(0,key); await corruptMetadata.corrupt('metadata');
  try { await corruptMetadata.state(); throw Error('oversized metadata accepted'); } catch(error) { if (String(error).includes('oversized metadata accepted')) throw error; }
  const corruptPieces = env.OWNER.getByName(`${tag}-pieces`); await corruptPieces.receive(0,key); await corruptPieces.receive(1,emptyText); await corruptPieces.corrupt('pieces');
  try { await corruptPieces.receive(2,emptyBlob); throw Error('excess pieces accepted'); } catch(error) { if (String(error).includes('excess pieces accepted')) throw error; }
  const pieceState = await corruptPieces.state(); check(pieceState.state?.last_chunk === 1 && pieceState.count === 0 && pieceState.events === 0, 'excess pieces changed state');
  let violates = env.OWNER.getByName(`${tag}-constraint`); const negativeTypes = emptyTypes.map(item=>item.kind === 'integer' ? {...item,value:'-1'} : item);
  await violates.receive(0,{...key,types:negativeTypes}); await violates.receive(1,emptyText);
  try { await violates.receive(2,emptyBlob); throw Error('constraint violation accepted'); } catch(error) { if (String(error).includes('constraint violation accepted')) throw error; }
  const violatedState = await violates.state(); check(violatedState.state?.last_chunk === 1 && violatedState.count === 0 && violatedState.events === 0, 'constraint failure changed state');
  return Response.json({ok:true});
 } catch (error) { return Response.json({ok:false,error:String(error)}, {status:500}); }
} };
