# Opt-in owner load report receipts

The default `/load` and `/staged-load` behavior remains temporary. Only the
boolean `persistReport: true` opts an owner run into durable receipts. This adds
neither GUI controls nor MCP execution/read permissions, and changes no load
budget, authentication, script, status-policy or assertion rule.

## Owner contract

- `GET /api/projects/:projectId/load-reports` returns `{records}`.
- `GET /api/projects/:projectId/load-reports/:recordId` returns one record.
- These are authenticated owner routes, not MCP tools; query parameters and
  mutations on these routes are rejected. Responses are `no-store`.
- Server-generated receipt `recordId` is independent of the existing caller
  cancellation `runId`. Neither is an idempotency key for executing POST again.
- Opted-in JSON results / SSE `reportEnd` include the established `recordSaved`,
  `recordId`, `attemptedRecordId` receipt. SSE `start` also carries `recordId`.
- Pending storage failure returns 503 and starts no runner/network operation.
  A submitted-but-unconfirmed write may be found using `attemptedRecordId`.
- A final storage error does not roll back network effects. The result contains
  `recordSaved:false` and `persistenceOutcome.retry_safe:false`. Query/reconcile
  storage; **never reexecute the load to repair storage**.

## Lifecycle and limits

Before executing, a version-1 `pending` record must be confirmed on disk. A
single atomic identity-preserving transition writes `completed`, `cancelled` or
`failed`; duplicate identical terminal writes are safe, conflicting writes are
rejected. Receipt writes read the latest project and apply the transition while
holding the existing project transaction lock, inside the Store queue. They do
not use a detached snapshot or revision-retry loop; independent Stores serialize
through the same lock. The critical section never calls locking `get`/`save`
again. Unknown commits and lock failures are surfaced without automatic replay.
Completed means the runner returned, not that every sample passed.
Preflight errors after admission have a terminal receipt without raw errors or
fabricated statistics. Cancellation acknowledgment is still only an abort
signal, not proof of finalization. Query the receipt for its terminal state.

Disconnect cancellation finalizes independently of the closed response channel.
Terminal persistence is not passed the aborted execution signal. On crash,
`pending` means **terminal outcome unconfirmed**, not a currently running task.
Reading/restarting/restoring never resumes execution, invents final statistics,
or marks another application's pending task as dead.

Per project: at most 10 pending and 50 terminal records, 1 MiB total, 16 KiB per
record. Oldest terminal records are pruned in the same transaction. Pending
records are never silently pruned; reaching their limit refuses only new opted-in
runs. This first slice intentionally has no pending cleanup/recovery UI. Default
temporary runs remain available. Terminal receipt retention is bounded, not an
indefinite audit log.

## Privacy and storage

Only fixed enums, server UUID/timestamps, fixed report semantics/failure counts,
and bounded top-level numeric aggregates are stored. No request/response body,
URL, header, Cookie, authorization, environment/CSV/script values, raw errors,
assertion text, imported IDs/names, definition hashes, step diagnostics or
request snapshots are persisted. Existing live response diagnostics are unchanged.
`mainRequests`/network-budget statistics remain distinct from logical samples;
redirect hops are not load-request counts and this does not promise global QPS.

`loadRuns` is service-owned activity evidence in `history/load-reports.json`,
covered by existing project transactions and private file writes. Configuration
saves and unrelated activity cannot erase it; ordinary definitions and MCP
project envelopes do not expose it. Apipost definition exports omit it; explicit
full project exports (`format=backup` and the existing `format=native` alias)
preserve it, and backup restore validates it. A restored pending receipt remains inert,
not a recovered controller. Old projects with no field remain valid and no
legacy policy is inferred. Unknown versions, malformed/null fields, duplicate
identities and over-limit backups are rejected.

This projection does **not** claim that the rest of a full project backup is
secret-free. Existing project storage/backup responsibilities remain unchanged.
