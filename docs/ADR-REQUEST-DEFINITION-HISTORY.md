# API definition history and restore (WIP)

## Fixed dependency and first checkpoint

This independent backend module starts at the reviewed integration commit
`8f42653300e25cad795c51dcb4d7f755e5148f34`, tree
`d42d96193a697f16d26f8756032a4aaf10ddb4d7`. It does not accumulate unrelated
features into this PR, modify the frontend, merge main, or deploy.

The first checkpoint added only the pure history model and required-file/journal
storage contract. Store capture, owner routes, MCP permissions/cancellation,
backup identity rebinding and end-to-end acceptance were unfinished there. That checkpoint is
not a usable history feature or a completed delivery candidate.

Five real temporary-directory file contracts ran against the unchanged base:
three failed (no required-file marker, accepting another project's history,
and applying an invalid history journal) and two existing behaviors passed.
After the file-layer implementation the five passed. The separate pure model
suite initially passed 22 cases; three added review regressions failed at that checkpoint
(legacy read budget, Unicode request IDs and lifecycle metadata in a snapshot).
Those three known checkpoint defects were retained in the first published tree,
then fixed in a second checkpoint with 31/31 model/file tests passing.
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
  guarantee. Cancellation is checked immediately before beginning the atomic
  journal rename. Once publication begins, interruption cannot promise rollback;
  existing `PROJECT_COMMIT_UNCERTAIN` recovery semantics still apply.
- Individual snapshots are at most 1 MiB, total history at most 8 MiB, and
  there are at most 10,000 lineage records. A configuration/history commit must
  fit the existing 12 MiB **compact object** `{document: project}` restore body;
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
  not globally redacted output. The existing `history/` Git ignore remains in
  effect: a Git-only directory copy is not a complete backup. Do not publish
  credential-bearing definition history to make that copy work.

## Required remaining acceptance

Complete Store integration, 100-version/byte bounds, cross-process stale writes,
hard-delete ID reuse, explicit clear, metadata-only tagging, backup/restart,
missing files and crash recovery. Exercise owner HTTP and official SDK HTTP and
stdio with project scopes, write grants, cancellation and revocation before the
lock-held commit gate. Preserve execution history and frozen in-flight plans;
prove no replay with real loopback counters. Bind all results to the final tree.
The original definition-history directory is not thereby added to the native
directory importer, and native definition export is not a full backup.

## Transport and compatibility boundaries

Owner routes are `GET /api/projects/:id/definition-history`,
`GET /api/projects/:id/definition-history/version`, and `POST` to the first
route. Mutations require the current `configRevision`, `requestId`, exact
`lineageId`, and the relevant version/metadata. Clear additionally requires
`confirm: true`, and never removes the current definition. Retired lineages
are separately discoverable through bounded pagination; a reused API ID is
not permission to restore an earlier generation.

MCP exposes five `localapi_*` tools for list, detail, tag, restore and clear.
Reads require current project scope; writes additionally require a write grant.
HTTP/stdio mutation requests participate in cancellation/session ownership but
are not executions and do not create execution activity or replay requests.
The existing stdio entrypoint is `src/mcp.mjs`; no separate CLI subcommand or
frontend history screen is added.

History changes use current validators. An old definition incompatible with
current folder/collection/native identity constraints is rejected explicitly,
not partially restored. Explicit restoration to an identical old definition
still archives the current value and advances the persistent version number.
Ordinary no-op saves do not create versions. New/current edited definitions
must remain snapshotable within the feature's budget. Oversize legacy current
values can remain unchanged, but an edit/deletion requiring an oversized old
snapshot is rejected rather than silently discarding that history.

The compact-object restore bound is not a promise that the existing GUI's
pretty-printed JSON **string** upload has the same size: quoting that string
adds escaping and whitespace. Later execution evidence may also grow beyond
12 MiB under the existing execution rules. Activity saves and history reads
must not acquire a new whole-project budget because of this feature; such
oversize restore bodies remain explicitly rejected by the existing endpoint.
This PR does not redesign large-backup transport or execution retention.

## Current implementation checkpoint

Store capture, controlled history mutations, backup owner rebinding, owner and
MCP transport code are now added as a WIP candidate. The production Store
suite, owner and official SDK workflows are written but **not locally
executed**: module loading fails on unavailable fixed dependencies (including
`postman-url-encoder` and the MCP SDK; the unavailable locked `node-oauth1`
package is not substituted). No install or alternate dependency version is
used to claim a pass. Exact CI on the published candidate is still required.

Real stdlib-only file tests cover prepared-journal cancellation, post-publication
uncertainty, two concurrent Node processes using the existing filesystem lock,
and a child exiting with a published journal and held lock before restart
roll-forward. These prove the file/lock path, not that unexecuted Store or SDK
cases passed. Historical red and blocked outputs remain recorded separately.

At the Store/transport checkpoint, 38 pure-model tests and 9 real file/lock/
process tests passed locally (47 total, no skipped tests). The 13 Store cases
and application transport/SDK cases remain 0-executed due to module-load
failures, not behavioral passes. MCP history results are explicitly limited to
2 MiB of JSON; an oversized current definition returns a tool error instead of
silently exceeding the stdio frame budget.
