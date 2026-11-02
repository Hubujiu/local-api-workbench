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

## Creation lifecycle and custom-directory registration

Creation now runs under the registry lock followed by the project lock, with the
same write queue and journaled save core as updates. It exclusively reserves a
new generated-ID directory; an existing directory, legacy file, or registered ID
is a collision, never a destination to overwrite. The registry recovery guard is
checked inside that locked operation, including concurrent creation failures.

A versioned `.creations.json` intent records the generated ID and absolute base
before project journaling. `.locations.json` keeps its existing ID-to-base format
and is published only after the project is committed or recoverable. Readers
wait for active creation rather than observing a registered-but-missing project.
On restart, intent reconciliation uses the same lock order and ENOENT-only
filesystem checks. A journal, manifest, or legacy project is retained and made
discoverable. A markerless, never-registered intent can be retired; no project
folder, temporary project file, or user data is deleted. A matching published
registration is never erased merely because its files have become unavailable.
Malformed/conflicting registry structure fails closed.

Pre-journal failures with proven absence remain ordinary definite errors. If
commit evidence exists or cannot be determined safely, creation retains recovery
identity and uses PROJECT_COMMIT_UNCERTAIN. Post-commit publication, readback,
project-lock cleanup and registry-lock cleanup failures have the same uncertain
outcome. An intent remains durable when registration publication fails. Registry
reload resets absent maps instead of reusing stale per-Store locations.

An unavailable pending custom disk or unknown project lock is isolated as an
unresolved listing entry; it does not prevent startup or access to healthy
projects. Creation still fails closed with PROJECT_RECOVERY_REQUIRED. Existing
unknown-lock ownership safeguards are unchanged. Retrying initialization does not
retry the project mutation, delete locks, modify permissions, or discard data.
This remains process-crash recovery, not a power-loss durability guarantee or a
general idempotency protocol. Unregistered legacy ghosts without a creation
intent are not automatically repaired.

Bounded real-filesystem tests exercise owner POST permission failure, pre-journal
failure after intent publication, custom/explicit-root success, fixed concurrent
Store interleavings, post-journal failure, registry publication/cleanup failures,
collisions, structural corruption, isolation, and real child-process interruption
before journaling, with a journal, and after manifest application. Permission
fixtures run only where POSIX permission bits are effective; all other creation
fixtures also run on Windows. Tests preserve user sentinel files throughout.

## Restore execution-record identity

New backup restores validate nonempty string record IDs and shared uniqueness
across API `history` and flow `runs` before any write. Validation covers the whole
input, including records beyond the existing first-50 retention limit. A restore
must not report success for evidence that the shared execution-result lookup
cannot address unambiguously. IDs are opaque: no trimming, normalization,
regeneration, merging, or deduplication occurs. Correlation `runId` fields are not
record identities; protocol history and different projects remain separate
namespaces. Legacy optional source/timing fields remain optional.

This restriction applies only to new restores. Existing ambiguous disk evidence
remains inspectable; its existing detail-lookup ambiguity error stays unchanged,
and no global Store migration or project-read rejection is introduced. Tests use
actual API and plan execution, owner export/restore, restart, official SDK HTTP
and stdio detail readback, invalid-input byte-for-byte disk preservation, and
unchanged peer call counts. The pre-fix reproduction returned 201, persisted two
same-ID entries across restart, and listed both through the SDK while detail
retrieval failed as ambiguous. These are functional tests, not script workloads.

## Missing files are not permission to create

`Store.save(project)` is update-only. Under the project lock it must read the
existing project successfully before checking revisions/fingerprints, merging
latest execution history, or writing a new journal. Missing required children,
a missing manifest, and a completely missing project all fail before the new
write; none reset revisions or silently reconstruct a stale snapshot. Other read
errors also propagate. Intentionally optional history/runs/protocol-history and
parameter-dictionary files retain their existing read defaults.

New identities use `Store.create(name, directory)` or `Store.restore(document)`.
Restore retains `restoreProject`'s backup validation, normalization and generated
ID, but discards source revision/configuration/fingerprint ownership metadata and
uses the same exclusive directory reservation, registry guard and creation intent
as ordinary creation. First revision/configuration revision are both 1. Direct
callers that previously used `save(restoreProject(document))` must use `restore`;
ordinary HTTP/MCP updates cannot select this creation path. This changes no MCP
grant or credential policy.

A split directory containing resource files, a manifest, or a published journal
is authoritative: a missing manifest must not select the retained legacy backup.
An empty directory or one containing only unpublished journal temporary files
may still use an intact legacy JSON source, because a failed migration can create
that layout before publishing its journal. Legacy-only projects still migrate
normally and their original JSON bytes are preserved. If an entire split
directory is removed and an intact legacy file remains, there is no on-disk
migration marker to distinguish that from a legacy-only project; the legacy read
contract remains, and stale post-migration saves still face revision/fingerprint
checks. This patch adds no migration marker or automatic repair/deletion.

Published transactions still roll forward through `recoverProject` before reads;
this is recovery of the already journaled snapshot, not a new save from stale
memory. Missing files without an intact journal are not automatically recoverable.
