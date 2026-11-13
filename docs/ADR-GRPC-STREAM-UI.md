# Explicit gRPC streaming workbench

Stacked on PR #230. Adds a separate interactive panel alongside the unary definition editor. Definitions are selected from saved project configuration; editing and whole-project CAS saving remain in the existing editor. No new transport or backend authorization path.

## Contract

- Explicit start, read, send, half-close, cancel and record reconciliation use the existing owner HTTP gRPC session API. Server streaming takes one initial message; client and bidirectional streaming require separate explicit sends. Unary stays in its own panel.
- There is no start idempotency key or session list API. A lost creation receipt is unresolved: do not automatically create another stream or infer ownership from a matching definition. A local send acceptance is not remote business acknowledgment. Half-close is not successful terminal completion.
- The existing total deadline, shared active slot limit, evidence retention and message/byte limits are unchanged. No automatic polling, reconnection, retry or replay.
- Terminal transport evidence and record persistence are distinct. GET only observes. Cancel can wait for or retry record persistence; explicit reconciliation may retry only the original record save, never the network operation. Cancellation is not rollback of remote business effects.
- Temporary metadata and TLS key/cert material never enter definition saves or recovery storage. Request/response bodies and error details can enter durable history and may be sensitive. The panel states that boundary.
- Per-project in-memory state and a minimal sessionStorage recovery ledger retain identifiers and unknown-result flags, not bodies or credentials. Restoration never opens a connection. Invalid or unavailable recovery storage fails closed for new effects; safety cancellation remains possible with a warning that recovery evidence may be lost.
- Page/project identity and edit revision reject stale callbacks. Project operation gates prevent execution during conflicting saves; safety cancellation/reconciliation use the existing recovery path without bypassing another active mutation.

## Verification

Targeted model, actual-adapter and real browser fixtures are required. Local test pass is not browser acceptance; CI must execute the new real loopback journey and preserve existing unary, Socket.IO and desktop checks. No claim of external-service compatibility, remote exactly-once, installers/signing, or full-product completion.

### Candidate verification

Final affected regression: 247/247 passed. Independent frozen review: 111/111 passed, including actual app adapter, controller, real backend gRPC fixtures, and existing unary regression. Review closed recovery-ID replacement bypass, manually mistyped ID lockout, missing read-only recovery admission, terminal unknown-write propagation and local schema preflight. The same known ID can be inspected without discarding its snapshot; an unverified manually typed ID may be corrected, but dispatched or confirmed IDs remain bound until terminal evidence is confirmed.

Syntax, repository format scan and diff checks passed. The real browser journey is wired into existing ui-smoke and covers server/client/bidi, half-close, cancel, unknown write without replay, refresh recovery and runtime isolation. Local Chromium failed before page entry with Unix socket EPERM in both ordinary and supported elevated attempts; only the new exact-head CI can establish browser acceptance. No additional full suite was started alongside #230's active full run. Historical failures remain unchanged.
