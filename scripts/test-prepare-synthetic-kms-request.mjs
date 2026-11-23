import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { prepareSyntheticKmsRequest } from './prepare-synthetic-kms-request.mjs';

const owner = '123456789012', other = '222222222222';
const role = (account, name, partition = 'aws') => `arn:${partition}:iam::${account}:role/synthetic/${name}`;
const base = {
  partition: 'aws', accountId: owner, region: 'us-east-1',
  runId: 'mapi-p1-syn-20261123T123456Z-0123456789abcdef0123456789abcdef',
  adminRole: role(owner, 'admin'), breakglassRole: role(owner, 'breakglass'),
  writerRole: role(owner, 'writer'), recoveryRole: role(owner, 'recoverer'),
};
const request = prepareSyntheticKmsRequest(base);
const create = request.createKeyRequest;
const policy = JSON.parse(create.Policy);
assert.equal(request.reviewOnly, true);
assert.equal(request.region, base.region);
assert.equal(create.KeySpec, 'SYMMETRIC_DEFAULT');
assert.equal(create.KeyUsage, 'ENCRYPT_DECRYPT');
assert.equal(create.Origin, 'AWS_KMS');
assert.equal(create.MultiRegion, false);
assert.equal(create.BypassPolicyLockoutSafetyCheck, false);
assert.equal(policy.Version, '2012-10-17');
assert.deepEqual(policy.Statement[0].Principal.AWS, [base.adminRole, base.breakglassRole]);
assert.deepEqual(policy.Statement[1].Action, ['kms:GenerateDataKey', 'kms:Decrypt']);
assert.equal(policy.Statement[2].Action, 'kms:Decrypt');
for (const entry of policy.Statement.slice(1, 3)) {
  assert.deepEqual(entry.Condition.StringEquals, {
    'kms:EncryptionContext:purpose': 'mapi-phase1-synthetic-archive',
    'kms:EncryptionContext:run_id': base.runId,
  });
  assert.deepEqual(entry.Condition['ForAllValues:StringEquals']['kms:EncryptionContextKeys'], ['purpose', 'run_id']);
}
assert.deepEqual(policy.Statement[3].Action, ['kms:DisableKey', 'kms:ScheduleKeyDeletion']);
assert.equal(policy.Statement[3].Effect, 'Deny');
assert(policy.Statement.every(entry => !entry.Action.includes('kms:CreateGrant')));
assert(request.unverified.includes('role existence and trust'));

const fail = changes => assert.throws(() => prepareSyntheticKmsRequest({ ...base, ...changes }), /Invalid synthetic KMS/);
fail({ region: 'us-gov-west-1' });
fail({ region: 'us-isob-east-1' });
fail({ partition: 'aws-cn' });
fail({ region: 'bogus' });
fail({ accountId: '123' });
fail({ accountId: 123456789012 });
fail({ runId: 'mapi-p1-syn-20261301T123456Z-0123456789abcdef0123456789abcdef' });
fail({ runId: 'mapi-p1-syn-20261123T123456Z-*' });
fail({ adminRole: base.writerRole });
fail({ writerRole: `arn:aws:iam::${owner}:role/other/ADMIN` });
fail({ adminRole: role(other, 'admin') });
fail({ writerRole: role(other, 'writer') });
fail({ recoveryRole: role(other, 'recovery') });
fail({ writerRole: `arn:aws:iam::${owner}:role/*` });
fail({ writerRole: `arn:aws:sts::${owner}:assumed-role/writer/session` });
fail({ writerRole: role(owner, 'writer', 'aws-cn') });
fail({ writerRole: `arn:aws:iam::${owner}:role//writer` });
fail({ writerAccounts: `${other},${other}` });
fail({ writerAccounts: '*' });
fail({ unexpected: true });
const cross = prepareSyntheticKmsRequest({ ...base, writerRole: role(other, 'writer'),
  recoveryRole: role(other, 'recoverer'), writerAccounts: other, recoveryAccounts: other });
assert.equal(JSON.parse(cross.createKeyRequest.Policy).Statement[1].Principal.AWS, role(other, 'writer'));
assert.equal(JSON.parse(cross.createKeyRequest.Policy).Statement[2].Principal.AWS, role(other, 'recoverer'));
assert.throws(() => prepareSyntheticKmsRequest({ ...base, writerRole: role(other, 'writer'),
  recoveryRole: role(other, 'recoverer'), writerAccounts: other }), /Invalid synthetic KMS/);

const cliArgs = ['--partition', base.partition, '--account-id', owner, '--region', base.region,
  '--run-id', base.runId, '--admin-role', base.adminRole, '--breakglass-role', base.breakglassRole,
  '--writer-role', base.writerRole, '--recovery-role', base.recoveryRole];
const path = new URL('./prepare-synthetic-kms-request.mjs', import.meta.url);
const run = args => spawnSync(process.execPath, [path.pathname, ...args], { encoding: 'utf8' });
const valid = run(cliArgs);
assert.equal(valid.status, 0);
assert.deepEqual(JSON.parse(valid.stdout), request);
const duplicate = run([...cliArgs, '--region', 'us-west-2']);
assert.equal(duplicate.status, 1);
assert.equal(duplicate.stdout, '');
assert.match(duplicate.stderr, /no AWS request was sent/);
console.log('Synthetic KMS offline request tests passed');
