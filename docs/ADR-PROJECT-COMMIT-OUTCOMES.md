# Project commit outcomes

The split-file store is journaled: the complete transaction is written before
individual resource files. Recovery rolls it forward under the existing lock.
This is crash recovery, not guaranteed power-loss durability.

Validate collection shapes, duplicate IDs and filenames before publishing the
journal. Invalid layouts must not poison future recovery. Optimistic revision and
fingerprint conflicts still fail before write, without an uncertain-outcome code.

Once a journal has been successfully published, an apply/cleanup failure is
PROJECT_COMMIT_UNCERTAIN, with project_id, commit_outcome: unknown and
retry_safe: false in HTTP/MCP errors. Post-write readback and lock cleanup failures
have the same public outcome. Raw filesystem causes/paths/stacks are not exposed
by this typed error. No mutation is automatically retried because of this code.
A failed project creation includes its generated ID so the owner can recover/read
that project instead of blindly creating another. This error does not grant MCP
access to an otherwise unauthorized project.

Read recovery is idempotent; after the filesystem obstruction is fixed, it may
complete an earlier failed call. Therefore an error is not a rollback guarantee.
Only preflight validation rejection is asserted to leave the saved project
unchanged. Existing unknown-lock ownership safeguards remain; no chmod,
permission bypass or lock stealing was added.

Real temporary filesystem fixtures cover invalid layouts, failure before journal
publication, journal-success/apply-failure, repeated recovery, stale save rejection,
HTTP failed-create identity, MCP uncertain sync and lock-cleanup failure after the
commit. No production fault-injection switch or filesystem mock is introduced.

Creation fails closed with PROJECT_RECOVERY_REQUIRED when existing projects are
unreadable/unrecovered. This backend guard prevents default-project initialization
or a blind retry from creating another project while the earlier transaction is
still blocked. It does not grant access, delete damaged data or override locks.
The caller must resolve/read the existing project first; valid explicit creation
can then proceed. Partial-apply fixtures verify an updated API beside an old
manifest, followed by recovery at the original journal revision.

This guard is not a general create-idempotency mechanism or concurrent-create
deduplicator: once recovery succeeds, a separately requested create can make a
new ID. Creation also conservatively blocks on an unrelated unreadable/archived
project and can wait for its existing lock. Error propagation preserves a primary
recovery/commit failure even if subsequent lock cleanup also fails.

MCP recovery-guard errors filter project_ids through that dispatch's allowed
projects. A caller can learn that recovery is required, but cannot enumerate IDs
of unrelated damaged projects. The local-token HTTP owner retains recovery IDs.

## Portable record-ID layout validation

Malformed UTF-16 record IDs previously collapsed to replacement-character UTF-8 names, allowing two records to overwrite the same file. A 154-byte ASCII ID also passed the logical 200-character limit but exceeded the filesystem's 255-byte component limit once the atomic-write suffix was appended; this could publish a journal that recovery could never apply.

Layout validation now rejects malformed Unicode, encoded filenames whose complete temporary component exceeds 255 bytes, and case-folded filename collisions before publishing a transaction. Existing filename encoding is unchanged; no records are silently renamed or truncated. Well-formed long IDs exceeding this stricter disk limit are rejected with an ordinary precommit error. Safe 153-byte ASCII and distinct Unicode IDs have disk save/read/restore tests; invalid saves and HTTP restore preserve the old revision/list and publish no journal.

This prevents new corrupt layouts. It does not repair already overwritten records or automatically discard a pre-existing invalid journal; such data requires explicit recovery from a known intact backup. The limits are per filename component, not a promise that every possible full filesystem path is writable.
