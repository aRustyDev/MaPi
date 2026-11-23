# Relocation table-name validation

A native SQLite test showed that `beginChunkExport` accepted the table name `MAPI_CHUNK_EXPORT`: the validator compared JavaScript strings case-sensitively, but SQLite resolved that name to the control table it had just created. This establishes a helper-level defect with synthetic state; it does not establish that the live owner's separately constructed table manifest can contain that name or that any deployed project was affected.

`validateTables` in `worker/relocation-chunks.js` now folds ASCII case, matching SQLite's identifier behavior for the reserved names and duplicate detection. It rejects case-varied `mapi_chunk_*` and `mapi_relocation_*` control names and aliases that identify the same table. This does not change or test the separately accepted application owner-fence metadata-detection limitation.

`node scripts/test-relocation-control-table-names.mjs` passed on native SQLite for mixed-case control names and duplicates on both export and import, followed by successful normal setup. A disposable local Workerd run of `node scripts/test-relocation-credentials-workerd.mjs` passed the same admission checks and its existing small two-project transfer, rollback, replay and mutable-envelope checks. The Workerd run used relocation-chunks.js SHA-256 `0770b12861a94aeeb50c0a0e8ac1f5ec4ee36473c62a12aa33098ad465afb664`.

These results do not establish all possible reserved table names or triggers, actual owner-manifest reachability, representative scale, complete history, restart, the previously deferred boundary tests, hosted behavior, or cutover safety. No Woven deployment or AWS resource was changed.

## Control-table trigger target

A separate native test showed that SQLite records a trigger declared on `MAPI_CHUNK_IMPORT` using that spelling in `sqlite_schema.tbl_name`. The original case-sensitive trigger lookup missed it, and a synthetic chunk import ran the trigger's marker write. `validateControlSchema` now compares trigger and index targets with `COLLATE NOCASE`. The distinct `node scripts/test-relocation-control-trigger-case.mjs` regression passed: the import rejects the trigger with the business table, marker and checkpoint unchanged, then succeeds after its removal. The updated disposable Workerd credential-transfer test passed the same case and its existing admission, mutable-envelope, rollback, replay and isolation checks. The latter run used `worker/relocation-chunks.js` SHA-256 `5335faa025b4148a6f5980fe183cee8fed4514069838253ff6585e8c3c02e693`.

This is a main-schema helper check, not evidence that the real owner contains such a trigger or that its manifest permits one. TEMP or attached schema, other unenumerated control names, independent history, real-owner and hosted behavior are not established; the previously accepted application owner-fence detection issue is unchanged.
