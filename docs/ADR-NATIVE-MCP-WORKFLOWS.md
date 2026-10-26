# Bounded native-input MCP workflows (work in progress)

REA selected official Offline2 mcpService/mcp-stdio plus renderer1550 analysis
(evidence ev*f87bdaf27cf1fc54a2ad83eee55e943e560268ce9f0bd02cc01539e388715cb8,
ev_d40fc172d38359a41ef5facf8fe998fc3dfbbb98253c7128c1c113da7cb0497e) identified
30 advertised apipost*\* tools and ID-driven frozen plan contracts. Implementation
here is independent; no vendor code or raw private artifacts are included.

Ten bounded aliases support project/API/document discovery, plan create/update,
list/detail/delete, execution and result lookup. They accept native snake_case
IDs and step inputs but retain Workbench grants: writes need write, execution
needs write+execute, deletions require confirm:true. We do not copy original
permission oddities that allow some writes under execute-only or read grants.
Canonical tools remain available. Nested API/plan snapshots and detailed evidence
are explicitly tagged Workbench format, not falsely presented as complete native
objects. This is compatible workflow input, not all30 tool or byte-level parity.

New steps resolve current authorized-project HTTP API IDs and freeze independent
snapshots. Repeated targets have different step IDs. Existing step IDs keep the
old base snapshot, cannot change target and preserve omitted input/scripts;
explicit empty input resets overrides to that frozen base. JSON input is complete
JSON.stringify replacement, including a string value remaining a JSON string.
API-page tasks are stripped; only step scripts run in apipost8 mode. Native step
metadata is bounded and revalidated against the materialized execution request
at save/restore; tampered divergent metadata is rejected before execution.

A shared per-Store MCP run lock prevents concurrent MCP execution/update/delete
of the same plan, including canonical MCP mutations. It is process-local; it does
not claim a cross-process CLI/file lock or change manual HTTP editing policy.
Execution retains strict200, existing environment scopes and evidence storage;
failed evidence persistence remains visible rather than claiming a saved run.
The missing document-detail lookup in canonical MCP is also corrected: a listed
document can now be retrieved, with project isolation unchanged.

Initial official SDK HTTP acceptance covers read/write/execute separation,
project/document discovery, repeated target creation, independent step scripts,
whole JSON replacement, unchanged old snapshots after API edits, reset/preserved
input, saved evidence, source deletion versus old-plan execution, invalid update
atomicity, backup metadata consistency and explicit deletion confirmation.
Further running-lock/stdio/restart validation and exact CI are pending. The
original MCP itself remains disabled: enabling it creates persistent token and
project grants, so this stage uses static original evidence and our SDK fixture,
not an unapproved original authorization change. No frontend additions, merge
into main/develop or deployment.

## Second-stage isolation review

SDK stdio restart and restored-project execution now pass in addition to HTTP.
Running-plan locks are acquired before asynchronous storage reads and held until
save/execution settles, including mutation-first and read-in-flight interleavings.
API assertions and automatic extraction are stripped too, preventing hidden
post-response variable writes. Disabled steps stay disabled on native updates.
Explicit input overrides remove inherited dynamic row/body definitions; empty
input restores the old frozen base and its dynamics.

Manual edits through the existing backend detach unchanged native provenance
when the executable request changes, with an explicit note; validation is not
bypassed and no frontend code changes are needed. Aggregate native snapshot
expansion is capped at4MiB in both construction and backup normalization.
These paths have focused real SDK/HTTP/storage tests; exact final CI remains
separate. Initial feature CI had a failure and is being diagnosed, not reported
as accepted solely from focused results.

Cached SDK URL state also participates in temporary Query/Path overrides. A real
HTTP regression first sent the old cached query despite an explicit new value.
The adapter now updates only matching table-origin members, keeps literal URL
query bytes untouched, clears selected dynamic providers and activates a defined
disabled Path through the existing SDK normalizer. Divergent cached/definition
membership rejects instead of guessing. The original definition remains unchanged.

## Environment/service/variable compatibility stage

Fifteen environment/shared-service/variable aliases extend the same workflow
feature. Initial and current values are distinct: a new key set with only native
value gets current_value=""; subsequent omitted fields preserve prior state.
Runtime-only Workbench keys are not promoted into default values. Explicit null
is stored but native views return "" for null; false/0 remain intact. Deletion
requires confirm:true and an existing key, and removes both maps. Dangerous keys
are rejected and native keys are trimmed.

Environment base_url is the actual default service address, not a baseUrl
variable. Shared services can be created or renamed without an environment;
setting an address requires one. Names are shared and URLs are per environment,
including newly created environments. The original stale-environment service
creation defect is not copied. No-environment service listing does not silently
use the currently selected environment.

Default resource bindings are established only by successful write operations
and persisted as bounded, validated project metadata. Reads do not initialize
files. Workbench IDs remain opaque; "1" can resolve the default when no exact ID
exists. Bound default environment/service deletion is rejected across native and
canonical tools, an intentional stronger guard than the original MCP service
handler. Create/update report truthful is_current and do not switch selection;
the original misleading response flag is not reproduced. Deleting an environment
does not retarget a native frozen plan, even through canonical MCP; later execution
fails before transport instead of silently choosing another destination.

An official SDK HTTP lifecycle validates permission filtering, read-only source
immutability, address/tool consistency, independent variable values/null/false/0,
shared rename/create/delete, real service-bound plan execution and script-created
runtime values, deletion safety, backup isolation, server restart and reauthorization.
This stage still awaits exact final CI and integration review; original service
was not enabled. Remaining native tools and complete nested output fidelity are
not implied by this extension.

Explicit empty environment IDs are rejected, never interpreted as the current
environment for a mutation or execution override. Environment and plan tools use
the same strict default-alias resolver. SDK cases cover blank-ID delete/update/
variable/service/plan attempts without state changes, and the default alias across
configuration, plan creation and execution without changing current selection.

### Native single-API execution

The bounded apipost_execute_api entry point runs an owned saved HTTP API with its
own scripts, assertions and extraction intact. Native auth input is translated
against the effective frozen request, including inherited auth. JSON body input
replaces the full body. It retains Workbench's strict input validation and both
write/execute gates, rather than copying permissive native input behavior.

Execution captures the selected environment once. A concurrent UI/MCP selection
change cannot redirect the active call's variables, cookies, scope commits or
debug cache. History now includes that environment ID. If history append fails
after execution, canonical and native calls return the completed evidence with
recordSaved/record_saved false and a redacted persistence warning; they do not
retry or replay the network request. This does not recover a failed disk write.

Actual SDK/localhost coverage includes API scripts and failing assertions,
temporary bearer/full-JSON input, unchanged saved definitions, project and
environment denial before transport, injected history failure with one request
only, and gated concurrent environment switching with a persistent script write.
