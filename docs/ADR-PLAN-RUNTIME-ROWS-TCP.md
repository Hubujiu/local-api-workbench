# Canonical TCP children in runtime row plans

Runtime row repeats (`rowsFrom`, `maxRows`) admit HTTP and canonical TCP leaves.
The capability intersection applies through nested fixed repeats and conditional
groups, including disabled or false branches. Saved protocol references remain
provisional until resolution and frozen validation identifies the actual protocol.
WebSocket, SSE, gRPC, Socket.IO and other leaves remain inadmissible in this subtree.

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
