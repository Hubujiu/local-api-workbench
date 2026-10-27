# Original execution flow and result import

## Observed original behavior

Using the normal Offline2 2.0.0 trial UI, a fictional `Native Script Plan` was
created manually with two occurrences of the same saved local HTTP API. No AI
client, MCP credential or external service was involved. The original wrote
`executions/flows/index.json` (version 2, records) and one flow file containing
independent step IDs, target IDs, full api_snapshot objects, JSON body inputs and
a selected environment ID. These are not the legacy automated_testings array.

A successful run sent both requests. A controlled local 503 then 200 sequence
still sent both steps and marked the overall run failed. Native run index/detail
files retained the 503/200 statuses separately. JSON step inputs were serialized
with two-space formatting. The original's successful/failed result records are
retained as fictional fixtures, never presented as fresh Workbench verification.

REA 6.7.0 was restored from the requested Hubujiu/rea reference at
2c3dd946d59c870388b03c3417eeb5218af96eeb (MIT). A bounded static pass of
utils/mcpService.js produced evidence
`ev_b90a3d685ce35ca775e1a3eaa0bf8a78d79786ec72825078d4ef300b339d71a5`:
one parsed source, zero parse failures, 13158 inventoried files unselected. It is
partial static evidence, not a complete execution call graph. The runtime UI and
local wire observations above establish the fixture behavior. No proprietary
implementation or raw analysis bundle is copied into this repository.

## Import contract

- Reuse the existing directory adapter, modern API converter, request input
  validation and plan snapshot machinery. Import never executes requests/scripts.
- Validate flow/run version-2 indexes, source-project ownership, ID uniqueness,
  exact detail paths, orphan records, metadata and step counts before mutation.
- Up to 50 source flows and 200 total imported steps; existing project plan limits
  and original directory byte/file limits remain. Duplicate imported plan IDs
  reject rather than silently overwrite or append indistinguishable copies.
- Repeated target APIs remain distinct steps. Only the saved API snapshot is used;
  later edits of the live API do not change the imported plan. Original folder
  and project parameter dependencies are resolved at import and then frozen.
  API pre/post tasks are skipped, as observed in the original flow entry; their
  script provenance remains inert instead of being silently activated.
- Bind the explicitly named imported environment. Preserve timestamps, source,
  description and ordered steps. Set strict200 and use the existing executor's
  continue-after-failure behavior. Cancellation and all execution grants remain.
- Supported step input includes JSON body (observed two-space serialization) and
  existing declared Query/Header/Path/Cookie rows through the shared bounded input
  validator. Text/raw bodies and existing URL-encoded/multipart text fields are
  also supported; no file content is imported through step input. Explicit Basic/Bearer/no-auth step settings use native-format conversion;
  other authentication modes, binary and MessagePack body overrides remain unsupported.
  Unknown overrides, missing snapshots/environments and unsupported
  API dependencies reject before any destination change. Other input forms are
  not silently approximated.

## Original history is not a new run

Original run index/details are preserved verbatim in the existing bounded
`settings.apipostDirectoryArtifacts` source archive. They are not added to
`project.runs`, do not increase new-run counts, and do not inherit authority to
execute. Project JSON/backup retains them; dedicated read-only HTTP/MCP queries are
provided below, without a new history UI. The archive shares the 4MiB/20-source limit, with at
most 52 known files per source (catalog + run index + 50 details). Save/restore
validates consistency again. Response bodies can contain application data; this
is not a general-purpose secret scrubber.

## Acceptance

Genuine saved flow and success/failure fixtures are imported without mutation.
Actual CLI executions reproduce first-503/second-200 continuation, body/query
fidelity, environment-only inputs and durable new results. Source API edits do not
redirect the snapshot. Backup restore executes independently and retains original
archives separately; another project receives no runs. Negative fixture mutations
cover unknown bindings/inputs, snapshot identity drift, duplicate steps, index
inconsistency, orphan files and unsafe detail paths, with atomic rejection.

