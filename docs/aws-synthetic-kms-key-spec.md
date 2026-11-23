# AWS KMS escrow for the synthetic archive

Status: **reviewable full-use policy template only**. A synthetic key and context-limited writer and recovery roles have since been created and tested as recorded in `aws-synthetic-kms-key-creation.md`; this template was not applied verbatim. This is limited to the synthetic rehearsal in `synthetic-archive-staging-policy.md`. It does not authorize a real-project move or establish an archive writer, independent recovery, retention enforcement, or a verified restore.

## Proposed key and missing inputs

Use one new customer-managed, single-Region symmetric encryption KMS key with `KeySpec=SYMMETRIC_DEFAULT`, `KeyUsage=ENCRYPT_DECRYPT`, and AWS-generated key material (`Origin=AWS_KMS`). The key wraps a fresh synthetic data key for each archive; it does not itself store that data key or encrypt the complete archive. Record the KMS key ARN and the encrypted data-key blob with the authenticated archive metadata. Do not persist plaintext data keys in source SQLite, archive objects, repository files, logs, or test output. A writer or recovery process holds plaintext key material only as needed in memory. AWS documents [GenerateDataKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html) and [data-key handling](https://docs.aws.amazon.com/kms/latest/cryptographic-details/generating-data-keys.html).

The eventual archive writer must persist and authenticate its selected wrapped data key and nonce-allocation state before publishing ciphertext, and restore that exact key and state on retry. It must ensure a nonce is never reused with the same data key, including across lost acknowledgements, concurrent attempts and restored checkpoints. A nonce counter stored only in an object that can be rewound is not a sufficient authority after restoration. A fresh `GenerateDataKey` response cannot be assumed recoverable after its ciphertext blob is lost: KMS does not store that blob. Exact ciphertext retry, conflict handling, a complete authenticated seal, and the independent source commitment remain separate protocol requirements; this template does not implement them.

Before preparing an executable create request, independently verify and supply:

- The AWS partition, account ID and Region, plus an operator-approved allowlist confirming this account is the independently administered synthetic key-custody account. Also identify the separate archive-storage and source authorities and their actual administrative failure domains.
- Existing IAM role ARNs in the KMS account for the key administrator and separately controlled break-glass administrator, and existing role ARNs for the synthetic archive writer and independent recovery operator. The actual creator must be authorized and retain `kms:PutKeyPolicy`; do not bypass the KMS policy-lockout check. Verify role identities, trust policies, account ownership and effective permissions. Do not assume that a Cloudflare Worker already has an AWS identity or store long-lived AWS credentials in the Worker. An AWS [web-identity role](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html), if selected, needs a real trusted identity provider and restricted audience and subject.
- A fresh synthetic run ID and the approved recovery authorization path. The fixed context below contains no secret or project data: KMS records encryption context in plaintext in CloudTrail. It must match exactly when decrypting. If the run ID or authenticated archive format changes, review policy and format together. See [KMS encryption context](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html).
- An independent, recoverable key-custody and access-control arrangement; effective archive-store retention and grants; the actual archive envelope, complete authenticated seal and restore protocol; and the account/credential-loss procedure. A KMS key or a local mock alone does not prove these.

The following template is deliberately **not executable until every placeholder is replaced and the resulting identities and access are reviewed**. It grants no general wildcard principal, no `kms:CreateGrant`, and no broad `kms:*`. Writer `Decrypt` is included only for restarting an interrupted synthetic writer with its already wrapped data key; recovery has `Decrypt` only. Confirm these operations match the eventual reviewed writer before creation. Key policies are Regional and are the primary authorization control; cross-account access additionally needs suitable identity policies in the caller account. See [KMS key policies](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html) and [least privilege](https://docs.aws.amazon.com/kms/latest/developerguide/least-privilege.html).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SyntheticKeyAdministration",
      "Effect": "Allow",
      "Principal": {"AWS": ["<KMS_ADMIN_ROLE_ARN>", "<KMS_BREAKGLASS_ROLE_ARN>"]},
      "Action": ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:PutKeyPolicy", "kms:GetKeyRotationStatus", "kms:EnableKeyRotation", "kms:EnableKey", "kms:CancelKeyDeletion"],
      "Resource": "*"
    },
    {
      "Sid": "WriterGenerateAndResumeSyntheticDataKey",
      "Effect": "Allow",
      "Principal": {"AWS": "<SYNTHETIC_WRITER_ROLE_ARN>"},
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "kms:EncryptionContext:purpose": "mapi-phase1-synthetic-archive",
          "kms:EncryptionContext:run_id": "<SYNTHETIC_RUN_ID>"
        },
        "ForAllValues:StringEquals": {"kms:EncryptionContextKeys": ["purpose", "run_id"]}
      }
    },
    {
      "Sid": "RecoveryDecryptSyntheticDataKey",
      "Effect": "Allow",
      "Principal": {"AWS": "<INDEPENDENT_RECOVERY_ROLE_ARN>"},
      "Action": "kms:Decrypt",
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "kms:EncryptionContext:purpose": "mapi-phase1-synthetic-archive",
          "kms:EncryptionContext:run_id": "<SYNTHETIC_RUN_ID>"
        },
        "ForAllValues:StringEquals": {"kms:EncryptionContextKeys": ["purpose", "run_id"]}
      }
    },
    {
      "Sid": "PreventDisableOrDeletionDuringSyntheticHold",
      "Effect": "Deny",
      "Principal": {"AWS": "*"},
      "Action": ["kms:DisableKey", "kms:ScheduleKeyDeletion"],
      "Resource": "*"
    }
  ]
}
```

`Resource: "*"` in a KMS key policy refers to the key to which that policy is attached; it is not an IAM policy granting access to every key. The deny is intended to keep the synthetic key usable during the hold, including interrupted runs. It is not an immutable retention guarantee: administrators with `kms:PutKeyPolicy` can alter the policy and grant access. Verify and audit effective IAM, grants, administrator separation and applicable organization controls independently. The account must have an operator-reviewed break-glass and disposition process; removing the deny, disabling or deleting a key is a separate future action after the policy's holds and retention requirements are satisfied, not an action authorized by this template.

The seven-day synthetic period requires the key to remain **enabled and decryptable** throughout the entire period after independent final-seal verification. Scheduling deletion immediately makes a key unusable, even during KMS's 7–30-day waiting period; that waiting period is not seven days of recovery availability. An unsealed or unresolved archive has no start time for this minimum and remains on hold. See [KMS key deletion](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html).

Optional automatic rotation for the AWS-generated symmetric key can be enabled and verified with the approved administrator. KMS retains earlier backing material to decrypt ciphertext made before rotation; rotation does not rotate data keys or re-encrypt existing archive objects. Preserve the KMS key ARN, wrapped data key and exact nonsecret context for every retained archive. See [KMS key rotation](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html).

## Creation and evidence boundaries

`scripts/prepare-synthetic-kms-request.mjs` can assemble a **review-only** request offline after operators have supplied the candidate inputs. It does not contact AWS or verify them. Pass `--partition`, `--account-id`, `--region`, `--run-id`, `--admin-role`, `--breakglass-role`, `--writer-role`, and `--recovery-role` as separate flags. The run ID must have the form `mapi-p1-syn-YYYYMMDDTHHMMSSZ-<32 lowercase hex characters>`. Writer and recovery roles default to the key account; cross-account roles require their own explicit comma-separated `--writer-account-allowlist` or `--recovery-account-allowlist`. The generator rejects duplicate or malformed flags, wildcards and non-distinct role names, but cannot establish the freshness or randomness of the ID, actual Region availability, role existence or trust, account ownership, or independent administration. Its output is a review envelope: only the nested `createKeyRequest` has the AWS API request shape. It is not a command or an authorization to create a key. `node scripts/test-prepare-synthetic-kms-request.mjs` checks the offline policy and input constraints.

First perform read-only verification of the chosen account, Region, roles, trust, existing keys/aliases and exact synthetic resource name against the run allowlist. Use a unique nonsecret run identifier and never repurpose a pre-existing key. Generate a concrete policy from verified principal ARNs and validate it before the authorized creation call; do not set `BypassPolicyLockoutSafetyCheck`. The policy and request must be reviewable without displaying credentials or key material. If creation has an uncertain outcome, reconcile the account inventory and audit log before any retry; do not assume it failed or create another key blindly. Consult [CreateKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_CreateKey.html).

After a successful authorized creation, record only the key ARN, Region, state, key-policy digest, identities, nonsecret run context and relevant audit identifiers. Verify the intended writer can generate and resume a synthetic data key, the independent recovery identity can decrypt it in a recreated environment, wrong context and unauthorized roles fail, the key remains enabled through the hold, rotation preserves recovery, and the complete archive can actually be restored. Verify effective deletion and policy-change controls separately. A standalone KMS test or successful key creation is not a verified archive, independently durable store, complete history proof, hosted rehearsal, or cutover authorization.
