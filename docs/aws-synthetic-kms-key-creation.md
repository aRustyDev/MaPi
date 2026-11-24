# Synthetic AWS KMS key creation

On 2026-11-23 UTC, one synthetic staging KMS key was created using the selected `tf-admin-aiml-dev` profile in AWS account `646535719915`, Region `us-east-1`.

- Key ARN: `arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f`
- Synthetic run ID: `mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a`
- AWS read-back: enabled, `SYMMETRIC_DEFAULT`, `ENCRYPT_DECRYPT`, `AWS_KMS` origin. Synthetic run tags matched the creation request. After the role grants below, the key policy matched the staged policy after normalizing statement/action order and single-action representation; canonical policy SHA-256: `3d33a22e619c8eae4f279c8a485e52fa45fe0ad96b9ed9421ea6e9c915a4b795`.
- The policy grants key administration to the verified IAM Identity Center administrator role and the existing `OrganizationAccountAccessRole`. It denies `DisableKey` and `ScheduleKeyDeletion` during the synthetic hold. Administrators with `PutKeyPolicy` can change that policy, so this is not immutable retention or proof of independent administration.

The initial tag read was denied because the staged administrator policy omitted `kms:ListResourceTags`. The policy was updated to add that read permission to the same administrators; the policy and tags were then verified.

The user requested both synthetic roles trust the same `tf-admin-aiml-dev` IAM role and chose to keep the independent-recovery gate open. The roles are:

- Writer: `arn:aws:iam::646535719915:role/mapi/synthetic/mapi-p1-wr-bef5970113984cf34aa5c70e9d0a2c9a` (role ID `AROAZNCEIFPV23UFUR333`).
- Recovery: `arn:aws:iam::646535719915:role/mapi/synthetic/mapi-p1-rc-bef5970113984cf34aa5c70e9d0a2c9a` (role ID `AROAZNCEIFPVYUA2YH6A2`).

Both role trust documents, inline policies and synthetic run tags were read back and matched their staged requests. The key policy explicitly grants the writer `GenerateDataKey` and `Decrypt` and the recovery role `Decrypt`, restricted to the exact nonsecret `purpose` and `run_id` encryption-context pairs. A synthetic in-memory access test assumed each role from the same SSO identity: the writer generated and resumed an AES-256 data key, recovery decrypted it, and a wrong context and recovery-role generation were denied. Temporary credentials and plaintext data-key material were not written to disk or printed.

The shared SSO identity is **not** independent recovery custody. No archive was written or restored, and no Woven deployment was changed. Separate recovery authority, account failure domains, retention enforcement, archive format, independent key recovery and full restore remain unverified. The key must remain enabled and must not be scheduled for deletion while the synthetic hold applies.

The local nonsecret creation request, intent, response and read-back files are in `/var/folders/x3/zy8gv4lj46g96_x4mg4_xkj00000gp/T/mapi-p1-kms-hizubxiu/`. The role and account metadata came from read-only STS and IAM calls; no credentials or plaintext key material are recorded here.