This is a bounded native flow import, not all original step-input/resource types,
a native writer, or a claim that imported historical success was re-executed.
The PR is stacked on the directory-catalog prerequisite to keep feature diffs
isolated; no main merge, deployment or automatic retargeting is authorized here.

## Corrective runtime experiment: flow scripts are skipped

The first implementation ran converted API scripts in imported flows. Further
original-runtime controls disproved that assumption, so that checkpoint remained
WIP even with passing local tests. The current live API pre-script was first
changed and debug-executed to set `native_value=live-source-edited`. The old flow
still contained a pre-script setting `from-before`, yet sent live-source-edited.
Next the live API pre-script was saved as `flow-live-probe` **without** debug
execution. The old flow again sent live-source-edited. Thus neither its saved nor
its current API pre-script ran. A compact observation fixture records both runs.

A REA static pass of the original work.asar sources 1277.59ec09176043.js and
1996.33c788c75f64.js produced
`ev_58cb8d53bebf019bc11d13052fa981ea3e8c18baa349993fe5023acdff5796da`:
two parsed files, zero parse failures, 342 files unselected. Inspection found the
execution entry conditionally clearing both pre/post task arrays, consistent
with the runtime pre-script experiment. This is not full application coverage.

The correction clears executable pre/post operations and shared script stages
only in imported native flow snapshots. Original source script provenance remains
available, and normal imported API debug execution is unchanged. Regression tests
use a distinct environment-only value and confirm no before/after console messages
or post-script variable changes. Existing native directory files may contain only
initial environment definitions, not the original process's current values; no
historical result is promoted into current variables. Import notes require checking
the selected environment before execution. This preserves safety without claiming
that absent runtime state can be reconstructed.

## Read-only source-history queries

`GET /api/projects/:id/imported-execution-runs` returns a bounded, paginated summary
(`sourceProjectId`, `offset`, `limit`; maximum 100 rows). The corresponding detail
path is `/api/projects/:id/imported-execution-runs/:sourceProjectId/:runId`.
Existing local-token protection remains; the endpoint is GET-only and rejects
unknown or repeated parameters. Missing detail returns 404.

MCP exposes `localapi_list_imported_execution_runs` and
`localapi_get_imported_execution_run` under the existing project read allowlist.
No write or execute grant is implied. The official SDK HTTP acceptance exercises
discovery, actual list/detail calls, forbidden project access, malformed input,
missing records and denied execution while proving the stored project unchanged.

Every result explicitly declares `provenance: imported-apipost-archive` and
`executedByWorkbench: false`. Summary status is named `originalStatus`; full source
content sits under `original`. Summaries omit request/response bodies, credentials
and variables. A SHA-256 identifies exact imported file bytes; it is integrity
metadata, not proof of historical authenticity or successful current execution.
No request is replayed and no source-history record is added to project.runs.

## Explicit step scripts are different from API tasks

The original UI's expanded step editor exposes Query input and separate step
`pre_script` / `post_script` strings. A locally controlled original run showed that
explicit step scripts execute while API snapshot tasks remain skipped. The new raw
source sample is not included in this commit, pending publication approval.
The committed regression uses synthetic step values and expected wire/log results,
not a redistributed original run archive.

The importer now preserves those explicit per-step scripts in apipost8 mode,
while still keeping API task provenance inert. Each script is at most 64KiB UTF-8;
normal sandbox/time/network limits remain. Import never executes the scripts.
The real CLI regression checks actual path/body/log order and environment
results against synthetic expectations, and checks restored script snapshots.

Query/Header/Path/Cookie overrides reuse applyMCPInput: only already declared
rows can be overridden; no target, TLS or file settings can be introduced.
Authentication uses the separate bounded native-format path described below. Query has genuine original wire evidence. Additional map/casefold/
path-escaping checks are explicitly synthetic real-HTTP tests, not a claim that
every original input coercion was observed. Oversized/non-string scripts, unknown
parameter names and malformed/unsupported auth settings reject atomically before import.

