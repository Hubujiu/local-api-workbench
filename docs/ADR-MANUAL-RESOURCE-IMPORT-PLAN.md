# Manual resource import plan (WIP)

## Fixed dependency and checkpoint status

The feature starts from PR97 public commit
`250a2b0c81e72a60057435d46eb75ad46d28332a`, tree
`38cd3f267b9649ae63e52e21d61dd8de0f01fbf8`. The isolated local equivalent is
`9f67319d11826d0609e7dcc33a069fd943f55ed5`. The immutable dependency branch is
`deps/manual-resource-import-base`; only this module belongs in the feature diff.
This does not declare that dependency final: any later PR97 compatibility fix
must be integrated explicitly and tested, not copied into this feature.

This first checkpoint freezes the contract and adds actual owner workflow tests
before route implementation. It is not a usable or accepted feature. Existing
dependency CI does not validate this tree. Local application test startup may be
blocked by unavailable locked dependencies; missing-route RED, load failure,
unexecuted scenarios and passing helper tests are reported separately.

No frontend changes, original-application execution, proprietary code copying,
new production dependencies, JSON5 host parser, main/develop merge or deployment.
The existing bounded JSON/YAML parser remains the only text parser. A syntax
declaration requesting JSON5 is rejected, not silently advertised as supported.
Some JSON5-looking input may overlap YAML grammar; that is not JSON5 compliance.

## One complete backend module

The pipeline is bounded input -> existing conversion -> typed source graph ->
explicit selection and dependency closure -> conflict/identity plan -> preview ->
same-source/same-configuration atomic application. Owner HTTP and official MCP
HTTP/stdio use the same planner and Store operation. Existing one-step import,
OpenAPI automatic sync and native inheritance workflows retain their contracts.

### Public request/response shapes

- Owner `POST /api/projects/:id/import-preview`: the input below.
- Owner `POST /api/projects/:id/import-apply`: exactly `{token,input}`.
- MCP `localapi_preview_import`: exactly `{projectId,input}`, project read scope.
- MCP `localapi_apply_import`: exactly `{projectId,token,input}`, live write scope.

Input has only `format`, `document`, `selection`, optional `policies`, `folderMap`,
`bindings`, `options`, `clearScope`. Formats are `auto`, `apipost`,
`apipost-directory`, `openapi`; these select existing converters, not remote URLs
or host paths. Text uses the existing parser; directory input is the existing
bounded virtual-file envelope.

Selection is exactly `{mode:"all"}` or
`{mode:"explicit",keys:[...],exclude?:[...]}`. Omitted selection is invalid in
this new API. Explicit empty means no-op, never all. Resource keys come from the
preview catalogue and remain tied to that source digest. Ancestors do not imply
all descendants. Unknown/duplicate keys and excluded required dependencies fail.

Policies are: API `both|ignore|url|url_and_folder|clear`; samples `both|name`;
models `both|name`; environments `both`; documents `both`; globals `safe`.
Defaults are `both` and `safe`. `folderMap` maps source paths to explicit target
paths; `bindings` maps source keys to explicitly chosen compatible target IDs.
Options retain supported `modelNameMode` and `postmanVariableMode`. Native
preserve graph import remains a separate complete-graph operation, not a way to
escape this planner's guards. `clearScope:{folder:""|existingPath}` is mandatory
only for clear; empty selection with clear is invalid.

Preview returns version, configRevision, source/options/plan digests, expiresAt,
items, counts, noOp, warnings, blockers, and a token only when unblocked. Each
item has key/kind/action/dependencies and optional targetId/targetFolder/reason.
Actions are create/update/reuse/skip/block/trash. Counts use
created/updated/reused/skipped/trashed. No selected node may disappear without a
terminal action and explanation. Dependency additions identify their reason.
Summaries do not echo credentials, request bodies or variable values.

Apply returns only configRevision, revision, counts and noOp, not the whole
credential-bearing project. All input/output and complete MCP frame budgets are
validated before publication; a truncated preview cannot authorize undisplayed
changes. Initial preview output is bounded and complete, not cached pagination.

## Per-resource semantics and deliberate differences

The original application's readable callers prove the following matching
behavior, not its fileDB internals or runtime/crash correctness:

- API both creates identities; url matches method+literal URL; url_and_folder
  adds mapped parent; ignore matches method+URL. Overwrite retains target ID.
  Multiple matches, multiple sources claiming one target, or clear/binding target
  intersections block instead of taking first/last write wins.
- Non-both folders map by name+mapped parent. Original both can keep same-name
  sibling folder identities; ordinary Workbench folders are path identities.
  A colliding both folder therefore requires explicit noncolliding folderMap,
  rather than silently merging or claiming exact identity parity.
- Samples match name+mapped API+mapped parent group. Both creates fresh case and
  group identities. An ignored API cannot silently adopt new samples. A lone
  selected sample requires its API/ancestors or explicit compatible binding.
- Model name matching is proven, but original clear/ignore menu values do not
  have corresponding active implementations. This API rejects those modes.
  Workbench modelNameMode is name representation, not overwrite authorization.
  Ambiguous names and changes affecting unselected live consumers block.
- The original active environment UI forces both, with its own special default
  identity. Workbench uses explicit source/default server/environment bindings,
  does not silently overwrite or switch the active environment, and preserves
  current/initial values and descriptions.
- Modern globals, functions, attributes, statuses, services, credential-free DB
  rebind data, samples/cases and existing protocols are not removed just because
  the original manual UI omitted some of them. Safe merge creates missing data,
  reuses equal data and blocks conflicting data. No blanket settings overwrite.
