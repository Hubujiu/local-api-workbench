# Read-only MCP access to saved load receipts

This extends the owner receipt feature with two explicit read tools under the
existing project allowlist. It does not change GUI, storage, cancellation or
execution state machines, grant write/execute access, or enable load execution
through MCP.

- `localapi_list_load_reports({projectId})` returns `{records}` containing only
  each saved record's id, kind, state, startedAt and optional finishedAt.
- `localapi_get_load_report({projectId,recordId})` returns that project's saved
  validated whitelist receipt. IDs are server receipt UUIDs, not cancellation IDs.
- Both tools are available with `write:false, execute:false`. Unauthorized
  project IDs are rejected before Store access, and archived projects are rejected.
  Cancellation is checked before and after Store access and before publication.
- There is no pagination: at most 60 small metadata rows exist (50 terminal and
  10 pending). Full details are fetched individually and remain bounded to 16 KiB.
  The stored order is retained; this is not a cross-call snapshot guarantee.
- Old projects return an empty list. Missing/evicted records, corrupt storage,
  unsupported versions and invalid arguments fail closed.

`pending` means terminal outcome unconfirmed, not proof that a task is running.
`completed` means the runner returned, not that all samples passed. A detail
read never repairs a receipt, resumes a crashed run, contacts the target, or
replays execution. Existing Store reads may perform their established journal
recovery; this adds no new recovery operation or execution callback.

Parameters and saved receipts use bounded descriptor-safe JSON projection before
validation. No request/response bodies, credentials, project definitions, imported
names, raw errors or other histories are added to the saved whitelist. Unexpected
fields are rejected rather than returned. All tool failures use the fixed text
`MCP_LOAD_REPORT_READ_FAILED`, without inspecting underlying error properties.
Malformed or oversized JSON-RPC IDs are not echoed. Notification handling remains
unchanged.

Generic project responses still strip loadRuns, and ordinary execution history
still excludes these records. Full project backups remain separate and are NOT
claimed to be redacted or secret-free. No automatic pending cleanup, realtime
status inference, new native alias, or new MCP write/execute permission is added.