## Explicit native step authentication

A further locally controlled original run selected Basic authentication on step one
using fictional credentials against a loopback echo. The server returned only a
boolean matching the expected Basic header: true on step one, false on step two.
The saved input.auth is a native auth object, not a Workbench/MCP auth patch.
Raw source files for this experiment are kept local, not published.

The importer applies explicit Basic/Bearer/noauth to a cloned frozen API before
the established modern converter runs. Inactive native authentication sections
are not executed or retained as alternate grants. Active fields must be strings
with known keys, and the whole input auth object is limited to 64KiB. Unsupported
inherit, OAuth, JWT and other modes reject instead of guessing semantics. This
does not change MCP temporary input rules or allow acquiring OAuth tokens, file
access, TLS changes or database grants. Import itself makes no network request.

Synthetic real-HTTP/CLI tests exercise Basic, Bearer and explicit no-auth replacing
an old snapshot auth; the second step and another project remain untouched.
Save/reload/backup retains the chosen request snapshot. Bearer/no-auth coverage is
synthetic, not a claim of an additional original runtime observation.

## Native body input closure

The original Text editor saves body.mode=plain with a string input.body. A locally
controlled original plan sent a template-expanded string with literal plus signs,
percent escapes and ampersands unchanged; its API scripts remained skipped.
The current full original directory was imported locally, saved/reloaded and
backup-restored, then both native plans executed against a real loopback server.
The runtime environment value was explicitly supplied, not inferred from history.
Source directory bytes remained unchanged; raw experiment archives are not
included in this commit.

The adapter now uses the shared bounded input path for raw string bodies and
declared URL-encoded/multipart non-file fields. Explicit native modes are retained
when an empty body would otherwise normalize to none. JSON still uses two-space
serialization. Synthetic CLI wire tests cover text/XML, empty JSON, URL-encoded
escaping, multipart field preservation, second-step isolation and backup snapshots.
Unknown form fields, file overrides, non-string raw values and unsupported body
modes reject atomically. URL-encoded/multipart/XML coverage is synthetic real HTTP,
not a claim of an additional original runtime observation.

### Cross-feature executable task isolation

The native flow adapter now removes the executable nativeTasks pipeline as well
as API-owned assertions/extraction before assigning explicit step scripts. Legacy
before/after operations and shared script inheritance remain cleared. This avoids
both accidentally invoking an API's database task and rejecting a legitimate
step script as a mixed-pipeline request.

ImportedScriptTasks remains inert per-step provenance for the established source
inspection contract; runtime never executes it directly. Mixed task pipelines are
retained separately as importedNativeTaskSource after canonical normalization,
including their order, enabled flags and scope. Raw API snapshots are not retained:
they can contain discarded connection secrets. Neither source field is converted
back into nativeTasks. The source validator is bounded and rejects accessors,
unknown fields and connection credentials; it does not grant execution permission.
Canonical plans explicitly containing nativeTasks are unchanged.

The isolated feature test checks the normalization boundary and actual step-owned
HTTP/script execution. A separate combined acceptance test joins the native API
database-task importer: the ordinary API still fails without its database grant,
while native flows with/without independent step scripts execute real HTTP,
persist only step variables, restore and restart without inheriting the API
pipeline. That cross-feature test belongs to the combined validation snapshot,
not a claim that this PR alone implements the separate database-task feature.

## MCP-saved flows: inert comparison baseline

A bounded static inspection of the already available Offline2 source establishes
that saved MCP flows use `source: mcp` and optional `mcp_name`,
`mcp_description`, `mcp_environment_id`, step `mcp_input` and
`mcp_deleted_body_keys`. These are historical AI-versus-human comparison data.
The saved-flow runner reads the current `input`, explicit step scripts,
`api_snapshot` and actual `environment_id`, not the comparison baseline. This is
static evidence, not a new original-application runtime observation. No vendor
implementation or raw bundle is included here.

