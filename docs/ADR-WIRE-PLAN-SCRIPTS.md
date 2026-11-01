# Canonical TCP/WebSocket/SSE plan scripts

## Scope and dependencies

`protocolScripts: { version: 1, before: "...", after: "..." }` is an opt-in field on `type: "protocol"` plan steps only. Omitted phases become empty strings; each source is at most 100000 characters. The whole step graph is statically preflighted, including disabled steps, repeat containers and disabled descendants. The field is rejected on HTTP/gRPC/Socket.IO/repeat steps, even when its value is undefined. Empty or absent scripts retain the ordinary protocol path. This adds no frontend, original-application script migration, shared-script inheritance or general SDK compatibility.

The isolated dependency base joins reviewed gRPC plan scripts/production QuickJS and atomic extraction/commit receipts (PR79), **latest** TCP delimiter completion (PR12), and explicit text templates (PR23). It is not based on the complete integration tree. Repeat execution, native handshake provenance/required headers, native exporters and Postman collection runtime belong to the larger integration, not new dependencies of this feature. Their existing guards must remain intact on composition.

The shared `plan-script-phases` helper contains only candidate scope execution and confirmation semantics moved from PR79. gRPC keeps its message validation, request construction, native status/response evidence and extraction wrapper. Its prior error strings, cancellation acknowledgement behavior and budgets are unchanged. TCP/WebSocket/SSE use the same lifecycle helper but their own native wrapper; there is no copied protocol transport or new VM.

## Native context

`wire`, `pm.wire` and `apt.wire` refer to one deeply frozen view:

```
{
  protocol: "tcp" | "websocket" | "sse",
  phase: "before" | "after",
  request: { /* protocol-specific fields below */ },
  result?: { status, durationMs, result: { /* actual native evidence */ } }
}
```

PRE sees the configured payload and template mode; POST sees the actual resolved payload, with explicit `variables` mode changed to `literal` in the execution copy. The frozen source snapshot remains unchanged.

| Protocol | Request fields | POST inner result fields |
| --- | --- | --- |
| TCP | host, port, duration, completion (effective default `end`), message; optional delimiterHex/templateMode | body, base64, size, timedOut, partial; optional decoded/decodeError/framing |
| WebSocket | url, duration, maxMessages, message; optional templateMode and integration-owned sendEmptyMessage | messages[{data,encoding,receivedAt}], protocol, timedOut, limited; optional closeCode/closeReason |
| SSE | url, method (effective default GET), duration, maxEvents; optional body/templateMode | status, events[{event,id,data,receivedAt, optional retry}]; optional timedOut/limited/cancelled |

An actual error-only failure/cancellation stays `{error}` rather than acquiring fictional messages/events. Outer `result.status` means `completed`, `partial`, `failed` or `cancelled`; SSE inner `result.result.status` is the real HTTP handshake code, **not** the overall stream completion status. A 200 handshake cannot turn a bounded capture into a completed stream. TCP `body` is a UTF-8 view; `base64` preserves exact bytes. `first-data` does not prove application-message completeness. WebSocket `encoding` is authoritative, including binary base64. SSE includes only observed parsed events, not invented response headers/body or reconnect state. Optional fields are included only when actually present.

The host copies strict protocol whitelists, not whole definitions or requests. No headers, TLS, cookies, ephemeral credentials, handshake configuration or source archive enters the context. Application payloads and script-authored logs/variables may themselves contain secrets; this is not universal redaction.

### Independent context admission bounds

Each phase's complete context must be ordinary JSON data, at most 64 nesting levels, 20000 value/container nodes, and **2 MiB serialized UTF-8 JSON total**, including keys, request and result. No getters, functions, inherited array serialization, sparse arrays, non-finite numbers, malformed Unicode or prototype-pollution keys are admitted. Host and worker both validate. Script-context identity limits are 2048 UTF-8 bytes for TCP host and 8192 UTF-8 bytes for WS/SSE URL. These are independent additional admission limits, not claims about pre-existing transport URL/host bounds; the transport's existing rules remain unchanged.

This context limit is independent and can be **lower than the allowed transport result**. For example a valid 1 MiB ASCII TCP capture includes both its 1 MiB UTF-8 body and approximately 1.33 MiB base64, exceeding the context ceiling even before other fields. The transport record is saved in `record.protocolResult` first and remains complete; POST then fails explicitly with `scriptPhase: "after"`. Nothing is truncated, replaced with a successful partial view, or claimed to support all transport-sized results in scripts. If there is no POST source, no unused POST context is constructed. Real CI and data-only tests cover this boundary.

## Capabilities and frozen authority

Only the host `runScript` option `wireContext` selects this mode. JSON input cannot select it; host and worker reject forged input context and mixed wire/gRPC options. Wire binding permits only variable/function/execution identity data and an id/name request shell. It rejects HTTP request/response/final-body, dialect/URL, cookie, network, database or native-task input capabilities. No cookie session is passed, and HTTP request quota is zero. Host output validation also rejects HTTP request/final-body/response/visualization changes or network evidence. Both network brokers remain disabled even if script code tries to mutate its input shell.

