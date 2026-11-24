// Offline preparation only. This module does not call AWS or verify identity,
// IAM roles, trust, regional availability, account independence or freshness.
import { pathToFileURL } from 'node:url';

const flags = {
  '--partition': 'partition', '--account-id': 'accountId', '--region': 'region',
  '--run-id': 'runId', '--admin-role': 'adminRole', '--breakglass-role': 'breakglassRole',
  '--writer-role': 'writerRole', '--recovery-role': 'recoveryRole',
  '--writer-account-allowlist': 'writerAccounts', '--recovery-account-allowlist': 'recoveryAccounts',
};
const accountPattern = /^[0-9]{12}$/;

function invalid() { throw new Error('Invalid synthetic KMS preparation input'); }

function accountList(text, owner) {
  if (text === undefined) return new Set([owner]);
  if (typeof text !== 'string' || !text) invalid();
  const accounts = text.split(',');
  if (accounts.some(account => !accountPattern.test(account)) || new Set(accounts).size !== accounts.length) invalid();
  return new Set(accounts);
}

function roleAccount(arn, partition) {
  if (typeof arn !== 'string' || arn.length > 2048) invalid();
  const match = /^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role\/(.+)$/.exec(arn);
  if (!match || match[1] !== partition) invalid();
  const parts = match[3].split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9+=,.@_-]+$/.test(part)) ||
      parts.at(-1).length > 64 || match[3].length > 512) invalid();
  // IAM role names are unique per account, regardless of case or path.
  // Keep the exact ARN for the policy, but reject ambiguous aliases here.
  return { account: match[2], identity: `${match[2]}:${parts.at(-1).toLowerCase()}` };
}

function validRegion(partition, region) {
  if (typeof region !== 'string' || !/^[a-z]{2}-(?:[a-z]+-)+[1-9][0-9]*$/.test(region)) return false;
  if (partition === 'aws-us-gov') return /^us-gov-/.test(region);
  if (partition === 'aws-cn') return /^cn-/.test(region);
  return partition === 'aws' && !/^(?:us-gov|cn|us-iso|us-isob|us-isof|eu-isoe)-/.test(region);
}

function validRunId(runId) {
  if (typeof runId !== 'string') return false;
  const match = /^mapi-p1-syn-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z-([0-9a-f]{32})$/.exec(runId);
  if (!match) return false;
  const timestamp = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
  const date = new Date(timestamp);
  return Number.isFinite(date.valueOf()) && date.toISOString() === timestamp;
}

export function prepareSyntheticKmsRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const known = new Set(Object.values(flags));
  if (Object.keys(input).some(key => !known.has(key))) invalid();
  const { partition, accountId, region, runId, adminRole, breakglassRole, writerRole, recoveryRole } = input;
  if (!['aws', 'aws-us-gov', 'aws-cn'].includes(partition) || typeof accountId !== 'string' || !accountPattern.test(accountId) ||
      !validRegion(partition, region) || !validRunId(runId)) invalid();
  const roles = [adminRole, breakglassRole, writerRole, recoveryRole];
  const principals = roles.map(role => roleAccount(role, partition));
  if (new Set(principals.map(principal => principal.identity)).size !== roles.length ||
      principals[0].account !== accountId || principals[1].account !== accountId ||
      !accountList(input.writerAccounts, accountId).has(principals[2].account) ||
      !accountList(input.recoveryAccounts, accountId).has(principals[3].account)) invalid();

  const context = { purpose: 'mapi-phase1-synthetic-archive', run_id: runId };
  const condition = {
    StringEquals: { 'kms:EncryptionContext:purpose': context.purpose, 'kms:EncryptionContext:run_id': context.run_id },
    'ForAllValues:StringEquals': { 'kms:EncryptionContextKeys': ['purpose', 'run_id'] },
  };
  const policy = {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'SyntheticKeyAdministration', Effect: 'Allow', Principal: { AWS: [adminRole, breakglassRole] },
        Action: ['kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:PutKeyPolicy', 'kms:GetKeyRotationStatus',
          'kms:EnableKeyRotation', 'kms:EnableKey', 'kms:CancelKeyDeletion'], Resource: '*' },
      { Sid: 'WriterGenerateAndResumeSyntheticDataKey', Effect: 'Allow', Principal: { AWS: writerRole },
        Action: ['kms:GenerateDataKey', 'kms:Decrypt'], Resource: '*', Condition: condition },
      { Sid: 'RecoveryDecryptSyntheticDataKey', Effect: 'Allow', Principal: { AWS: recoveryRole },
        Action: 'kms:Decrypt', Resource: '*', Condition: condition },
      { Sid: 'PreventDisableOrDeletionDuringSyntheticHold', Effect: 'Deny', Principal: { AWS: '*' },
        Action: ['kms:DisableKey', 'kms:ScheduleKeyDeletion'], Resource: '*' },
    ],
  };
  return {
    reviewOnly: true,
    unverified: ['account identity and independence', 'region existence and availability', 'role existence and trust',
      'creator policy access', 'run ID freshness', 'effective permissions and controls'],
    partition, accountId, region, encryptionContext: context,
    createKeyRequest: {
      Description: `MaPi Phase 1 synthetic archive escrow ${runId}`,
      KeyUsage: 'ENCRYPT_DECRYPT', KeySpec: 'SYMMETRIC_DEFAULT', Origin: 'AWS_KMS', MultiRegion: false,
      BypassPolicyLockoutSafetyCheck: false, Policy: JSON.stringify(policy),
      Tags: [{ TagKey: 'Project', TagValue: 'MaPi' }, { TagKey: 'Environment', TagValue: 'synthetic' },
        { TagKey: 'RunId', TagValue: runId }],
    },
  };
}

function argumentsToInput(args) {
  const input = {};
  for (let index = 0; index < args.length; index += 2) {
    const field = flags[args[index]];
    if (!field || Object.hasOwn(input, field) || index + 1 >= args.length || args[index + 1].startsWith('--')) invalid();
    input[field] = args[index + 1];
  }
  return input;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(prepareSyntheticKmsRequest(argumentsToInput(process.argv.slice(2))), null, 2)}\n`);
  } catch {
    process.stderr.write('Invalid synthetic KMS preparation input; no AWS request was sent.\n');
    process.exitCode = 1;
  }
}
