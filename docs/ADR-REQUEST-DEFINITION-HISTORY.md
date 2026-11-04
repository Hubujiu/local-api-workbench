# API definition history and restore (WIP)

## Fixed dependency and first checkpoint

This independent backend module starts at the reviewed integration commit
`8f42653300e25cad795c51dcb4d7f755e5148f34`, tree
`d42d96193a697f16d26f8756032a4aaf10ddb4d7`. It does not accumulate unrelated
features into this PR, modify the frontend, merge main, or deploy.

The first checkpoint adds only the pure history model and required-file/journal
storage contract. Store capture, owner routes, MCP permissions/cancellation,
backup identity rebinding and end-to-end acceptance remain unfinished. It is
not a usable history feature or a completed delivery candidate.

Five real temporary-directory file contracts ran against the unchanged base:
three failed (no required-file marker, accepting another project's history,
and applying an invalid history journal) and two existing behaviors passed.
After the file-layer implementation the five passed. The separate pure model
suite initially passed 22 cases; three added review regressions currently fail
(legacy read budget, Unicode request IDs and lifecycle metadata in a snapshot).
These known checkpoint defects are being fixed, not hidden or counted as passes.
The initial 22 passes are not claimed as a behavioral RED. Store, owner HTTP
and official-SDK workflows have not run locally because
the fixed application dependencies are unavailable. No dependency installation
or original application execution was attempted for this feature.

## Evidence and intended module

Read-only analysis of the official Offline2 2.0.0 package established a visible
renderer-to-fileDB contract: a normal existing-API save retains the preceding
definition, keeps up to 100 old versions per API, and exposes list/detail/tag
and content restoration through the ordinary save path. The package SHA-256 is
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`.
The readable work bundle SHA-256 is
`20bb6e21fd678ead16bd91807dc9623b8cd3e7019d44ac874a167c31a37f39fb`.
No proprietary implementation is copied. The fileDB bytecode's locking,
atomicity, path validation and crash behavior remain unproven.

Workbench execution history, project revision, frozen plans and resource trash
are separate capabilities. They are not an API definition version store.

## Storage and invariants

- `requestDefinitionHistory` is server-owned, versioned project data, bound to
  the current project and per-request lineage. Hard removal/recreation starts a
  different lineage; a retained soft-deleted request keeps its identity.
- Up to 100 old definitions plus a separately synthesized current version are
  available per lineage. A persistent version high-water mark survives trimming
  and explicit clearing. Current/old tags are metadata, not execution authority.
- Workbench records material definition changes, including successful import or
  synchronization updates. This deliberately differs from the original normal
  single-item save, which snapshots even an unchanged definition; its batch
  importer uses a different write path. Lifecycle-only `deletedAt` changes do
  not create a content version.
- A declared `requestDefinitionHistoryFormat: 1` manifest requires
  `history/definitions.json`. A legacy manifest without the marker remains
  readable without creating files or random history identities. Missing or
  malformed declared history fails closed.
- History and the new current definition share the existing complete project
  journal and lock. Recovery validates history before applying any journal
  bytes. This is process-interruption roll-forward, not a power-loss or rollback
  guarantee.
- Individual snapshots and total history are bounded. Final configuration must
  remain transportable in the existing 12 MiB compact backup restore envelope;
  full input is validated before retention. No silent truncation of malformed
  data, legal JSON Schema keys, unsupported metadata, or privileges is allowed.
- Ordinary clients cannot forge, replace or delete the history field. Activity
  saves cannot edit definitions/history. Explicit restore/tag/clear operations
  require current configuration revision and exact resource lineage.
- Restoration uses current request validation, directory/inheritance/trash and
  collection identity rules. It does not revive deleted resources, grant access,
  execute scripts or requests, or replay stored execution effects. It archives
  the replaced definition through the normal configuration commit.
- Full backup restoration receives a new project identity and rebinds the
  history owner. Historical snapshots remain inert data. They may contain old
  static credentials, so export and authorized reads are private data operations,
  not globally redacted output.

## Required remaining acceptance

Complete Store integration, 100-version/byte bounds, cross-process stale writes,
hard-delete ID reuse, explicit clear, metadata-only tagging, backup/restart,
missing files and crash recovery. Exercise owner HTTP and official SDK HTTP and
stdio with project scopes, write grants, cancellation and revocation before the
lock-held commit gate. Preserve execution history and frozen in-flight plans;
prove no replay with real loopback counters. Bind all results to the final tree.
The original definition-history directory is not thereby added to the native
directory importer, and native definition export is not a full backup.
