// Unmounted synthetic-only capability gateway. The configured policy and the
// Workers/bindings that can reach each named entrypoint must be administered
// independently; this module does not establish that separation, storage
// nonrollback, source-commitment authority, or the truth of an opaque head.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { advanceConfiguredSyntheticVerifier } from './synthetic-archive-verifier-runner.js';
export { SyntheticArchiveAuthority } from './synthetic-archive-authority.js';

const encoder = new TextEncoder();
const keyArn = 'arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f';
const runId = 'mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
const hex = (value, n) => typeof value === 'string' && value.length === n && /^[0-9a-f]+$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.isWellFormed();
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));

// Policy bytes are canonical JSON so duplicate keys, reordered keys and
// alternate encodings do not produce ambiguous configuration. Both the
// bytes and their externally configured digest are privileged inputs.
async function loadPolicy(env) {
  const raw = env.MAPI_SYNTHETIC_AUTHORITY_POLICY;
  if (typeof raw !== 'string' || raw.length > 32768 || encoder.encode(raw).length > 32768 || !hex(env.MAPI_SYNTHETIC_AUTHORITY_POLICY_SHA256, 64)) throw Error('Invalid authority policy');
  let p; try { p = JSON.parse(raw); } catch { throw Error('Invalid authority policy'); }
  const sk = ['keyArn','runId','archiveId','manifestDigest'];
  const ck = ['projectId','origin','objectName','generation','moveId','manifestDigest','tables','chunkCount','finalDigest'];
  if (!exactKeys(p, ['scope','commitment','envelopeDigest','sealingJobId','verificationJobId']) || !exactKeys(p.scope, sk) || !exactKeys(p.commitment, ck) ||
      p.scope.keyArn !== keyArn || p.scope.runId !== runId || !hex(p.scope.archiveId, 32) || !hex(p.scope.manifestDigest, 64) ||
      !hex(p.envelopeDigest, 64) || !hex(p.sealingJobId, 32) || !hex(p.verificationJobId, 32) || p.sealingJobId === p.verificationJobId ||
      !text(p.commitment.projectId) || !text(p.commitment.origin) || !text(p.commitment.objectName) || !text(p.commitment.moveId) ||
      !Number.isSafeInteger(p.commitment.generation) || p.commitment.generation < 1 || p.commitment.generation === Number.MAX_SAFE_INTEGER ||
      p.commitment.manifestDigest !== p.scope.manifestDigest || !hex(p.commitment.finalDigest, 64) ||
      !Number.isSafeInteger(p.commitment.chunkCount) || p.commitment.chunkCount < 1 || p.commitment.chunkCount > 1000000 ||
      !Array.isArray(p.commitment.tables) || p.commitment.tables.length < 1 || p.commitment.tables.length > 256 ||
      p.commitment.tables.some(t => !text(t)) || new Set(p.commitment.tables).size !== p.commitment.tables.length) throw Error('Invalid authority policy');
  const canonical = {scope:Object.fromEntries(sk.map(k => [k,p.scope[k]])),commitment:Object.fromEntries(ck.map(k => [k,p.commitment[k]])),
    envelopeDigest:p.envelopeDigest,sealingJobId:p.sealingJobId,verificationJobId:p.verificationJobId};
  if (JSON.stringify(canonical) !== raw || await digest(raw) !== env.MAPI_SYNTHETIC_AUTHORITY_POLICY_SHA256) throw Error('Invalid authority policy');
  const s = p.scope, c = p.commitment;
  const identity = [1, s.runId, s.archiveId, p.envelopeDigest, c.projectId, c.origin, c.objectName, c.generation, c.moveId, c.manifestDigest, c.tables, c.chunkCount, c.finalDigest];
  if (encoder.encode(JSON.stringify(identity)).length > 32768 || !env.ARCHIVE_AUTH || typeof env.ARCHIVE_AUTH.getByName !== 'function') throw Error('Invalid authority policy');
  const sealingIdentityDigest = await digest(JSON.stringify(['mapi-archive-sealing-identity-v1', ...identity]));
  const verificationIdentityDigest = await digest(JSON.stringify(['mapi-archive-restore-identity-v1', ...identity]));
  const basePolicyDigest = await digest(JSON.stringify({scope:p.scope,commitment:p.commitment,envelopeDigest:p.envelopeDigest,sealingJobId:p.sealingJobId}));
  const verificationPolicyDigest = await digest(JSON.stringify(['mapi-synthetic-verifier-policy-v1',basePolicyDigest,p.verificationJobId,verificationIdentityDigest]));
  return { p, sealingIdentityDigest, verificationIdentityDigest, basePolicyDigest, verificationPolicyDigest,
    stub: env.ARCHIVE_AUTH.getByName(`mapi-synthetic-authority-v1/${s.archiveId}`) };
}

