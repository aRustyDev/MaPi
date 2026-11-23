// Unmounted synthetic-only authority. This object enforces local CAS and head
// shape, but trusts its provisioner and its callers. It cannot establish
// independent administration, prevent PITR/rollback, authenticate source
// commitments, or prove that an opaque terminal head represents a valid scan.
import { DurableObject } from 'cloudflare:workers';

const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const rows = (sql, query, ...args) => sql.exec(query, ...args).toArray();
const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
const schema = [
  ['index','authority_single_sealing','authority_jobs',"CREATE UNIQUE INDEX authority_single_sealing ON authority_jobs(kind) WHERE kind='sealing'"],
  ['index','sqlite_autoindex_authority_jobs_1','authority_jobs',null],
  ['index','sqlite_autoindex_authority_verifiers_1','authority_verifiers',null],
  ['table','authority_config','authority_config','CREATE TABLE authority_config (singleton INTEGER PRIMARY KEY CHECK(singleton=1), archive_id TEXT NOT NULL, seal_identity TEXT NOT NULL, verify_identity TEXT NOT NULL, base_policy TEXT NOT NULL, seal_job TEXT NOT NULL)'],
  ['table','authority_jobs','authority_jobs',"CREATE TABLE authority_jobs (job_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('sealing','verification')), head TEXT NOT NULL)"],
  ['table','authority_verifiers','authority_verifiers','CREATE TABLE authority_verifiers (job_id TEXT PRIMARY KEY, policy_digest TEXT NOT NULL)'],
];
const boundedHead = "CASE WHEN length(CAST(head AS BLOB)) <= 2048 THEN head ELSE NULL END AS head";
const boundedKind = "CASE WHEN length(CAST(kind AS BLOB)) <= 16 THEN kind ELSE NULL END AS kind";
const boundedId = "CASE WHEN length(CAST(job_id AS BLOB)) = 32 THEN job_id ELSE NULL END AS job_id";
const boundedPolicy = "CASE WHEN length(CAST(policy_digest AS BLOB)) = 64 THEN policy_digest ELSE NULL END AS policy_digest";
const boundedConfig = `SELECT CASE WHEN length(CAST(archive_id AS BLOB))=32 THEN archive_id END AS archive_id,
  CASE WHEN length(CAST(seal_identity AS BLOB))=64 THEN seal_identity END AS seal_identity,
  CASE WHEN length(CAST(verify_identity AS BLOB))=64 THEN verify_identity END AS verify_identity,
  CASE WHEN length(CAST(base_policy AS BLOB))=64 THEN base_policy END AS base_policy,
  CASE WHEN length(CAST(seal_job AS BLOB))=32 THEN seal_job END AS seal_job FROM authority_config WHERE singleton=1`;
const verifierPolicy = (base, job, identity) => JSON.stringify(['mapi-synthetic-verifier-policy-v1',base,job,identity]);

function checkedHead(input, jobId) {
  const h = input;
  if (!h || typeof h !== 'object' || Array.isArray(h) || !hex(jobId, 32) || h.jobId !== jobId ||
      !hex(h.identityDigest, 64) || !Number.isSafeInteger(h.revision) || h.revision < 0 ||
      typeof h.terminal !== 'boolean' || typeof h.role !== 'string' || !hex(h.digest, 64) || !hex(h.recordDigest, 64) ||
      (h.revision === 0 ? h.parentDigest !== '' || h.terminal : !hex(h.parentDigest, 64))) throw Error('Invalid authority head');
  let expected;
  const sealPrefix=`sealing-${jobId}-`, verifyPrefix=`verify-${jobId}-`;
  if (h.version === 1 && h.role.startsWith(sealPrefix) && hex(h.role.slice(sealPrefix.length),32)) {
    expected = {version:1,jobId,identityDigest:h.identityDigest,revision:h.revision,parentDigest:h.parentDigest,terminal:h.terminal,role:h.role,digest:h.digest,recordDigest:h.recordDigest};
  } else if (h.version === 2 && h.role.startsWith(verifyPrefix) && hex(h.role.slice(verifyPrefix.length),32) && hex(h.sealDigest,64) && hex(h.sealingHeadDigest,64)) {
    expected = {version:2,jobId,identityDigest:h.identityDigest,sealDigest:h.sealDigest,revision:h.revision,parentDigest:h.parentDigest,terminal:h.terminal,role:h.role,digest:h.digest,recordDigest:h.recordDigest,sealingHeadDigest:h.sealingHeadDigest};
  } else throw Error('Invalid authority head');
  if (Object.keys(h).length !== Object.keys(expected).length || Object.keys(expected).some(k => !Object.hasOwn(h,k))) throw Error('Invalid authority head');
  const encoded = JSON.stringify(expected);
  if (JSON.stringify(h) !== encoded || encoded.length > 2048) throw Error('Noncanonical authority head');
  return { head:expected, encoded, kind:expected.version === 1 ? 'sealing' : 'verification' };
}

