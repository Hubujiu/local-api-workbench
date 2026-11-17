# Canonical runtime-row gRPC execution

At the gRPC milestone the runtime-row capability admitted independent `grpc` leaves alongside HTTP,
TCP and WebSocket. It reuses the existing frozen graph, runtime row frames,
per-occurrence gRPC executor and variable-scope commit machinery. There is no
new transport, proprietary/native format interpretation, retry or session replay.
SSE, Socket.IO and database leaves were excluded beneath runtime-row controls,
including disabled leaves and false IF branches. The later [Socket.IO extension](ADR-PLAN-RUNTIME-ROWS-SOCKETIO.md) supersedes only the Socket.IO exclusion. Every enclosing IF, fixed-repeat
and repeat-until policy intersects; gRPC may appear inside rows/until in either
order. Saved references are provisional only until snapshot resolution.

The complete source array and row-dependent conditions are validated when a group
is entered, before any of its children execute. An invalid later row prevents the
first child too. Row data is frozen for that frame. Replacing the runtime source
does not replace an entered frame. This is **not full row isolation**: accepted
runtime/environment/global changes persist into later steps and rows. Nested
until conditions read committed scopes and the frozen current row data.

Every potentially enabled leaf requires executor and metadata/TLS credential
preflight before earlier scripts or requests, including empty-row and false-IF
cases. Credentials are keyed by stable frozen leaf IDs, never occurrence IDs,
and remain invocation-only. Disabled ancestry still receives static validation
but does not require execution authority or credentials.

Unary, server-streaming, client-streaming and bidirectional calls retain their
bounded executor completion contract: no extraction, consumer or next row before
terminal status. Existing expected-status behavior, deadlines, cancellation and
message/evidence limits remain unchanged. Extraction commits a complete batch or
none. An uncertain scope commit stops regardless of failure policy, preserving
transport evidence without publishing an extraction receipt, evaluating another
condition, starting another row, or replaying the call. Ordinary failed steps
retain the configured stop/continue policy. Committed earlier phases are not
rolled back when a later phase fails.

Staged load remains HTTP-only and native linear projections reject these control
graphs. Existing depth, request, control, row-byte, wait and evidence quotas apply
without widening. Owner, canonical MCP HTTP/stdio and CLI use the same graph and
receipt format.

Verification is in `plan-runtime-rows-grpc.test.mjs` (model and synthetic executor
boundaries) and `plan-runtime-rows-grpc-workflow.test.mjs` (actual loopback gRPC/HTTP
peers through owner, official MCP SDK HTTP/stdio and CLI). These tests establish
local execution and entrypoint behavior, not external-service interoperability.
