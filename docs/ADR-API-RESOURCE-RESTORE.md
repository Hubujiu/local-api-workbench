# Whole-batch ordinary resource restore (work in progress)

This continues PR21's existing ordinary HTTP/document/folder recycling, not a
replacement deletion implementation or a newly discovered native restore format.
Its fixed MCP dependency is PR16 head d87da10d0be32912b4e9bc36f5f62340b6221666.
The separately validated native-inheritance graph restore remains authoritative
for graph projects; this ordinary operation refuses them and archived projects.

## Explicit owner operation and state

POST `/api/projects/:id/api-resource-restore` accepts only
`{configRevision,batchId}` and no query/extra path. The owner chooses an existing
batch, not replacement bodies, a partial member set, timestamps or grants.
The Store generates one ISO restoredAt, computes a detached candidate, then under
its normal disk lock recomputes that same operation against current state before
one journaled save. Existing revision/fingerprint checks run before identity
comparison so stale activity appends retain their existing conflict retry path.
Restoration cannot masquerade as an activity-only update. No resource is executed
and no intermediate per-document save occurs.

The v1 trash codec accepts an optional restoredAt. Missing means no recorded
whole-batch restore, not an inferred migration status. Full batch snapshots stay
in history. A document ID is unique within each batch and among pending document
tombstones. Restored document snapshots may share IDs with later same-kind
versions or active documents. They need not match later edited content.
Current/historical cross-entity-type ID conflicts remain prohibited. The existing
100-batch, 10,000-resource, 4 MiB and document/folder limits remain unchanged;
adding restoredAt also consumes that existing budget.

Previously stored batches are an immutable prefix during ordinary saves: no
edit, removal or reorder; ordinary deletion can append an un-restored batch.
Only the explicit owner operation may add restoredAt to an existing batch.
New-project backup imports have no prior history to authenticate and validate
structural consistency only; this is not tamper-evident storage against an owner
who edits files outside the API. This slice does not add a purge operation or
increase capacity to make room for restore history.

## Conflicts, preservation and compatibility

Before mutation, every HTTP ID must still exist exactly once with the batch's
original deletedAt, and this must be its most recent batch association. This last
check avoids restoring a later deletion that happened in the same millisecond.
Legacy ordinary PUT single-HTTP restore/re-delete remains supported. If any batch
member has already been independently restored/recycled/removed, whole-batch
restore refuses atomically rather than guessing or silently restoring a subset.

Old batches store HTTP IDs, not HTTP deletion-time definition snapshots. Restore
therefore activates the currently retained HTTP definitions, not an invented
older copy. Documents restore their actual retained full snapshots, with no alias
to the history. Restored documents append in their batch-relative order; their
original absolute positions among later edited documents cannot be reconstructed
from the old codec and are not claimed. A stored snapshot with truthy deletedAt
cannot be restored as an active document; the old historical codec is not rewritten.

Restore only original explicit folder declarations and captured entries of the
four known folder-setting maps. Never overwrite a current setting slot, an active
selected subtree or an occupied document ID. Unaffected active ancestor paths may
be shared but must still exist; missing parents are not invented. Selected folder
roots must cover all implicit members/paths; explicitly selected HTTP/documents
may belong to another existing folder. Keep all original protocol-source,
unlocated protocol and unknown folder-setting isolation checks.

Frozen cases/plans, execution history, unrelated resources, project settings and
other project IDs cannot be smuggled into a restore. Full-project comparison is
descriptor-safe, preserves real unknown fields, treats own undefined object data
as its persisted omission, and ignores only Store-owned revision/configRevision/
updatedAt/fingerprint. Legal JSON Schema literal keys remain data, never prototype
changes. Normal saves compare only trash rather than imposing new restrictions on
unrelated activity payloads. Generic trash validation now also runs on current and
legacy reads, including after reopening; malformed target history fails closed.

## Acceptance still required

Pure model coverage is not owner or persistence acceptance. The complete batch
includes actual MCP deletion, owner restore, real HTTP inheritance of recovered
parameter/auth/script settings, document edit/delete/restore again, immutable
history, old HTTP PUT compatibility, complete backup/new-project isolation,
restart/temporary-grant boundaries, negative whole-project/disk/revision equality,
two independent Store races and malformed-trash/healthy-project isolation.
Root composition separately retains typed uncertain-commit/cancellation rules;
never treat a disconnected response as rollback or replay an unknown mutation.
No application/VM tests are run locally; ordinary CI supplies Workbench
application acceptance results. The original application is never executed. No frontend, original code reuse, new license,
main/develop merge or deployment is included.
