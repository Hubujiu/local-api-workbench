# Versioned native gRPC plan scripts

## Scope and dependency boundary

This opt-in backend feature adds `grpcScripts: { version: 1, before: "...", after: "..." }` to a frozen `type: "grpc"` plan step. Omitted phases are empty strings. Each phase is one script, at most 100000 characters. Unknown keys, versions, non-string sources, generic top-level HTTP script fields, and use on non-gRPC steps fail closed. Bare `runPlan` callers preflight all script containers before executing any step. Empty or absent scripts use the unchanged ordinary protocol path.

The isolated prerequisite tree joins the reviewed cumulative/monotonic script-budget fixes, atomic protocol extraction and project commit receipts, and production QuickJS heap/regular-expression/Unicode cleanup fixes. It does not include the experimental engine, native task framework, repeat plans, frontend, or unrelated integration history.

## Script contract

`grpc`, `pm.grpc`, and `apt.grpc` share a deeply frozen native view:

- `protocol: "grpc"`, `phase: "before" | "after"`.
- `request: { target, service, method, timeoutMs, messages }`. Before sees configured message templates; after sees the actual interpolated input messages.
- Only after has `result: { status: { code, details }, messages, durationMs }`.

No HTTP response is manufactured: `pm.response`, `apt.response`, `pm.request`, and `apt.request` are undefined. Native status 0 is not HTTP 200. HTTP editing, visualizer, cookie and extra-network facades are unavailable. `pm.test`/`apt.test`, `expect`, console logging, iteration/environment identity and existing local/runtime/environment/global variable APIs remain available. `pm.info.protocol` is `grpc`; event names are `prerequest` / `test`. Native message arrays preserve all four RPC styles, exact 64-bit decimal strings and base64 bytes.

Only the host `runScript` option selects this mode; a JSON input field cannot. The worker independently validates the native context and disabled HTTP capability. Both the host and worker deny network bridging; request quota is zero. The host rejects HTTP request/final-body/response/visualization mutations in the output. No cookie session, database operation, or native-write capability is passed. Target, service, method, timeout, schema and credential bindings come only from the frozen host snapshot. Scripts cannot mutate messages directly; PRE variable changes are interpolated into message values and pass the existing message envelope and strict transport schema validators before connection. Metadata, trailers, TLS and proto/schema text are never included in script context. Response application data and script-authored logs/variables can themselves contain sensitive data; this is not universal content redaction.

## Order, commits and failures

1. Preflight all per-run credentials and versioned script containers; require the explicit gRPC executor before running PRE.
2. Run PRE in a candidate scope. Script errors, failed tests, cancellation and budget/output failures discard the entire candidate and prevent RPC. On successful completion, confirm its environment/global persistence once, then publish runtime changes. Local variables remain step-local for interpolation and POST. This successful PRE commit is a separate confirmed effect: later RPC/POST failure does **not** roll it back.
3. Recheck cancellation and message bounds, then invoke the original frozen RPC exactly once. Save truthful native result evidence immediately, omitting metadata/trailers. Cancellation after the call skips POST and all new commits. An executor exception without a result does not invent evidence or run POST.
4. Run POST on a cloned candidate even for a nonzero terminal gRPC status. POST can inspect an expected error but cannot change wire evidence. Evaluate native expected status (independent of strict-200), declaration assertions and all script tests. Only if all pass, resolve the entire declaration-extraction batch into that same candidate. Extraction follows POST and wins same-name conflicts; POST reads response messages directly rather than partially committed extraction values.
5. Confirm one combined POST/extraction scope write, then publish all runtime/environment/global changes and extraction receipts. Failed POST/tests, unexpected status, a missing later extraction, cancellation before commit, or rejected persistence publish none of that candidate. Previously confirmed PRE effects remain. In this minimal base, invocation of `onScopeChanges` is the commit-start boundary: the already-started callback may continue reading/waiting/saving after cancellation. If it confirms success, retain the complete acknowledged batch but do not start any further work. The larger integration runtime additionally checks cancellation before its actual storage write; that stronger guard is preserved when composing this feature. Uncertain commits set `scopeCommit.outcome: "unknown"`, never claim rollback, stop the remaining plan steps, and never replay the RPC. Ordinary definite failures still allow subsequent plan steps using only confirmed state.

Logs and assertions from a completed phase retain `before`/`after` labels, and declaration assertions use `response`. A failing phase retains `scriptPhase`; worker errors retain the existing bounded diagnostics. A worker killed during execution does not manufacture successful partial log/assertion receipts. Existing HTTP/MCP/CLI history-save failure handling continues to return actual execution evidence with `recordSaved: false`, without network replay.

## Limits and validation

The existing QuickJS runner is reused, not a new VM or protocol-specific budget: 16 MiB VM heap, 512 KiB VM stack, 250 ms cumulative active work, 2000 ms wall time, 100 timers, 1000 Faker calls, 10000 jobs, 1000 assertions, bounded 100 x 2000-character logs and 1 MiB output per phase. PRE and POST are separate phases like the established HTTP lifecycle; splitting a single phase into arbitrary extra VMs is not supported. The production monotonic interrupt, terminal accounting, heap and regex guards remain intact. No time, memory, output or assertion limit is increased. The script context additionally limits request/response message JSON to 64 nesting levels and 20000 nodes per whole array, and target/service/method identity strings to 2048 characters. A response exceeding these context limits remains truthful RPC evidence but cannot start POST; its candidate scope is not exported.

Pure configuration/context validation may be checked locally after static review. Real QuickJS, RPC, HTTP, MCP and CLI execution is performed only by normal repository GitHub CI. Acceptance covers read-only native context, scope atomicity and confirmation/cancellation races, denial without network effects, all four real RPC styles, entrypoint persistence and non-replay, limits and fresh-run isolation. This implements canonical v1 plan scripts, not native Apipost script migration, inherited script collections, arbitrary SDK parity, interactive streaming, or frontend support.

## Integration-root composition

Nested repeat leaves admit this field only for gRPC. All descendants, including disabled groups, are preflighted before earlier work starts, and each occurrence retains the existing stable leaf/occurrence identity and evidence budget. A gRPC occurrence is not bound to a Postman collection: the preceding HTTP collection is deselected, and collection identity/data cannot enter or be returned from its script context. Ordinary runtime/environment/global values still compose with later HTTP collection-bound consumers.

The root host and worker explicitly reject mixed gRPC and cookie/database/native-task capabilities. Native HTTP-only MCP projections also treat `grpcScripts` property presence as non-HTTP state; native directory export refuses that state before HTTP snapshot normalization. Project backups preserve canonical scripts, nested snapshots and evidence without replay. These guards do not enable native script migration.

The existing root `persistScopeChanges` and `Store.save(project, { signal })` remain unchanged. Cancellation while a save is waiting behind the real project lock rejects before writing; cancellation after a real save but during its acknowledgement retains the confirmed whole batch. Root CI distinguishes those boundaries using explicit gates and durable reads, and verifies nested scope isolation, definite-failure continuation, SDK HTTP/stdio, CLI, frozen-definition edits, backup/restart and native projection refusal.