export class SyntheticArchiveAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.transactionSync(() => {
      const sql=this.ctx.storage.sql;
      const existing=rows(sql,"SELECT 1 FROM sqlite_schema WHERE name IN ('authority_config','authority_jobs','authority_verifiers','authority_single_sealing') LIMIT 1");
      if (existing.length) { this.#schema(); return; }
      if (rows(sql,'SELECT 1 FROM sqlite_schema LIMIT 1').length) throw Error('Authority object is not fresh');
      sql.exec('CREATE TABLE authority_config (singleton INTEGER PRIMARY KEY CHECK(singleton=1), archive_id TEXT NOT NULL, seal_identity TEXT NOT NULL, verify_identity TEXT NOT NULL, base_policy TEXT NOT NULL, seal_job TEXT NOT NULL)');
      sql.exec('CREATE TABLE authority_jobs (job_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN (\'sealing\',\'verification\')), head TEXT NOT NULL)');
      sql.exec('CREATE TABLE authority_verifiers (job_id TEXT PRIMARY KEY, policy_digest TEXT NOT NULL)');
      sql.exec("CREATE UNIQUE INDEX authority_single_sealing ON authority_jobs(kind) WHERE kind='sealing'");
      this.#schema();
    });
  }

  #schema() {
    // SQLite resolves identifiers case-insensitively but preserves the
    // spelling used in a trigger's ON clause. A binary tbl_name check can
    // therefore miss a trigger on an authority table. TEMP objects can also
    // shadow unqualified names or attach triggers to the main tables.
    if (rows(this.ctx.storage.sql,"SELECT 1 FROM sqlite_temp_schema WHERE name COLLATE NOCASE IN ('authority_config','authority_jobs','authority_verifiers','authority_single_sealing') OR (type='trigger' AND tbl_name COLLATE NOCASE IN ('authority_config','authority_jobs','authority_verifiers')) LIMIT 1").length) throw Error('Authority schema differs');
    const found=rows(this.ctx.storage.sql,"SELECT type,CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,CASE WHEN length(CAST(tbl_name AS BLOB))<=128 THEN tbl_name END AS tbl_name,CASE WHEN length(CAST(sql AS BLOB))<=2048 THEN sql END AS sql FROM sqlite_schema WHERE name COLLATE NOCASE IN ('authority_config','authority_jobs','authority_verifiers','authority_single_sealing') OR (tbl_name COLLATE NOCASE IN ('authority_config','authority_jobs','authority_verifiers') AND type IN ('trigger','index')) ORDER BY type,name LIMIT 7");
    const actual=found.map(r=>[r.type,r.name,r.tbl_name,r.sql]);
    if (JSON.stringify(actual)!==JSON.stringify(schema)) throw Error('Authority schema differs');
  }

  #storedSealing(raw, cfg) {
    if (!raw || typeof raw.job_id!=='string' || typeof raw.head!=='string') throw Error('Invalid stored sealing head');
    let parsed; try { parsed=JSON.parse(raw.head); } catch { throw Error('Invalid stored sealing head'); }
    const checked=checkedHead(parsed,raw.job_id);
    if (checked.kind!=='sealing' || checked.encoded!==raw.head || checked.head.identityDigest!==cfg.seal_identity || raw.job_id!==cfg.seal_job || !checked.head.terminal) throw Error('Invalid stored sealing head');
    return checked;
  }

  // The bootstrap caller and archive identity must be authenticated by a
  // separately administered deployment; this prototype supplies no ingress.
  async initialize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'archiveId,basePolicyDigest,sealingIdentityDigest,sealingJobId,verificationIdentityDigest' ||
        !hex(input.archiveId,32) || !hex(input.basePolicyDigest,64) || !hex(input.sealingJobId,32) || !hex(input.sealingIdentityDigest,64) || !hex(input.verificationIdentityDigest,64)) throw Error('Invalid authority configuration');
    const v={archiveId:input.archiveId,basePolicyDigest:input.basePolicyDigest,sealingJobId:input.sealingJobId,sealingIdentityDigest:input.sealingIdentityDigest,verificationIdentityDigest:input.verificationIdentityDigest};
    if (
        !this.env.ARCHIVE_AUTH || this.env.ARCHIVE_AUTH.idFromName(`mapi-synthetic-authority-v1/${v.archiveId}`).toString() !== this.ctx.id.toString()) throw Error('Invalid authority configuration');
    return this.ctx.storage.transactionSync(() => {
      this.#schema();
      const sql=this.ctx.storage.sql;
      const result=rows(sql,boundedConfig);
      if (!result.length) sql.exec('INSERT INTO authority_config VALUES (1,?,?,?,?,?)',v.archiveId,v.sealingIdentityDigest,v.verificationIdentityDigest,v.basePolicyDigest,v.sealingJobId);
      else if (result.length!==1 || result[0].archive_id!==v.archiveId || result[0].seal_identity!==v.sealingIdentityDigest || result[0].verify_identity!==v.verificationIdentityDigest || result[0].base_policy!==v.basePolicyDigest || result[0].seal_job!==v.sealingJobId) throw Error('Conflicting authority configuration');
      const saved=this.#config();
      if (saved.archive_id!==v.archiveId || saved.seal_identity!==v.sealingIdentityDigest || saved.verify_identity!==v.verificationIdentityDigest || saved.base_policy!==v.basePolicyDigest || saved.seal_job!==v.sealingJobId) throw Error('Authority configuration did not persist');
      return {initialized:true};
    });
  }

  #config() {
    const found=rows(this.ctx.storage.sql,boundedConfig);
    if (found.length!==1 || !hex(found[0].archive_id,32) || !hex(found[0].seal_identity,64) || !hex(found[0].verify_identity,64) || !hex(found[0].base_policy,64) || !hex(found[0].seal_job,32) ||
        !this.env.ARCHIVE_AUTH || this.env.ARCHIVE_AUTH.idFromName(`mapi-synthetic-authority-v1/${found[0].archive_id}`).toString()!==this.ctx.id.toString()) throw Error('Authority is not initialized');
    return found[0];
  }

  #registration(jobId) {
    const found=rows(this.ctx.storage.sql,`SELECT ${boundedPolicy} FROM authority_verifiers WHERE job_id=?`,jobId);
    if (found.length!==1 || !hex(found[0].policy_digest,64)) throw Error('Verifier is not registered');
    return found[0].policy_digest;
  }

  async #verifiedRegistration(jobId) {
    this.#schema();
    const snapshot=this.#config(), stored=this.#registration(jobId);
    if (jobId===snapshot.seal_job || stored!==await sha(verifierPolicy(snapshot.base_policy,jobId,snapshot.verify_identity))) throw Error('Verifier policy differs');
    this.#schema();
    if (JSON.stringify(this.#config())!==JSON.stringify(snapshot) || this.#registration(jobId)!==stored) throw Error('Verifier policy changed');
    return {config:snapshot,digest:stored};
  }

  // Registration is append-only and must only be exposed by the separate
  // trusted bootstrap/admin service binding. It does not authenticate callers.
  async registerVerification(jobId, policyDigest) {
    if (!hex(jobId,32) || !hex(policyDigest,64)) throw Error('Invalid verifier policy');
    this.#schema();
    const snapshot=this.#config();
    if (jobId===snapshot.seal_job || policyDigest!==await sha(verifierPolicy(snapshot.base_policy,jobId,snapshot.verify_identity))) throw Error('Invalid verifier policy');
    return this.ctx.storage.transactionSync(() => {
      this.#schema();
      const current=this.#config();
      if (JSON.stringify(current)!==JSON.stringify(snapshot)) throw Error('Authority configuration changed');
      const found=rows(this.ctx.storage.sql,`SELECT ${boundedPolicy} FROM authority_verifiers WHERE job_id=?`,jobId);
      if (!found.length) this.ctx.storage.sql.exec('INSERT INTO authority_verifiers VALUES (?,?)',jobId,policyDigest);
      else if (found.length!==1 || found[0].policy_digest!==policyDigest) throw Error('Conflicting verifier policy');
      if (this.#registration(jobId)!==policyDigest) throw Error('Verifier policy did not persist');
      return {registered:true};
    });
  }

  // Configuration and registrations are immutable through this API. The
  // check and subsequent RPC are not atomic across objects: independent
  // nonrollback, trusted bindings and privileged-admin controls remain needed.
  async assertPolicy(jobId, basePolicyDigest, policyDigest) {
    if (!hex(jobId,32) || !hex(basePolicyDigest,64)) throw Error('Invalid authority policy');
    this.#schema();
    const cfg=this.#config();
    if (cfg.base_policy!==basePolicyDigest) throw Error('Authority policy differs');
    if (jobId===cfg.seal_job) {
      if (policyDigest!==null) throw Error('Authority policy differs');
      return {allowed:true};
    }
    if (!hex(policyDigest,64)) throw Error('Authority policy differs');
    const registration=await this.#verifiedRegistration(jobId);
    if (JSON.stringify(registration.config)!==JSON.stringify(cfg) || registration.digest!==policyDigest) throw Error('Authority policy differs');
    return {allowed:true};
  }

  async read(jobId) {
    if (!hex(jobId,32)) throw Error('Invalid authority job');
    this.#schema();
    let cfg=this.#config();
    if (jobId!==cfg.seal_job) {
      const registration=await this.#verifiedRegistration(jobId);
      if (JSON.stringify(registration.config)!==JSON.stringify(cfg)) throw Error('Authority configuration changed');
      cfg=registration.config;
      this.#schema();
      if (JSON.stringify(this.#config())!==JSON.stringify(cfg) || this.#registration(jobId)!==registration.digest) throw Error('Verifier policy changed');
    }
    const found=rows(this.ctx.storage.sql,`SELECT ${boundedKind},${boundedHead} FROM authority_jobs WHERE job_id=?`,jobId);
    if (!found.length) return null;
    if (found.length!==1) throw Error('Invalid authority job');
    // SQLite contents can be corrupted or administratively modified. Native
    // parser errors may include the supplied head bytes; never expose them.
    let parsed; try { parsed=JSON.parse(found[0].head); } catch { throw Error('Invalid authority job'); }
    const checked=checkedHead(parsed,jobId);
    if (checked.kind!==found[0].kind || (checked.kind==='sealing')!==(jobId===cfg.seal_job) || checked.encoded!==found[0].head || checked.head.identityDigest!==(checked.kind==='sealing'?cfg.seal_identity:cfg.verify_identity)) throw Error('Invalid authority job');
    return checked.head;
  }

  async create(jobId, input) {
    const next=checkedHead(input,jobId);
    if (next.head.revision!==0 || next.head.terminal || next.head.parentDigest!=='') throw Error('Invalid initial authority head');
    let sealing, sealingDigest, registration;
    if (next.kind==='verification') {
      registration=await this.#verifiedRegistration(jobId);
      this.#schema();
      const found=rows(this.ctx.storage.sql,`SELECT ${boundedHead} FROM authority_jobs WHERE kind='sealing' LIMIT 2`);
      if (found.length!==1) throw Error('Terminal sealing authority required');
      if (typeof found[0].head!=='string') throw Error('Invalid stored sealing head');
      sealing=found[0].head; sealingDigest=await sha(sealing);
    }
    return this.ctx.storage.transactionSync(() => {
      this.#schema();
      const sql=this.ctx.storage.sql, cfg=this.#config();
      if (next.head.identityDigest !== (next.kind==='sealing'?cfg.seal_identity:cfg.verify_identity)) throw Error('Foreign authority identity');
      if (next.kind==='sealing' ? jobId!==cfg.seal_job : JSON.stringify(cfg)!==JSON.stringify(registration.config) || this.#registration(jobId)!==registration.digest) throw Error('Authority job policy differs');
      if (rows(sql,'SELECT 1 AS present FROM authority_jobs WHERE job_id=?',jobId).length) throw Error('Authority job already exists');
      if (next.kind==='sealing') {
        if (rows(sql,"SELECT 1 AS present FROM authority_jobs WHERE kind='sealing' LIMIT 1").length) throw Error('Sealing job already exists');
      } else {
        const current=rows(sql,`SELECT ${boundedId},${boundedHead} FROM authority_jobs WHERE kind='sealing' LIMIT 2`);
        if (current.length!==1 || current[0].head!==sealing || next.head.sealingHeadDigest!==sealingDigest) throw Error('Terminal sealing authority differs');
        this.#storedSealing(current[0],cfg);
      }
      sql.exec('INSERT INTO authority_jobs VALUES (?,?,?)',jobId,next.kind,next.encoded);
      const saved=rows(sql,`SELECT ${boundedKind},${boundedHead} FROM authority_jobs WHERE job_id=?`,jobId);
      if (saved.length!==1 || saved[0].kind!==next.kind || saved[0].head!==next.encoded) throw Error('Authority job did not persist');
      return {created:true};
    });
  }

  async compareAndSwap(jobId, expectedInput, nextInput) {
    const expected=checkedHead(expectedInput,jobId), next=checkedHead(nextInput,jobId);
    let sealSnapshot, sealDigest, registration;
    if (next.kind==='verification') {
      registration=await this.#verifiedRegistration(jobId);
      this.#schema();
      const found=rows(this.ctx.storage.sql,`SELECT ${boundedHead} FROM authority_jobs WHERE kind='sealing' LIMIT 2`);
      if (found.length!==1) throw Error('Terminal sealing authority required');
      if (typeof found[0].head!=='string') throw Error('Invalid stored sealing head');
      sealSnapshot=found[0].head; sealDigest=await sha(sealSnapshot);
    }
    if (expected.kind!==next.kind || expected.head.terminal || next.head.revision!==expected.head.revision+1 ||
        !Number.isSafeInteger(next.head.revision) || next.head.identityDigest!==expected.head.identityDigest ||
        (next.kind==='verification' && (next.head.sealDigest!==expected.head.sealDigest || next.head.sealingHeadDigest!==expected.head.sealingHeadDigest)) ||
        next.head.parentDigest!==await sha(expected.encoded)) throw Error('Invalid authority transition');
    return this.ctx.storage.transactionSync(() => {
      this.#schema();
      const sql=this.ctx.storage.sql, cfg=this.#config();
      if (next.head.identityDigest !== (next.kind==='sealing'?cfg.seal_identity:cfg.verify_identity)) throw Error('Foreign authority identity');
      if (next.kind==='sealing' ? jobId!==cfg.seal_job : JSON.stringify(cfg)!==JSON.stringify(registration.config) || this.#registration(jobId)!==registration.digest) throw Error('Authority job policy differs');
      const found=rows(sql,`SELECT ${boundedKind},${boundedHead} FROM authority_jobs WHERE job_id=?`,jobId);
      if (found.length!==1 || found[0].kind!==expected.kind || found[0].head!==expected.encoded) throw Error('Authority head differs');
      if (next.kind==='verification') {
        const sealed=rows(sql,`SELECT ${boundedId},${boundedHead} FROM authority_jobs WHERE kind='sealing' LIMIT 2`);
        if (sealed.length!==1 || sealed[0].head!==sealSnapshot || sealDigest!==next.head.sealingHeadDigest) throw Error('Terminal sealing authority required');
        this.#storedSealing(sealed[0],cfg);
      }
      sql.exec('UPDATE authority_jobs SET head=? WHERE job_id=?',next.encoded,jobId);
      const saved=rows(sql,`SELECT ${boundedKind},${boundedHead} FROM authority_jobs WHERE job_id=?`,jobId);
      if (saved.length!==1 || saved[0].kind!==next.kind || saved[0].head!==next.encoded) throw Error('Authority update did not persist');
      return {updated:true};
    });
  }
}
