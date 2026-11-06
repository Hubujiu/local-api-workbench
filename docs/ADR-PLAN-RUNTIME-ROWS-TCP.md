# Canonical TCP children in runtime row plans

At the TCP milestone, runtime row repeats (`rowsFrom`, `maxRows`) admitted HTTP
and canonical TCP leaves. The later WebSocket extension below supersedes only
the WebSocket exclusion.
The capability intersection applies through nested fixed repeats and conditional
groups, including disabled or false branches. Saved protocol references remain
provisional until resolution and frozen validation identifies the actual protocol.
At that milestone WebSocket, SSE, gRPC, Socket.IO and other leaves were inadmissible.

This is an admission-only change. Execution continues through the existing TCP
executor and canonical protocol script lifecycle. A version-1 `protocolScripts`
before script can read `pm.iterationData` and `pm.info.iterationCount`, then set a
variable consumed by the existing payload interpolation. HTTP scripts can likewise
bind row values for a following TCP step. Row fields do not become implicit
variables, and native imported script formats gain no new execution authority.

The runtime source is still an own runtime value, frozen on group entry. Every row
and descendant row condition is validated before the first child side effect.
Potential-work limits, executor and credential preflight, scope commit semantics,
unknown-commit fail-stop, cancellation, and durable run evidence are unchanged.
Canonical owner, MCP and CLI entrypoints reuse their existing runtime-row opt-in.
Staged load, native flow consumers and native-write restrictions remain closed.

Coverage: `plan-runtime-rows-tcp.test.mjs` exercises real TCP, direct scripted row
binding, frozen sources, nested controls, malformed and over-limit rows, missing
executors, credential override denial, cancellation, timeout and uncertain commits.
Existing runtime-row suites retain unsupported-consumer and native-format checks.


## Canonical WebSocket extension

At the WebSocket milestone runtime rows admitted HTTP, TCP and canonical
WebSocket leaves. Its capability intersection admitted WS repeat-until nested
under rows and rejected SSE, gRPC, Socket.IO and database siblings, including
false and disabled branches. The later [gRPC extension](ADR-PLAN-RUNTIME-ROWS-GRPC.md)
supersedes only that gRPC exclusion.
There is no new transport, reconnect, retry, native format or deployment behavior.

Each occurrence opens a fresh bounded connection. Frozen leaf IDs identify the
invocation-only handshake credential map; credentials are neither saved into plans
nor receipts. Potential enabled leaves preflight before earlier scripts or HTTP.
Rows and references freeze through the existing canonical lifecycle; replacing the
runtime source does not replace the current row frame. `completed` remains the
default expected status; timeout captures remain `partial`, with extraction only
when that status was explicitly expected. Unknown scope commit acknowledgement
fails stopped under both policies without replay, another condition, or a new row.

Coverage: `plan-runtime-rows-websocket.test.mjs` tests real frames, fresh connections,
row scripts and freezing, nested IF/fixed/until, preflight, malformed/over-limit
rows, partial outcomes, cancellation, unknown commits and unchanged quotas and
consumer restrictions. `plan-runtime-rows-websocket-workflow.test.mjs` exercises
owner, official MCP HTTP/stdio and CLI with transient credentials and durable
receipts, including missing or wrong-ID credentials before producer execution.