- Existing supported protocol/flow/archive bundles remain atomic where finer
  selection cannot prove closure. Unsupported combinations explicitly block;
  the unchanged one-step import remains available. Nonempty automated_testings
  and unknown nonempty test_cases remain rejected under the existing contract.

### Clear and recovery

The bounded clear is HTTP/document **leaf** replacement inside the explicit
scope. Every incoming target must remain inside that scope. Old leaf IDs enter
the existing recoverable trash batch; newly imported definitions use new IDs.
Existing cases/plans, protocols, models, globals and history are not cascaded
away. Explicit folders/settings remain, and affected implicit folder shells are
materialized with that change shown in preview. Full trash fails before commit;
it is never silently pruned or bypassed.

Old leaf restoration can coexist with imported resources. That is not whole
import undo. Original recursive clear with skipTrash is intentionally not copied.
Whole-folder replacement plus atomic undo needs an additional bounded receipt
and revision/content guarded undo operation; it is not claimed by this feature.

## Closure and deterministic identities

Validate the complete source before selection so inheritance and referenced
definitions are not lost. Source keys include kind and source namespace; repeated
IDs or ambiguous graph ownership fail. Resolve structure ancestors, sample API
and groups, model transitive references, services/environments, and function or
global dependencies to a fixed point. Schema-reference cycles may be valid;
folder-parent cycles are not. Schema position rules preserve literal example,
default and extension data instead of replacing every string resembling a ref.

Dynamic script dependencies use a bounded conservative configuration bundle,
never script execution to discover references. If a user excludes a required
dependency, block rather than silently adding it back. Every live reference must
resolve to exactly one allowed kind and project, never a tombstone or history ID.
Validate reverse references before replacing shared resources.

The planner injects stable ID/time context. A random token nonce, source key and
domain-separated hash produce deterministic candidate IDs; all business times
use the fixed plan instant. No second randomization on apply. All IDs are checked
against active resources, retained identities and reserved namespaces.

## Stateless token and atomic Store boundary

The token is at most4KiB, lasts at most10 minutes, contains only fixed-size
digests/identity metadata/nonce and is HMAC-SHA256 signed with an ephemeral
process key. No preview file, persistent token table or unbounded plan cache.
Restart invalidates old tokens. Strict versions/purpose, canonical encoding,
finite ordinary JSON, nonce format, time bounds and timing-safe signatures apply.

Bindings include projectId, host-supplied session identity, configRevision,
configurationDigest, sourceDigest, optionsDigest and planDigest. Text source
digest binds the exact text string; object source digest binds canonical ordinary
JSON. Public source/configuration/plan digest fields are domain-separated keyed
HMAC commitments, not ordinary hashes that allow guessing low-entropy secrets.
Signing does not encrypt the readable token payload. Token/source data never
belong in query strings, diagnostic logs or reflected errors. Object key order
is irrelevant; array order, strings and URL spelling are not normalized.
Format/parser/planner versions are also part of the plan.

Owner binding is an app-instance epoch, not a claim of browser-tab isolation.
MCP uses a real session plus authorization epoch; stdio uses its process/session
epoch. These values are never request fields or raw authentication credentials.
Anonymous/sessionless MCP cannot use the new two-step tools. A token is not a
grant: current read/write scope and revocation are checked independently.

`Store.applyManualImport(projectId,{token,input},{sessionId,signal})` acquires the
same project lock, recovers a prior journal, rereads current data, verifies the
token and configuration, rebuilds the candidate, then uses the normal locked
Store commit. External edits without revision changes must be detected by the
configuration digest. Activity-only changes are preserved from current disk.
No stale preview copy replaces execution results.

Plan digest covers the business operation graph and relevant data, not newly
allocated Store history UUIDs, Store timestamps or revision/activity metadata.
Preview invokes the same PR97 reconciliation owner on a detached simulation to
show history/retention impact and enforce its budget; the importer never writes
its own history. PR97 may retain only100 old versions. Apply recalculates budget
with latest activity, so the same configRevision does not guarantee space remains.

Both tools join HTTP/stdio cancellable lease classification. Close, cancellation
and revocation must reach the final pre-journal-publication signal gate, not only
the route entry or lock acquisition. Before publication, failure has no import
commit. After publication, report ProjectCommitUncertain and never claim rollback
or automatically replay. Recovery rolls forward the same journal once.

One valid token can cause at most one changed configuration under CAS. No-op
does not manufacture revision/history/trash. There is no durable token-consumed
or response-receipt claim; network delivery can be uncertain. Same-token cross
process calls fail signature validation; lock races are tested with two Stores
in one host or independently valid tokens in two processes.

Preview on clean stable storage does not write. Store reads may finish a prior
journal recovery; those bytes belong to that earlier accepted transaction, not
the preview. Missing/corrupt source projects never become empty import targets.

## Required acceptance before feature completion

Actual RED/green evidence must cover helper boundaries, representative typed
multi-resource combinations, source/options/session tampering, empty selections,
ambiguous mappings, full transitive and reverse references, global conflicts,
clear sibling isolation and recovery, two-Store/process contention, activity
preservation, injected pre/post-journal faults, owner and official SDK HTTP/stdio
success/denial/revocation/cancellation, restart and new-identity backup restore.
Loopback side-effect counters stay zero during preview/apply/restore.

PR97 overwrite/history/lineage/retention and current/snapshot/project budgets are
composition gates, as are existing authentication/raw-body/protocol snapshots.
Unsupported history/trash definition exports must remain fail-closed. Tests and
actual portable-package dependencies/licenses bind the final exact tree on all
three systems. No old green run or helper-only pass is complete acceptance.
