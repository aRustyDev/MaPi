// Explicit synthetic-only test: no output contains credentials or key bytes.
// It uses a local in-memory bucket and the real synthetic AWS KMS key/roles.
import { randomBytes } from 'node:crypto';
import { mintSyntheticArchiveKey, openSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';
import { assertAssumedIdentity, assertPinnedAwsCli, assertSystemCa, awsCli, safeBaseEnvironment } from './synthetic-kms-cli-safety.mjs';

if (process.env.MAPI_SYNTHETIC_KMS_LIVE !== '1') throw new Error('Explicit synthetic KMS test opt-in is required');
const account = '646535719915', keyArn = `arn:aws:kms:us-east-1:${account}:key/7614cff5-444e-4615-a785-4192dd150c2f`;
const runId = 'mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
const writerName = 'mapi-p1-wr-bef5970113984cf34aa5c70e9d0a2c9a', recoveryName = 'mapi-p1-rc-bef5970113984cf34aa5c70e9d0a2c9a';
const context = `purpose=mapi-phase1-synthetic-archive,run_id=${runId}`;
const base = safeBaseEnvironment(process.env);

function secretBytes(value) {
  const buffer = Buffer.from(value, 'base64');
  try { return new Uint8Array(buffer); } finally { buffer.fill(0); }
}

async function assumed(name, roleId) {
  const result = await awsCli(['sts', 'assume-role', '--profile', 'tf-admin-aiml-dev', '--role-arn',
    `arn:aws:iam::${account}:role/mapi/synthetic/${name}`, '--role-session-name', 'mapi-synthetic-key-provider', '--duration-seconds', '900'], base);
  const credential = result.Credentials;
  if (!credential?.AccessKeyId || !credential?.SecretAccessKey || !credential?.SessionToken) throw new Error('Invalid assumed-role credentials');
  const env = { ...base, AWS_ACCESS_KEY_ID: credential.AccessKeyId, AWS_SECRET_ACCESS_KEY: credential.SecretAccessKey, AWS_SESSION_TOKEN: credential.SessionToken };
  delete env.AWS_PROFILE; delete env.AWS_DEFAULT_PROFILE;
  result.Credentials = undefined;
  const identity = await awsCli(['sts', 'get-caller-identity'], env);
  assertAssumedIdentity(identity, account, name, roleId);
  return env;
}

class MemoryBucket {
  objects = new Map();
  async put(name, value, options) {
    if (options.onlyIf.get('If-None-Match') !== '*') throw new Error('Conditional write required');
    if (this.objects.has(name)) return null;
    this.objects.set(name, new Uint8Array(value)); return { name };
  }
  async get(name) {
    const bytes = this.objects.get(name); if (!bytes) return null;
    return { size: bytes.length, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } }) };
  }
}

try {
  assertSystemCa();
  assertPinnedAwsCli();
  const identity = await awsCli(['sts', 'get-caller-identity', '--profile', 'tf-admin-aiml-dev'], base);
  assertAssumedIdentity(identity, account, 'AWSReservedSSO_AdministratorAccess_3a59fce8199e956f', 'AROAZNCEIFPV5G7RYTP6W');
  const description = await awsCli(['kms', 'describe-key', '--profile', 'tf-admin-aiml-dev', '--key-id', keyArn], base);
  if (description.KeyMetadata?.Arn !== keyArn || description.KeyMetadata?.KeyState !== 'Enabled' || description.KeyMetadata?.KeySpec !== 'SYMMETRIC_DEFAULT') throw new Error('Synthetic key state mismatch');
  const writer = await assumed(writerName, 'AROAZNCEIFPV23UFUR333'), recovery = await assumed(recoveryName, 'AROAZNCEIFPVYUA2YH6A2');
  const kms = {
    async generateDataKey(request) {
      if (request.KeyId !== keyArn || request.KeySpec !== 'AES_256' || request.EncryptionContext?.purpose !== 'mapi-phase1-synthetic-archive' || request.EncryptionContext?.run_id !== runId || Object.keys(request.EncryptionContext).length !== 2) throw new Error('Unexpected KMS context');
      const result = await awsCli(['kms', 'generate-data-key', '--key-id', keyArn, '--key-spec', 'AES_256', '--encryption-context', context], writer);
      const plaintext = secretBytes(result.Plaintext), wrapped = new Uint8Array(Buffer.from(result.CiphertextBlob, 'base64'));
      result.Plaintext = undefined; return { KeyId: result.KeyId, Plaintext: plaintext, CiphertextBlob: wrapped };
    },
    async decrypt(request) {
      if (request.KeyId !== keyArn || request.EncryptionContext?.purpose !== 'mapi-phase1-synthetic-archive' || request.EncryptionContext?.run_id !== runId || Object.keys(request.EncryptionContext).length !== 2) throw new Error('Unexpected KMS context');
      const result = await awsCli(['kms', 'decrypt', '--key-id', keyArn, '--ciphertext-blob', 'fileb:///dev/stdin', '--encryption-context', context], recovery, Buffer.from(request.CiphertextBlob));
      const plaintext = secretBytes(result.Plaintext); result.Plaintext = undefined; return { KeyId: result.KeyId, Plaintext: plaintext };
    },
  };
  const bucket = new MemoryBucket(), scope = { keyArn, runId, archiveId: randomBytes(16).toString('hex'), manifestDigest: randomBytes(32).toString('hex') };
  const minted = await mintSyntheticArchiveKey(bucket, kms, scope, AbortSignal.timeout(60000));
  // Test-only: this digest is held by this process, not an independent authority.
  const key = await openSyntheticArchiveKey(bucket, kms, scope, minted.provisionalEnvelopeDigest, AbortSignal.timeout(60000));
  if (key.extractable || key.algorithm.name !== 'AES-GCM') throw new Error('Unexpected AES key');
  const iv = randomBytes(12), sample = new Uint8Array([1, 2, 3]);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, sample);
  const decoded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted));
  if (decoded.length !== sample.length || !decoded.every((value, index) => value === sample[index])) throw new Error('Synthetic key roundtrip failed');
  console.log('Live synthetic KMS writer/recovery key-envelope roundtrip passed; credentials and plaintext were not printed or explicitly saved.');
  console.log('The bucket and commitment were in-memory, and both roles used the same SSO identity; no archive or independent custody is proven.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Synthetic KMS test failed');
  process.exitCode = 1;
}
