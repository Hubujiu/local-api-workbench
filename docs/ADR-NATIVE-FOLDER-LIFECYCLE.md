# Bounded native inheritance folder lifecycle

Work in progress in PR43. This is Workbench-owned graph/trash metadata, not a
newly discovered Apipost folder-restore schema. Existing ordinary folder/document
recycling in PR21 is not reimplemented. No original runtime or license action.

## Representation

Keep every original graph folder, layer and HTTP binding. Optionally add
nativeInheritance.folderLifecycle={version:1,records:[{sourceId,batchId,state}]},
where state is recycled or restored. No default field is added to old projects.
A recycled record makes its complete descendant folder set inactive; all bound
HTTP requests remain in place with the referenced batch's exact deletedAt.
project.folders must equal the computed active graph paths. Restored records and
all apiResourceTrash batches remain as history. Later moves/recycles may change
active topology; restored history does not pretend to describe current ancestry.

Reuse the existing apiResourceTrash codec, 100 batches/10,000 resources/4 MiB,
and the existing graph 256 KiB/100 folders/1000 bindings/depth30 constraints.
Every lifecycle batch must exist, be a single-folder selection, contain no docs
or folder-setting values, and reference only this graph's bound HTTP IDs.
Active recycle records additionally require exact current subtree paths, request
membership and timestamps, with no overlap or duplicate active roots/batches.

## Owner operations

- recycle-folder accepts only type/sourceId; exactly one active graph root and
  all its descendants. Existing pending descendants or pre-deleted HTTP requests
  reject the whole operation. Empty folders are supported.
- restore-folder accepts only type/batchId; only the currently recycled batch
  may restore the complete subtree. Do not guess missing parents, overwrite live
  paths or restore any request independently from an inactive parent.
- The backend generates date and batch ID, computes a detached result and repeats
  the same operation/context under the existing revision/disk lock before one
  journalled save. No save-per-resource or automatic replay of uncertain commits.

Reuse deleteAPIResources with the original project, not by stripping guards.
Keep its protocol-source, ambiguous resource and unknown folder-setting checks;
add explicit refusal of any document in the subtree. First batch does not handle
mixed roots/HTTP selections or protocol/doc deletion. Native MCP accepts one
folder:<path> target only after existing confirm/write/project/archive checks;
resolve its unique stored source ID, then invoke the owner. Existing single HTTP
recycle/restore remains unchanged except that inactive descendants cannot restore
or move independently. No new native MCP restore tool is invented.

## Editing, movement and history

Ordinary saves cannot alter lifecycle records or their referenced trash batches.
While recycled, complete folder layers and bound request definitions are immutable.
Other active values remain editable. Block moving an inactive folder, its active
ancestor, or a request/directory into an inactive parent. Keep reserved paths and
IDs; allow disjoint active sibling moves when existing graph validation succeeds.
Restored history remains immutable but does not block legitimate later active
moves/value edits. Frozen cases/plans and execution history are never rewritten.

Live/list/detail/cURL use stored state and refuse inactive resources; exact prior
frozen snapshots still execute. Full backup/restore retains metadata and no MCP
grants. Native definition exports reject lifecycle metadata, including recycled
empty folders and retained historical batches, rather than silently discarding it.

This change does not add a cancellation protocol for structural owner mutations.
Existing entrypoint/lock cancellation behavior must be preserved in integration;
never equate client disconnect with rollback. Unknown save outcomes require read/
reconciliation, not request replay. No security/budget/grant widening or frontend.

## Acceptance

Model negatives (malformed graph/batch/date, stale identity, overlap, scope,
capacity, partial restore, ordinary-edit tampering) and complete owner/native SDK
workflows with real HTTP. Import preserve graph; freeze; recycle; fail live work
without I/O; retain sibling/foreign/source data; execute old frozen data; change
active ancestor values; backup/restart/regrant; restore whole batch; verify live
uses current ancestors and frozen keeps old values; recycle again preserving
history. Cover empty folders, conflicts/save failures, explicit scope refusals
and both native export rejections. Current feature/root CI and packages are gates.