function expectedJob(c, job, allowed) {
  const kind = job === c.p.sealingJobId ? 'sealing' : job === c.p.verificationJobId ? 'verification' : '';
  if (!allowed.includes(kind)) throw Error('Authority capability denied');
  return kind;
}
function checkHead(c, job, value, kind) {
  const expectedIdentity = kind === 'sealing' ? c.sealingIdentityDigest : c.verificationIdentityDigest;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.jobId !== job || value.identityDigest !== expectedIdentity ||
      value.version !== (kind === 'sealing' ? 1 : 2)) throw Error('Authority policy differs');
  return value;
}
async function read(c, job, allowed) {
  const kind = expectedJob(c, job, allowed), policy=kind==='sealing'?null:c.verificationPolicyDigest;
  await c.stub.assertPolicy(job,c.basePolicyDigest,policy);
  const head = await c.stub.read(job), result=head === null ? null : checkHead(c, job, head, kind);
  await c.stub.assertPolicy(job,c.basePolicyDigest,policy);
  return result;
}
async function create(c, job, head, allowed) {
  const kind = expectedJob(c, job, allowed), policy=kind==='sealing'?null:c.verificationPolicyDigest;
  checkHead(c, job, head, kind);
  await c.stub.assertPolicy(job,c.basePolicyDigest,policy);
  const result=await c.stub.create(job, head);
  await c.stub.assertPolicy(job,c.basePolicyDigest,policy);
  return result;
}
async function swap(c, job, current, next, allowed) {
  const kind = expectedJob(c, job, allowed), policy=kind==='sealing'?null:c.verificationPolicyDigest;
  checkHead(c, job, current, kind); checkHead(c, job, next, kind);
  await c.stub.assertPolicy(job,c.basePolicyDigest,policy);
  const result=await c.stub.compareAndSwap(job, current, next);
  await c.stub.assertPolicy(job,c.basePolicyDigest,policy);
  return result;
}

// Bind only the appropriate named entrypoint to each trusted caller. Direct
// access to ARCHIVE_AUTH and the bootstrap capability must stay with the
// authority administrator; the module cannot enforce who configures bindings.
export class SyntheticAuthorityBootstrap extends WorkerEntrypoint {
  async initialize() {
    const c = await loadPolicy(this.env);
    return c.stub.initialize({ archiveId:c.p.scope.archiveId, sealingIdentityDigest:c.sealingIdentityDigest,
      verificationIdentityDigest:c.verificationIdentityDigest, basePolicyDigest:c.basePolicyDigest, sealingJobId:c.p.sealingJobId });
  }
  async registerVerifier() {
    const c = await loadPolicy(this.env);
    await c.stub.assertPolicy(c.p.sealingJobId,c.basePolicyDigest,null);
    const result=await c.stub.registerVerification(c.p.verificationJobId,c.verificationPolicyDigest);
    await c.stub.assertPolicy(c.p.verificationJobId,c.basePolicyDigest,c.verificationPolicyDigest);
    return result;
  }
}
export class SyntheticSealingAuthority extends WorkerEntrypoint {
  async read(job) { return read(await loadPolicy(this.env), job, ['sealing']); }
  async create(job, head) { return create(await loadPolicy(this.env), job, head, ['sealing']); }
  async compareAndSwap(job, current, next) { return swap(await loadPolicy(this.env), job, current, next, ['sealing']); }
}
export class SyntheticVerificationAuthority extends WorkerEntrypoint {
  async read(job) { return read(await loadPolicy(this.env), job, ['sealing','verification']); }
  async create(job, head) { return create(await loadPolicy(this.env), job, head, ['verification']); }
  async compareAndSwap(job, current, next) { return swap(await loadPolicy(this.env), job, current, next, ['verification']); }
}
export class SyntheticRecoveryAuthority extends WorkerEntrypoint {
  async read(job) { return read(await loadPolicy(this.env), job, ['sealing','verification']); }
}
// Privileged synthetic-only runner: the caller cannot supply a job, source
// commitment, head or checkpoint. Only this service should hold the mutating
// verification authority binding. Deployment and access control must make
// that true; this class cannot establish independent administration itself.
export class SyntheticArchiveVerifier extends WorkerEntrypoint {
  async advance() {
    const c = await loadPolicy(this.env);
    const sealing = { read: job => read(c, job, ['sealing']) };
    const verification = {
      read: job => read(c, job, ['verification']),
      create: (job, head) => create(c, job, head, ['verification']),
      compareAndSwap: (job, current, next) => swap(c, job, current, next, ['verification']),
    };
    return advanceConfiguredSyntheticVerifier(c.p, this.env.ARCHIVE_BUCKET, this.env.ARCHIVE_KMS,
      sealing, verification, new AbortController().signal);
  }
}
export default { async fetch() { return new Response(null, { status:404 }); } };