The importer maps native `mcp` to canonical plan source `ai`, while retaining the
native source in `importedNativeFlowSource` version 1. Ordinary manual/AI flows
without comparison data keep their previous shape. The new source record contains
only source project/flow IDs, optional comparison strings and step baseline data;
never another raw API snapshot. Each `sourceStepId` / `importedStepId` pair is a
**historical import-time mapping**, not a binding to current steps. Reordering,
deleting or cloning current steps does not reinterpret or discard that history.
Plan edits, snapshots, backup restore and Store writes validate/preserve it.
Run provenance remains stamped by the actual HTTP/CLI/MCP entry point.

The closed baseline input envelope supports body and Query/Path/Header/Cookie
plain JSON data. It never invokes the normal input applicator, interpolates values,
merges an old body, deletes a key, falls back to an old environment or activates an
API task. Historical authentication only accepts exact `noauth`/`none` objects;
credential-bearing/unsupported auth, target/file/TLS/connection/session/grant
fields reject explicitly, rather than being discarded or acquiring authority.
Body/header/cookie values may still contain user-provided sensitive data: this is
not a general-purpose secret scrubber. The actual current input/auth contract is
unchanged. An explicit existing `environment_id` is always required.

Each baseline input is at most 64KiB, 5,000 JSON nodes and 20 levels deep. Maps and
arrays contain at most 1,000 members; historical deleted-key arrays have at most
1,000 strings of 1,000 UTF-8 bytes and 64KiB total. Optional metadata bounds are
800/40,000/800 UTF-8 bytes for name/description/environment respectively. The
source record is closed, rejects accessors, hidden/symbol keys, exotic objects,
non-finite/non-JSON values and malformed UTF-16, and shares the existing 4MiB
plan-provenance budget. Directory limits remain 4MiB, 50 flows and 200 steps.
Omitted and explicitly empty baseline fields remain distinguishable.

Full project JSON backup preserves the validated history. This independent PR
base does not implement native reverse export. Combined native directory writers
must explicitly reject plans carrying `importedNativeFlowSource` until they have
a tested lossless mapping; silently dropping this field is not a round trip.
Native API-only JSON export already rejects plans and must continue doing so.

### Evidence and acceptance for the MCP comparison slice

The bounded static references are Unicode character offsets after universal-newline
text decoding, not byte offsets:

- `1550.0381c5a8bb4d.js`, SHA-256
  `e3ebd9a4f65ffc2ef0fdb1efa228a198eac9334b23d3bb8e8dedbfdbaca30adb`:
  input envelope at 84206; comparison-body reduction at 84626; step baseline
  assignment at 89171; MCP metadata assignment at 91382.
- `1996.33c788c75f64.js`, SHA-256
  `150589fb1018fb58659d0c6d94179355619158939066469226190200b18416d6`:
  MCP source assignment at 18272; saved-flow execution projection at 20455.
- `1277.59ec09176043.js`, SHA-256
  `add06658b9b7aca3cec15e265b10775836eed26d94319d0c345f8c8c62e38d70`:
  comparison UI at 44673–45118; manual editing of current input at 55834.

The tests deliberately mutate the previously approved directory fixture into
synthetic MCP-shaped data; they are not newly captured original MCP runs.
Real loopback CLI tests prove current-input and actual-environment precedence,
absent-input snapshot behavior, 503/200 continuation, API-task isolation, durable
CLI origin, backup/restore/restart and unrelated-project isolation. Authenticated
HTTP tests cover import, clone with fresh step IDs, reorder/delete, source-only
edits, project PUT, invalid-PUT atomicity, real execution and restored execution.
Cancelling a held real request records cancellation without dispatching a later
step; its saved origin is manual, not imported MCP. Source-only edits change the
snapshot hash, but not the wire request. No test grants new MCP authority.
