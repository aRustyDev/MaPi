# Synthetic KMS writer and recovery roles

Status: **synthetic roles created and scoped key access tested** as recorded in `aws-synthetic-kms-key-creation.md`. At the user's direction both roles trust the same `tf-admin-aiml-dev` IAM role, so independent custody remains an open gate. The generic trust placeholder below is not executable and is not a claim of separate identities. This note does not establish an archive writer or a verified restore.

## Proposed roles and trust

For the synthetic run `mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a`, propose these names in account `646535719915`:

- Writer: `mapi-p1-wr-bef5970113984cf34aa5c70e9d0a2c9a`.
- Recovery: `mapi-p1-rc-bef5970113984cf34aa5c70e9d0a2c9a`.

A read-only, paginated IAM inventory found neither name before creation. The roles were then created, and their IDs, trust and inline policies were read back. Both trust the same verified IAM Identity Center administrator role at the user's direction; different role names do not prove independent custody. Existing AWS administrators can change role and key policies. Any future replacement must verify account, caller, exact names, trust identities and control domains before creation and stop on collision or uncertainty.

If a trusted identity is an AWS IAM role or user, a role's trust policy can use the following shape, separately for each verified principal:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"AWS": "<VERIFIED_EXACT_TRUSTED_IDENTITY_ARN>"},
    "Action": "sts:AssumeRole"
  }]
}
```

Use only the exact identity for that role; do not substitute an account root, wildcard or STS session ARN. Cross-account callers need their own authority to assume the role; a third-party trust may also need an agreed external ID. If a trusted identity is federated instead, the user must identify a real registered provider and exact audience and subject; construct a separate `sts:AssumeRoleWithWebIdentity` trust for it after verification. Do not assume a Cloudflare Worker already has an AWS OIDC identity. AWS describes [role trust](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_policy-examples.html) and [cross-account trust](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_update-role-trust-policy.html).

## Role permission policies

The writer's proposed inline identity policy is restricted to the existing synthetic key and the exact nonsecret context. Writer decryption is included for resuming a previously wrapped data key; it must not generate a replacement key after an uncertain write without the archive protocol's durable retry rules.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "SyntheticArchiveWriter",
    "Effect": "Allow",
    "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
    "Resource": "arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f",
    "Condition": {
      "StringEquals": {
        "kms:EncryptionContext:purpose": "mapi-phase1-synthetic-archive",
        "kms:EncryptionContext:run_id": "mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a"
      },
      "ForAllValues:StringEquals": {"kms:EncryptionContextKeys": ["purpose", "run_id"]}
    }
  }]
}
```

The recovery role's proposed inline policy is decrypt-only:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "SyntheticArchiveRecovery",
    "Effect": "Allow",
    "Action": "kms:Decrypt",
    "Resource": "arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f",
    "Condition": {
      "StringEquals": {
        "kms:EncryptionContext:purpose": "mapi-phase1-synthetic-archive",
        "kms:EncryptionContext:run_id": "mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a"
      },
      "ForAllValues:StringEquals": {"kms:EncryptionContextKeys": ["purpose", "run_id"]}
    }
  }]
}
```

The recovery policy grants no `GenerateDataKey`, administrative, source, archive-write or archive-delete access. If a verified caller needs `kms:DescribeKey`, grant it in a separate statement scoped to this key, without encryption-context conditions.

The two fixed `StringEquals` conditions require both context pairs; the set condition rejects additional keys. The context is visible in CloudTrail and contains no secrets. AWS documents the distinction between single-valued context conditions and the set-valued [context-keys condition](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html).

## Key policy merge and verification

The current key policy is administrator-only. Role identity policies alone do not grant these roles access: re-read the current key policy immediately before a change, then merge explicit key-policy statements for the **created and verified role ARNs** with the same respective actions and context conditions. In a key policy the `Resource` is `"*"` for that key; each statement needs its explicit `Principal`. Preserve the existing administrators, their `kms:ListResourceTags` access, and the deny on `kms:DisableKey` and `kms:ScheduleKeyDeletion`; do not bypass the lockout safety check. IAM and KMS policy changes are eventually consistent and must be read back and compared. See [KMS key permissions](https://docs.aws.amazon.com/kms/latest/developerguide/control-access.html).

For each creation or policy change, record the nonsecret intent and result before advancing. An uncertain response requires read-only reconciliation against the exact resource and policy, not a blind retry. Test with separately authenticated synthetic writer and recovery identities, exact and wrong contexts, unauthorized principals, and a recreated recovery environment. Do not log plaintext data keys or credentials. Keep the key enabled, preserve the source replay chunks, and do not claim retention, custody independence or a recoverable archive from role creation alone.
