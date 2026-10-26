# Execution results and record-save receipts

A completed network execution and its history save are separate outcomes. Manual
HTTP request execution, MCP API execution, plans and the existing protocol
recording paths return the actual completed result even if recording fails.
The HTTP request execution endpoint uses its normal 200 result container; the
peer's status, assertions, script errors/diagnostics and committed variable-write
receipt are unchanged. Existing protocol transport-error HTTP statuses are also
unchanged. Validation/errors before a completed result keep their existing path.

The shared receipt adds:

- `recordSaved: true` and `recordId` only after storage confirms the record.
- `recordSaved: false`, `recordId: null` when recording is not confirmed. This is
  **not** proof that nothing was written or that remote effects rolled back.
- `attemptedRecordId` identifies the intended record for later reconciliation,
  even if the save acknowledgement failed. It is null if evidence construction
  failed before a record was produced. Manual HTTP also returns its `runId` and
  stores it with the history record; it is correlation, not an idempotency key.
- On failure, bounded `persistenceError` is fixed explanatory text, never a raw
  storage exception, path, stack, credentials or nested cause.
- `persistenceOutcome` uses `publicProjectCommitOutcome` for actual typed storage
  errors. `PROJECT_COMMIT_UNCERTAIN` retains `commit_outcome: "unknown"` and the
  scoped project ID. Recovery-required project IDs are limited to this execution's
  project. Other failures use `RECORD_SAVE_FAILED`, without inventing a known
  commit outcome. A message or arbitrary error `code` cannot impersonate a typed
  unknown-commit outcome.

All failure receipts say `retry_safe: false`: repeating execution can repeat a
remote mutation even when history persistence failed before journaling. There is
no automatic execution replay or extra storage recovery in this projection.
Store's existing optimistic conflict handling and protocol-session storage-only
reconciliation remain unchanged. After repairing a storage obstacle, a fresh
Store may recover a journal with the same `attemptedRecordId`; read and reconcile
that record instead of executing again. A failed history save neither undoes nor
mislabels an earlier variable-scope commit.

This is not universal response redaction: the actual HTTP response, request and
script evidence retain their existing semantics and may contain user data. It
only prevents storage-error metadata from leaking filesystem or credential data.
No new persistence is added to load tests or database operations, and no script,
authentication, protocol, execution or security budget is changed.
