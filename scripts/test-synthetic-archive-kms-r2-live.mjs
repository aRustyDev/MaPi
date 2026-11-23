// Explicit opt-in. Synthetic fixture and local persisted Miniflare R2 only.
// Never write AWS credentials or plaintext data keys to disk or logs.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare } from 'miniflare';
import { assertAssumedIdentity, assertPinnedAwsCli, assertSystemCa, awsCli, safeBaseEnvironment } from './synthetic-kms-cli-safety.mjs';
import { mintSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';
import { archiveSyntheticChunk, sealSyntheticArchive, verifySyntheticArchive, restoreSyntheticArchive } from '../worker/synthetic-relocation-archive.js';
if (process.env.MAPI_SYNTHETIC_KMS_LIVE !== '1') throw Error('Explicit synthetic KMS test opt-in is required');
const account='646535719915', keyArn=`arn:aws:kms:us-east-1:${account}:key/7614cff5-444e-4615-a785-4192dd150c2f`;
const runId='mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
const writerName='mapi-p1-wr-bef5970113984cf34aa5c70e9d0a2c9a', recoveryName='mapi-p1-rc-bef5970113984cf34aa5c70e9d0a2c9a';
const ctx=`purpose=mapi-phase1-synthetic-archive,run_id=${runId}`, base=safeBaseEnvironment(process.env);
const bytes=s=>new TextEncoder().encode(s), sha=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes(s)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const signal=()=>AbortSignal.timeout(60000), started=performance.now();
const temp=await mkdtemp(path.join(tmpdir(),'mapi-kms-r2-live-')); let m, db;
let generateCalls=0, decryptCalls=0;
function secret(value) { const b=Buffer.from(value,'base64'); try {return new Uint8Array(b)} finally {b.fill(0)} }
async function role(name,id) {
  const result=await awsCli(['sts','assume-role','--profile','tf-admin-aiml-dev','--role-arn',`arn:aws:iam::${account}:role/mapi/synthetic/${name}`,'--role-session-name','mapi-synthetic-archive','--duration-seconds','900'],base);
  const credential=result.Credentials;
  if(!credential?.AccessKeyId||!credential?.SecretAccessKey||!credential?.SessionToken) throw Error('Invalid assumed-role credentials');
  const env={...base,AWS_ACCESS_KEY_ID:credential.AccessKeyId,AWS_SECRET_ACCESS_KEY:credential.SecretAccessKey,AWS_SESSION_TOKEN:credential.SessionToken};
  result.Credentials=undefined; assertAssumedIdentity(await awsCli(['sts','get-caller-identity'],env),account,name,id); return env;
}
function local() {
  const config={name:'synthetic-archive-local',compatibilityDate:'2026-01-01',env:{ARCHIVE:{type:'r2',name:'synthetic-archive'}},manifest:{mainModule:'main.mjs',modules:{'main.mjs':{type:'esm',contents:'export default {fetch(){return new Response("local synthetic archive")}}'}}}};
  return new Miniflare({resourcePersistencePath:path.join(temp,'r2'),workers:[{config}]});
}
try {
  assertSystemCa(); assertPinnedAwsCli();
  const sourceIdentity=await awsCli(['sts','get-caller-identity','--profile','tf-admin-aiml-dev'],base);
  assertAssumedIdentity(sourceIdentity,account,'AWSReservedSSO_AdministratorAccess_3a59fce8199e956f','AROAZNCEIFPV5G7RYTP6W');
  const metadata=await awsCli(['kms','describe-key','--profile','tf-admin-aiml-dev','--key-id',keyArn],base);
  if(metadata.KeyMetadata?.Arn!==keyArn||metadata.KeyMetadata?.KeyState!=='Enabled'||metadata.KeyMetadata?.KeySpec!=='SYMMETRIC_DEFAULT') throw Error('Synthetic key state mismatch');
  const writer=await role(writerName,'AROAZNCEIFPV23UFUR333'), recovery=await role(recoveryName,'AROAZNCEIFPVYUA2YH6A2');
  const kms={
    async generateDataKey(request) {
      if(request.KeyId!==keyArn||request.KeySpec!=='AES_256'||request.EncryptionContext?.purpose!=='mapi-phase1-synthetic-archive'||request.EncryptionContext?.run_id!==runId||Object.keys(request.EncryptionContext).length!==2) throw Error('Unexpected KMS context');
      generateCalls++; const result=await awsCli(['kms','generate-data-key','--key-id',keyArn,'--key-spec','AES_256','--encryption-context',ctx],writer);
      const plaintext=secret(result.Plaintext), wrapped=new Uint8Array(Buffer.from(result.CiphertextBlob,'base64')); result.Plaintext=undefined;
      return {KeyId:result.KeyId,Plaintext:plaintext,CiphertextBlob:wrapped};
    },
    async decrypt(request) {
      if(request.KeyId!==keyArn||request.EncryptionContext?.purpose!=='mapi-phase1-synthetic-archive'||request.EncryptionContext?.run_id!==runId||Object.keys(request.EncryptionContext).length!==2) throw Error('Unexpected KMS context');
      decryptCalls++; const result=await awsCli(['kms','decrypt','--key-id',keyArn,'--ciphertext-blob','fileb:///dev/stdin','--encryption-context',ctx],recovery,Buffer.from(request.CiphertextBlob));
      const plaintext=secret(result.Plaintext); result.Plaintext=undefined; return {KeyId:result.KeyId,Plaintext:plaintext};
    },
  };
  m=local(); let bucket=await m.getR2Bucket('ARCHIVE');
  const tables=['users','events']; const manifest=JSON.stringify({projectId:'synthetic-project',origin:'https://synthetic.example',objectName:'synthetic-source',generation:1,moveId:'synthetic-move',tables});
  const scope={keyArn,runId,archiveId:randomBytes(16).toString('hex'),manifestDigest:await sha(manifest)}, chunks=[]; let prev='';
  for(const [i,table] of tables.entries()) {
    const columns=table==='users'?['id','name']:['id','payload'], rows=table==='users'?[['u1','synthetic user'],['u2','another user']]:[[1,'synthetic audit']];
    const content=JSON.stringify({projectId:'synthetic-project',generation:1,moveId:'synthetic-move',index:i,prev,table,columns,offset:0,rows,last:true,done:i===tables.length-1,cursor:null});
    prev=await sha(content); chunks.push(content);
  }
  const commitment={projectId:'synthetic-project',origin:'https://synthetic.example',objectName:'synthetic-source',generation:1,moveId:'synthetic-move',manifestDigest:scope.manifestDigest,tables,chunkCount:chunks.length,finalDigest:prev};
  const envelope=(await mintSyntheticArchiveKey(bucket,kms,scope,signal())).provisionalEnvelopeDigest;
  // The fixture is the sole source of this commitment, not an independent authority.
  for(let i=0;i<chunks.length;i++) await archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,i,chunks[i],signal());
  await sealSyntheticArchive(bucket,kms,scope,commitment,envelope,signal());
  await m.dispose(); m=local(); bucket=await m.getR2Bucket('ARCHIVE');
  const proof=await verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal());
  db=new DatabaseSync(path.join(temp,'stage.sqlite'));
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE checkpoint(singleton INTEGER PRIMARY KEY,state TEXT NOT NULL); CREATE TABLE history(idx INTEGER PRIMARY KEY,digest TEXT NOT NULL)');
  const target={
    async load(){const v=db.prepare('SELECT state FROM checkpoint WHERE singleton=1').get();return v?JSON.parse(v.state):null},
    async begin(cp){db.exec('BEGIN IMMEDIATE');try{if(db.prepare('SELECT count(*) n FROM users').get().n||db.prepare('SELECT count(*) n FROM events').get().n) throw Error('Destination is not fresh');db.prepare('INSERT INTO checkpoint VALUES(1,?)').run(JSON.stringify(cp));db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}},
    async apply({expected,next,content,index,digest}){if(await sha(content)!==digest)throw Error('Destination digest differs');db.exec('BEGIN IMMEDIATE');try{if(JSON.stringify(await this.load())!==JSON.stringify(expected)||index!==expected.next)throw Error('Destination cursor differs');const p=JSON.parse(content);if(!tables.includes(p.table)||p.index!==index||p.projectId!==commitment.projectId)throw Error('Destination identity differs');const statement=db.prepare(`INSERT INTO ${p.table} VALUES(?,?)`);for(const row of p.rows)statement.run(...row);db.prepare('INSERT INTO history VALUES(?,?)').run(index,digest);db.prepare('UPDATE checkpoint SET state=?').run(JSON.stringify(next));db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}},
    async finish(cp){db.exec('BEGIN IMMEDIATE');try{if(JSON.stringify(await this.load())!==JSON.stringify(cp))throw Error('Destination cursor differs');db.prepare('UPDATE checkpoint SET state=?').run(JSON.stringify({...cp,complete:true}));db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}},
  };
  await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target);
  if(!(await target.load()).complete||db.prepare('SELECT count(*) n FROM users').get().n!==2||db.prepare('SELECT count(*) n FROM events').get().n!==1||proof.finalDigest!==prev)throw Error('Synthetic restore differs');
  let cursor, objects=0, total=0, maximum=0; do {const page=await bucket.list({limit:1000,...(cursor?{cursor}:{})});for(const o of page.objects){objects++;total+=o.size;maximum=Math.max(maximum,o.size)}cursor=page.truncated?page.cursor:undefined} while(cursor);
  console.log(JSON.stringify({outcome:'passed',source:'two synthetic chunks, two users and one audit row',generateDataKeyCalls:generateCalls,decryptCalls,localR2Objects:objects,localR2Bytes:total,maxObjectBytes:maximum,elapsedMs:Math.round(performance.now()-started),r2Restarted:true,stage:'local SQLite checkpoint, synthetic fixture',commitment:'fixture-supplied, not independently authoritative',credentialsExplicitlyPersisted:false}));
} catch(e) { console.error(e instanceof Error?e.message:'Synthetic archive test failed'); process.exitCode=1; }
finally {try{db?.close()}catch{} try{await m?.dispose()}catch{} await rm(temp,{recursive:true,force:true});}