`pm.request`, `pm.response`, `apt.request`, `apt.response` and cookie facades are unavailable. Additional HTTP editing/network/visualizer facades cannot be used. Existing variable APIs, console logging, tests/expect, iteration data and environment identity remain available. `pm.info.protocol` is the actual native type and event names are `prerequest`/`test`. Request/context objects are deeply frozen. Endpoints, completion rules and credential bindings are never interpolated or script-editable. The complete per-run credential map is validated before any plan step or PRE executes; integration handshake/source/requiredHeaders admission still occurs there, not after PRE.

The existing production QuickJS compilation, monotonic accounting and lifetime are reused: 16 MiB VM heap, 512 KiB stack, 250 ms cumulative active budget, 2000 ms worker wall budget, 100 timers, 1000 Faker calls, 10000 jobs, 1000 assertions and 1 MiB phase output. PRE and POST are separate phases like HTTP/gRPC; no extra phases, arbitrary VM splitting or budget enlargement are introduced.

## Execution, interpolation and commits

1. Preflight all script containers and the complete credential map. If any active scripted-wire leaf exists, require an explicit function-valued executor before **any** preceding HTTP/PRE side effect. Disabled steps and descendants of disabled repeat groups do not require executor authority, but their script containers still undergo static validation. This new capability's graph-level admission does not change the older ordinary-wire or gRPC executor-check order.
2. Run PRE on a candidate. Errors, tests, cancellation or budgets discard it and start no transport. Confirm its durable environment/global changes once, then publish runtime/local changes. A confirmed PRE remains committed after later transport/POST failure.
3. Resolve payload using the confirmed scopes and same-step local variables. Explicit `variables` resolves exactly once and becomes `literal`; replacement values are not recursively interpreted. Explicit `literal` stays unchanged. Absent mode preserves existing TCP/WS interpolation, including encoded payload objects; absent-mode SSE body remains literal. SSE explicit mode requires a POST body; GET body stays invalid. Revalidate the resolved envelope and exact payload bytes before the existing executor is called once.
4. Save actual native result immediately. Executor exceptions without a result invent no evidence. Signal cancellation or a returned cancelled status skips POST and new variable commits. Current underlying transports commonly return only cancellation error evidence, not every internally observed message; this feature does not change that boundary.
5. Run POST on a candidate even for failed/partial native outcomes. Native expectedStatus, declarative assertions and all script tests must pass; POST cannot reclassify or wash away transport evidence. Bounded partial capture still requires explicit expectedStatus `partial`, independent of a plan's HTTP strict-200 rule.
6. Resolve the entire declarative extraction batch into the same POST candidate. Extraction runs after POST and wins same-name conflicts. Confirm one combined commit, then publish all runtime/environment/global changes and extraction receipts. Missing later paths, failed tests, unexpected status, rejected persistence or cancellation before commit publish none of this batch.

The PR79 acknowledgement boundary remains: an already-started commit that confirms success keeps its entire acknowledged batch even if cancellation occurred while awaiting confirmation, but starts no subsequent work. The larger integration's cancellation-before-actual-store-write check is stronger and must remain intact. Typed unknown commit outcomes (`PROJECT_COMMIT_UNCERTAIN`) set `scopeCommit: {outcome:"unknown",retrySafe:false,phase}`, stop subsequent plan steps, do not claim rollback and never replay transport. Definite failures may continue later steps using confirmed state. Existing run-history persistence receipts likewise do not replay network work.

## Storage and export contracts

Canonical Workbench backup preserves scripts, frozen snapshots and history; restore does not execute. HTTP definition normalization and cURL/OpenAPI request entrypoints reject actual request-level `protocolScripts` before normalization can erase the executable state. They do not recursively scan response bodies, examples or arbitrary application JSON.

On root composition, HTTP-only native plan/result projections, native directory flow encoding and source-derived message-plan reconstruction must reject scripts they cannot represent, including a falsely HTTP-tagged object with this property. Source provenance is not permission to reconstruct a script-free plan. Conversely, definition-only native project export intentionally omits runs/protocolRuns: historical script/session evidence alone must not block otherwise representable definition export. Definition export is not an execution-result projection.

## Validation boundaries

Data-only context/template/delimiter validation can run locally after static dependency review. VM, real TCP/WS/SSE, HTTP, MCP, CLI and storage workflows run only in normal repository GitHub CI. Coverage includes native read-only aliases and capability denial; phase scope atomicity and commit/cancel races; truthful failed/partial/cancelled evidence; whole-graph credentials and markers; explicit/absent template modes and binary/delimiter bytes; concurrent scope/frozen-definition isolation; backup/restart; unknown/definite persistence failure without replay; context over-limit complete evidence; and existing gRPC regression suites. Passing an isolated feature does not establish root-native projection, repeat/collection or handshake composition until root tests run.
