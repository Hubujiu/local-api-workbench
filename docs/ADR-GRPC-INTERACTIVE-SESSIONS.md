# Bounded interactive gRPC sessions (canonical backend)

This is a canonical backend capability, not an original-application compatibility
claim. No frontend, live CLI/MCP mutation, scripts, reconnect or retry is added.
Unary remains on `grpc-run`; the session API explicitly rejects unary. Existing
maintained grpc-js / proto-loader / protobuf.js dependencies and strict validation
are reused, with no new dependencies or custom HTTP/2 / Protobuf stack.

## Owner HTTP contract

- `POST /api/projects/:projectId/grpc-sessions`: `{definitionId, message?, metadata?, tls?}`.
  The complete saved definition must select a streaming method. No target, schema,
  method or deadline override is accepted. Server-streaming requires one explicit
  `message` and closes its request direction automatically. Client/bidi open sends
  nothing (not even `{}`); subsequent sends are explicit.
- `GET /api/projects/:projectId/grpc-sessions/:id`: observe a detached snapshot only.
- `POST .../:id/send`: `{message}`; one request-stream message, strict Protobuf
  preflight before transport. While a write is pending, another send and half-close
  are rejected instead of queued. A lost HTTP acknowledgement must not be retried
  automatically: the remote side may have observed the message.
- `POST .../:id/half-close`: `{}`; close only the request direction and continue
  receiving. Local write callback/drain and end callback are transport progress,
  **not** remote receipt, business acceptance or RPC success.
- `POST .../:id/cancel`: `{}`; end capture with truthful partial evidence.
- `POST .../:id/reconcile`: `{}`; terminal-only storage reconciliation, never RPC
  replay. Repeating cancel also joins/reconciles the same terminal record.

All routes keep existing owner token / Origin checks and enforce project ownership.
A definition is cloned at admission; later edits/deletion never change the call or
its evidence. Backup restore creates a new project identity and never reattaches
connections. No project-delete endpoint is introduced.

## Bounds and states

A session has one 50–30000 ms total deadline from admission, never renewed by poll,
send or half-close. Finite calls, reflection, plans and sessions share the same five
active gRPC slots. Each direction retains at most 100 messages and 1 MiB JSON-level
payload; request Protobuf encoded bytes are also cumulatively bounded to 1 MiB.
Fifty retained session states are allowed. Only terminal, confirmed-saved states
may be evicted; pending/failed/unknown evidence rejects new admission when full.

Lifecycle is `active | terminating | terminal`. Request direction is
`writable | halfClosing | halfClosed | unavailable`. Storage receipt is
`pending | saved | failed | unknown`; active snapshots have no save attempt yet.
Each streamed request records `pending | accepted | failed | unknown` local send
progress; server-stream initial requests use `submitted` (no write callback).
Termination resolves a pending send to unknown, not accepted. Terminal snapshots
are frozen once; late callbacks, data, end, error and status cannot mutate them.

Readable end alone is not success. Streaming responses require end **and** status;
client-stream requires callback **and** status. A callback error (including missing
response with wire status OK) remains a failure, with the actual remote status
retained independently. Local deadline/cancel/overflow can terminate before remote
status. Half-close is never a successful RPC result on its own.

## Persistence and privacy

The first terminal transition automatically attempts one immutable typed gRPC
session record in project `protocolRuns`. Its own codec validates exact fields,
message counts/bytes/states, terminal evidence and definition/result hashes; it is
not disguised as WebSocket/TCP evidence. GET never saves or repairs. A failed/unknown
save can only be retried explicitly with the same record ID and hashes. If storage
already contains matching evidence, confirm it without append or network activity;
a conflicting identity fails. `PROJECT_COMMIT_UNCERTAIN` stays unknown until storage
readback confirms the evidence. Generic storage failure is never replay-safe.

Normal app shutdown cancels active sessions and awaits the current automatic save
attempt; the existing host close outcome includes gRPC receipts. It does not retry
failed saves. Crash/forced termination is not durable capture; restart and backup
restore expose historical records only and never reopen RPCs.

Request metadata/TLS and response metadata/trailers are omitted from snapshots,
history and backups. TLS verification stays strict and proxy/retry stay disabled.
Application messages and remote status text can contain sensitive data; this is not
universal payload redaction. Evidence is JSON-level, not a packet capture.

Real loopback, storage fault, restart/restore, read-only MCP and shutdown acceptance
runs only in normal GitHub CI. Local work is limited to static review, syntax and
format checks; no local application/HTTP/MCP/CLI/VM/database execution is claimed.

## Root integration contracts

Saved native-import `requiredMetadata` policy is frozen with the definition and
is checked by the shared transport preflight before acquiring a slot or creating
a client. Open/send input cannot override that policy. Explicit execution metadata
satisfies it only for the admitted call and is never copied to session evidence.

The five-slot pool belongs to one running app: owner finite calls, reflection,
scripted/unscripted plans, HTTP MCP finite plans and live sessions all share it.
Existing independent stdio MCP and CLI processes retain their finite-plan
contracts; no live-session mutation tools or cross-process connection reattachment
are introduced. Cancellation releases transport admission independently of the
storage receipt, while the existing Store identity, signal and lock guards remain.

Native HTTP execution-result projection rejects session-only state, including a
sparse legacy envelope around a canonical session result, rather than reporting
an empty HTTP success. This check does not inspect HTTP business response bodies.
Native Apipost export is still **definition interchange, not an execution backup**:
a supported native definition remains exportable during/after a live session, but
that output contains no runtime history. Workbench backup and read-only canonical
MCP retain the complete typed session evidence; restore/restart do not reopen RPCs.

`grpc-sessions-root-workflow.test.mjs` specifies one cross-feature CI chain through
native import, real TCP admission counting, PR79 scripts and shared slots, official
HTTP/stdio SDK, CLI, durable receipts and backup/restart. Its presence is not a
claim that a particular root commit has passed CI.
