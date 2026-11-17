# API definition history and restore (WIP)

## Large-definition compatibility correction (WIP, 2026-11-04)

Feature head `250a2b0c81e72a60057435d46eb75ad46d28332a`, tree
`38cd3f267b9649ae63e52e21d61dd8de0f01fbf8`, passed exact
[CI 41798142616](https://github.com/Hubujiu/local-api-workbench/actions/runs/41798142616)
with all 25 jobs. Subsequent composition review nevertheless found a real
compatibility defect: its new 1 MiB current/snapshot gate and 12 MiB whole-project
save gate rejected previously admissible large raw definitions. A green run did
not cover that boundary. The correction below is new WIP and needs its own CI.

The limits below are Workbench implementation quotas, not original Apipost facts.
Ordinary owner input remains 12 MiB. Current definitions are not pre-admitted
against a history snapshot quota, and project persistence is not capped by the
restore HTTP envelope. Complete encoded historical records have a 16 MiB limit;
all definition history, including metadata, has a 32 MiB charged project quota.
The owner identifier is validated as the existing ASCII ID of at most 200
characters and charged as one fixed ASCII character; the actual envelope is
also bounded to 32 MiB plus 199 bytes. This bounded identity allowance preserves
an already-valid exact-limit short-ID backup when restoration creates a longer
UUID, without deleting versions or changing available content capacity when IDs
change length. Store prechecks and owned-history comparison use the same real
envelope limit. Reaching
that byte quota rejects the whole change before journal publication, preserving
the previous definition and history. Export the complete project first, then
explicitly clear selected versions through the definition-history endpoint/tool
before retrying. No byte-limit eviction or silent truncation occurs. Separately,
the established count-retention rule keeps the latest 100 old versions plus
current; the oldest is removed when recording the 101st old version.

Normal owner project and result.project responses omit the server-owned history
field so existing configuration PUTs do not resend an ever-growing archive. The
Store preserves omitted history, still checks revision/fingerprint and captures
real client definition edits. Dedicated history endpoints retain scoped access,
and explicit project backup export includes all history. Only owner POST
/api/restore accepts up to 64 MiB; every normal endpoint retains its old limit.
The existing GUI parses a selected backup JSON text into an object before that
request, avoiding a second round of string escaping. This is a transport fix,
not a new history screen or visual feature. Legacy string backups are still
accepted within the same 64 MiB wire bound. An existing project or execution
archive above that bound is not guaranteed to round-trip; no oversized backup
may be silently truncated or partially registered.

The fixed lockfile was installed using npm ci --ignore-scripts, with the same
registry.npmjs.org package integrity and no version/lock changes. This combined
workspace installed the identical lockfile offline from that verified cache.
Actual application tests are now enabled. The separate feature's first quota
batch had 25 passes and one obsolete 12 MiB configuration rejection assertion;
that test now checks successful config/evidence/history preservation and fresh
backup identity instead. Combined-tree acceptance is still pending, and no
original application, main merge or deployment is involved.

## Independent raw-media integration candidate

This candidate applies only the PR97 feature delta from its fixed 8f426533 base
onto public `81398a4fc23df5409e27b2aa12d2a72ae322d1c2`, tree
`3b7b205e0a8fc204afdafbb8e12dd1caea4bfd3f`. The initial saved WIP was public
`731ee9e7349d74cf8ea6b8c10faa3e0f96543ecd`, tree
`bb1c6eec45aa6ef397e87640a6558c665a105588`. Its large-current admission defect
is preserved as a historical checkpoint, not declared compatible.

Only additive imports conflict between raw-media and history production code.
Both raw-policy normalization and history lossless normalization remain; root
media/signing, controller/generation, IF/repeat, native-write authorization and
cancellation paths are retained. New composition tests cover real raw/OAuth wire,
restoration without replay, official SDK queued cancellation/revocation, peer
isolation, 2 MiB/exact 8 MiB import/edit/backup/restart, and retained export refusal.
A separate pure/real-files regression observed 3 REDs for the old current/history
budget; the later correction must turn those exact contracts green.

The fixed lockfile was installed with npm ci --ignore-scripts, without substitute
packages, in the feature workspace. App tests are now being attempted for the
first time locally; no completed result is implied here. This combined tree still
requires its own exact testing and CI, not the isolated feature's older green.

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
- Complete encoded historical records are at most 16 MiB, total history at
  most 32 MiB, with at most 10,000 lineage records. These are independent storage
  quotas, not a cap on current definitions or the whole project. Full input is
  validated before the explicit latest-100 retention rule; byte-quota failures
  reject rather than silently evict. No truncation of malformed data, legal JSON
  Schema keys, unsupported metadata, or privileges is allowed.
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
Ordinary no-op saves do not create versions. Current definitions retain their
existing request/input limits rather than a new future-snapshot admission gate.
An edit/deletion that cannot fit the encoded old version or project history
quota fails atomically with an explicit export/clear path, without silently
losing the prior state. Reads and activity saves remain independent of the
backup envelope. The 16/32 MiB storage quotas and 64 MiB owner backup transport
are bounded, not promises of arbitrary-size backups or unlimited retention.

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

A subsequent review corrected the Store fault fixture: damaging `apis/` before
`Store.save` makes the lock-held read fail with `ENOTDIR`, not an uncertain
published commit. The corrected test wraps the actual builtin journal rename,
waits for publication, then injects a real temporary-directory failure before
apply. A separate stdlib file test executes this same barrier and recovery;
Store remains unexecuted locally. This is a test correction, not a production
change or weakening of the uncertain-outcome assertion.

Exact CI on `b20a232` found three existing scope-commit fault contracts failing
at the physical environment-file assertion, before their repair/recovery step.
The new definition-history write had been placed before the established
collection/environment apply sequence, so a deliberately obstructed history
directory failed earlier than before. The journal still contained the correct
new variables and reported unknown outcome. The fix moves only the definitions
file write after the existing files and before the final manifest. A matching
real-files regression first reproduced old-versus-new scope bytes (RED), then
passed with exact roll-forward/idempotence; the original assertions remain
unchanged. Local application cases still require exact CI.

The SDK cancellation fixtures additionally start the real Store.save while a
real project file lock is held, then cancel/revoke before releasing that lock.
They assert the genuine later `STORE_SAVE_ABORTED` result and wait for cleanup.
The explicit `remember: false` revocation uses the existing immediate reduction
path; it is not a change to persistent grant-update semantics.

## Complete first-CI failure reconciliation

Run `41795840617` on `b20a232` finished with 9 successful and 16 failed jobs.
All failed job logs were checked: the three OSes share 15 failed test cases,
plus one Windows-only wait-cancellation case. They reduce to six causes:

1. Eleven existing unknown-outcome cases observed an earlier partial-apply
   boundary (resource restore, Header/variables/Text/XML scope commits, native
   folder recycle/restore, and four HTTP/stdio import combinations). Only the
   new definitions-file write order changes; their existing assertions stay.
2. A real compatibility regression applied history depth/node limits to saved
   environment data. A separate iterative, descriptor-safe compact-envelope
   byte counter now keeps the 12 MiB transport bound without imposing history
   structure limits on unrelated project data. History/snapshot limits remain.
3. Original layout-ID validation now retains its earlier diagnostic priority;
   history validation still runs before any journal publication or recovery.
4. The old stdio cancellation fixture removed a now-required definitions file
   before Store read. Its actual-child preload now injects the same disk fault
   only after publishing the real cancelled-run journal. Missing declared
   history still fails closed; no defaulting or original assertions are relaxed.
5. The new stdio fixture's sparse peer API acquired valid defaults during backup
   normalization. Both seed definitions now use the normal request normalizer;
   full deep comparisons and isolation/no-replay assertions remain unchanged.
6. The Windows wait test prepared an unrelated project/plan after receiving
   `wait-active`, consuming part of the 1000 ms wait before cancellation. That
   preparation now precedes the target run. Ready-to-cancel performs no awaited
   disk preparation, observes the target is still unsettled, and preserves the
   original 1000 ms wait, 800 ms cancellation bound, real HTTP and scope checks.
   The prior log alone does not establish a platform scheduling root cause.

These are a mixture of production compatibility fixes and fixture corrections,
not ignored CI flakes. Pure/file regressions execute locally; the corresponding
application and SDK paths still need the exact next published-tree CI. No full
run is reused as evidence for a different tree.

## Identity-boundary and editable-view follow-up

Independent review reproduced a valid exact-32-MiB short-owner backup failing
after UUID rebinding added 35 bytes. The bounded identity charging rule above
corrects that defect while retaining the complete history and per-record quota.
A real Store regression covers restore, reopened state, ordinary owned-history
comparison, activity persistence and an over-capacity tag rejected unchanged.
The previous owner-view projection also exposed five old tests comparing an
editable HTTP response with a complete Store object. Their baselines are now
captured from the actual Store at the relevant pre-action point; complete deep
comparisons still include history. No production access or recovery assertion
is removed. The previous c35 CI run finished with 16 successful and 9 failed
jobs (the same five cases on each OS), and remains a failed historical run.
