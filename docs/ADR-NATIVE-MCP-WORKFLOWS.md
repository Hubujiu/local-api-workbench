# Bounded native-input MCP workflows (work in progress)

REA selected official Offline2 mcpService/mcp-stdio plus renderer1550 analysis
(evidence ev_f87bdaf27cf1fc54a2ad83eee55e943e560268ce9f0bd02cc01539e388715cb8,
ev_d40fc172d38359a41ef5facf8fe998fc3dfbbb98253c7128c1c113da7cb0497e) identified
30 advertised apipost_* tools and ID-driven frozen plan contracts. Implementation
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
