# Native Redis SET owner-only execution contract

Status: accepted design; implementation WIP. This ADR-only stage does not enable native writes. Original static schema evidence is in `api-original-static-cache/NATIVE-DB-WRITE-STATIC-ASSESSMENT-20261030.md`; PR71 remains a separate completed transport fix.

## 1. First deliverable and explicit exclusions

A complete bounded owner workflow: static native Redis `method:set`, JSON query containing exactly string `key` and `value`, imported as inert task intent -> owner prepares one frozen HTTP request -> explicitly authorizes its exact one SET task -> executes once -> receives truthful write and persistence outcomes -> history/backup/restore retain inert intent and evidence but never authority.

First-slice bound: exactly one enabled SET in one prepared HTTP request, in either before or after phase; existing ordered scripts and readonly tasks are preserved. Multiple enabled SET tasks or multi-step/repeat/load executions containing SET reject atomically. This avoids quietly introducing a multi-operation transaction or bulk authorization contract. Additional requests can be prepared and authorized separately. This restriction is a Workbench safety subset, not a claim about the original.

No MySQL/PostgreSQL/Mongo/SQLite writes, Redis TTL/NX/XX options, arbitrary Redis commands, interpolation, scripts supplying commands, automatic retries, frontend changes, original app execution or native database export. SET is ordinary replacement with prior TTL removal; owner review must explicitly include that warning. Original scalar result is OK; only a confirmed valid OK may feed the existing Redis scalar extraction/console path while the script remains eligible to continue.

MCP HTTP, MCP stdio, CLI, old owner execute/run endpoints, load and native-compatible aliases do not receive write authority in this slice. They must detect enabled SET in whole-execution preflight and reject before script, database or HTTP effects. Ordinary MCP write/execute permission and existing database read grants are never mutation authority. Readonly behavior must remain unchanged.

## 2. Dependency-only base (current exact heads, not branch-name assumptions)

Develop is currently `88f70bb515c48b93536b28b7fe3ec780f2e150f3` and does not contain the native ordered task/current lifecycle contract. Existing dependency joins pull unrelated inheritance/export/repeat features and do not include current prerequisites. Do not use root ancestry.

Approved narrow dependency-only join leaf refs:

| Prerequisite                  | Exact head                               | Why                                                                                                 |
| ----------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| PR9 native ordered tasks      | 23871b56ff21905ab1f9c75dfef5bdbf6b365edd | validated queue, native schema/import/result ordering; includes PostgreSQL isolation PR18           |
| PR3 current script budgets    | 00fd43ddab9398a428a7f24b53cac5db015069e5 | cumulative budgets, terminal activity guard and diagnostics; PR19 does NOT contain this latest head |
| PR19 scoped cancellation      | ad06548d96dd7c338bc2caaaf02de55a69d6edb8 | cancellation priority, queued scope cancellation, completed outcome/reply failure handling          |
| PR17 current storage outcomes | 82336c421e9702b258228c2cdfd95197c1eb8125 | current recovery/restore identity boundaries; PR30 does NOT contain this latest head                |
| PR30 execution save receipts  | 7c5afb162c6814964ea7cc7ce8047caddcadc603 | retain actual execution evidence when save is unconfirmed; no replay on persistence failure         |
| PR71 Redis write close        | ba68cf82f4692bd1465ef1079a7e831b6d761680 | actual local close before write settlement; includes PR24 and PR18                                  |

PR10 and PR2 are not needed to grant writes because all MCP/CLI writes are denied. Their read-only integrations in the broad root remain untouched and require root regression acceptance. No claim that absence of these branches in the narrow base means their integrated-root paths may regress.

Constructed dependency-only base: `deps/native-redis-set-owner-base` head `02ae16b8f98462fbcdbc9673d77ddcabee7da576`, tree `fee56f9788a2745c65fc62fdcfeec7920f6909ab`. All six leaves are ancestors; broad integration root is not. Independent static conflict review passed at scripts/core/server/mcp/runtime boundaries, including latest PR3 vs PR19 and latest PR17 vs PR30. Feature branch is `feat/native-redis-set-owner`. Neither static checks nor this ADR claim runtime CI verification.

## 3. Owner prepare -> authorize -> execute

The three execution-stage endpoints and two lifecycle operations below use existing authenticated owner HTTP token/origin/project boundaries, never MCP tool dispatch. Opaque authorization tokens are carried only in private request body/header fields, never URL/query strings or logs. Suggested project-relative routes are backend-owned names, not original format:

1. `native-write/prepare`: accepts a single HTTP request definition/reference and environment selection. Normalize/freeze the full effective request, native task sequence, configured source binding and explicit runtime Redis target. Validate all phases, task limits, static key/value Unicode/byte bounds, extraction paths and exactly-one-SET restriction. No script, connection or HTTP execution occurs. Return opaque preparation identity plus a bounded review manifest (phase, full task ordinal, IDs, safe target identity, exact SET intent and TTL-loss warning) and a stable digest. Credentials stay private; no automatic grant is created.
2. `native-write/authorize`: owner supplies preparation identity and exact review digest/task selection plus explicit replacement/TTL acknowledgement. Recheck project/source/current session identity, request snapshot, target, expiry and absence of prior authorization/claim. Private target identity covers TLS/CA, user, database and the immutable credential-bearing session generation, while public review exposes no credentials. Mint random opaque one-use token in host memory. This route cannot be called from a script or via exposed MCP tool. A supplied import or plain `allowWrite:true` cannot mint permission.
3. `native-write/execute`: accepts only the opaque token and its prepared identity, not replacement request/command/connection/environment data. Atomically claim the token before any plan effects, transition it irreversibly to reserved, and execute only its frozen single request. Concurrent claims: at most one succeeds. Preflight failure, cancellation, network failure or storage failure never returns a token to available state. A fresh execution requires fresh owner preparation and authorization.

Two required lifecycle operations complete the owner contract (they do not execute tasks):

- `native-write/revoke`: owner-authenticated exact project/preparation identity; prepared/authorized entries become permanently revoked, reserved/active entries synchronously revoke their generation and abort the entire invocation. An already dispatched SET is still drained to receipt/local-close completion. Completed/revoked/expired entries cannot be reopened; repeated revoke is idempotent and does not reset retention.
- `native-write/status`: owner-authenticated lookup by exact project plus preparation/run identity, never by consumed mutation token as read authority. Returns bounded invocation state, immutable terminal write receipt and persistence receipt when complete; no token, credential, command value, full response body or raw error. Works from the host completion cache even when history append or response delivery failed, without re-execution. The cache lookup validates the stored project binding; it must not require a currently readable project file merely to return a prior owned compact receipt after archive/storage failure. This remains owner-only, never a cross-project MCP bypass.

All asynchronous prepare/authorize/admission lookups must recheck exact entry identity, state, expiry, owner scope and session generation after awaiting and before transitioning. Cancellation before the first plan step still produces the sole task's terminal not-sent receipt.

Public review digests cover only the safe manifest and random session generation, never a low-entropy password/credential hash exposed for offline guessing. Private target identity retains the credential-bearing immutable config without exporting it. Receipt reasons are strict allowlisted categories, never raw Redis/network/parser error strings. Restored receipts are inert evidence and cannot mint a host capability. Receipt `projectId` identifies the original execution project, not the restored container or current authority; restoration preserves that historical identity.

Host ledger identity includes project ID, executor channel=owner, preparation/run nonce, normalized frozen-request fingerprint, step ordinal (single step), phase, full task ordinal (including disabled/read/script tasks), task ID if present, canonical command digest and exact registered target/session generation. Hash is a consistency identifier, not authority. Authorization exists only in the private nonce ledger. Canonical stable serialization must be versioned and shared by preview/authorization/dispatch; scripts cannot supply a hash to bypass the ledger.

Prepared/authorized entries must be bounded and expire (at most 20 total ledger/cache entries and five-minute owner approval window; no renewal by token replay). Terminal compact outcomes have a declared five-minute retention window, announced at preparation and returned by status; status/revoke does not renew it. Never evict an active or unexpired terminal entry to admit a new preparation: reject new prepare at capacity. Expired inactive entries may be removed; removed tokens still fail closed. Reserved entries remain owned until terminal receipt/cleanup even after approval expiry. Each prepared snapshot must fit existing request limits and an absolute 4 MiB serialized cap. All retained preparation/config/review/receipt data together have an 8 MiB serialized-byte admission ceiling in addition to the 20-entry limit; this is a retained-payload bound, not a claim that JavaScript heap overhead is exactly 8 MiB. Owner preparation conservatively reserves 5 MiB against that same aggregate ceiling before its first asynchronous project read, then transfers the reservation to actual retained bytes after admission. It may therefore reject a preparation when less than 5 MiB is free even if a smaller eventual snapshot could fit; no limit is increased. Store one immutable snapshot rather than duplicating full query/response copies. Preparation/authorization failures return allowlisted redacted errors and do not retain partially validated or oversized input. Terminal transition releases the full snapshot/config and retains only a compact receipt/persistence record (at most 64 KiB) until expiry. Process restart invalidates every token. No grant/token/credential enters request snapshots, plan files, history, backup, export, logs or script input. Expired/revoked/reserved/completed identities never resurrect.

For an existing saved source request, preparation freezes intent, rather than later consulting live edited SQL/values. A change to current database source/project admission fingerprint invalidates an unadmitted permission at the next admission check; explicit registered-session revoke invalidates its live generation synchronously. The authorize review must describe the frozen request, not silently substitute a newer live request.

## 4. Session and revocation checks

Reuse existing explicit ephemeral Redis connection registrations solely as target configuration; their read capability alone remains insufficient. The new owner ledger captures the exact private session entry/generation rather than rebinding by a user-visible alias. Do not export credentials to the ledger's public manifest.

Frozen-admission contract (not live disk/source cancellation): at prepare, authorize, and execute admission, read and validate current project identity/archive state, source catalog membership/type/transport requirements and the complete admission fingerprint against the frozen preparation. Edited/archived/deleted sources/projects cannot newly admit an old token. No Store-wide mutation observer or claim of immediate external-disk edit detection is introduced.

After the asynchronous admission read returns, synchronously recheck exact prepared object, token state, session entry/generation and owner host state, then reserve before any effects. This prevents a queued explicit revoke/reissue ABA race. Once admitted, the invocation owns its frozen source/target configuration; later definition edits or project archive do not automatically stop that active execution. This matches active-plan snapshot semantics and is explicit in owner review/API documentation. Adding archive-stops-active semantics would be separate scope.

Explicit owner token revoke, registered database-session revoke and host close do invalidate a synchronous generation. After AUTH/SELECT, immediately before SET, check the script/caller cancellation state and those exact generations, consume the task slot and attempt socket.write in one synchronous turn with no await gap. Do not perform another async source lookup at this boundary or silently claim it gives synchronous edit revocation. Redis SSH remains unsupported and no imported path/credential is used.

A post-send explicit revoke stops further task/HTTP/variable effects but cannot erase or rewrite the receipt of an already acknowledged mutation. Only a sanitized scoped receipt of the same owned invocation survives; never reuse MCPDatabaseGrants.query's post-read rejection path to replace a confirmed write outcome. Definition edits/archive after admission are not mislabeled explicit revoke.

## 5. Host-owned write outcome and unchanged deadlines

Separate script completion from write completion. The normal script retains its existing two-second wall deadline and active budget. No timeout increase, fresh sandbox per task, extra script execution time or delayed next-effect permission.

Required dispatch state machine:

- prepared/reserved/not-dispatched: cancellation, deadline or explicit generation revoke prohibits sending SET, including after AUTH/SELECT waits; receipt `not-sent` with bounded reason.
- dispatch attempt: immediately after final checks, consume the per-task slot and conservatively mark `sent` before socket.write. Synchronous send failure is unknown if delivery cannot be ruled out. Never reconnect or automatically retry.
- sent awaiting reply: caller cancellation stops sandbox and all subsequent effects immediately, but only this already-authorized operation is drained under its existing three-second Redis total deadline. Do not abort its observer and thereby throw away a valid ACK. Await actual owned local socket close before finalization.
- valid OK: receipt `acknowledged-applied`. No null/no-op receipt is accepted because NX/XX are excluded. Late caller cancellation or post-send revoke cannot rewrite ACK as cancelled or not-sent.
- no valid ACK after send, including malformed reply, error, EOF or existing deadline: receipt `unknown`; cannot claim rollback, safe replay or remote cessation.

The three-second limit starts with the Redis operation, not anew after phase timeout. After a 2s script deadline, only outcome/transport cleanup may continue for the remaining existing operation window; no more script/HTTP effects. Host event-loop scheduling and awaiting local close are not presented as a hard real-time guarantee.

`mutateRedis` standalone behavior must remain unchanged: no new caller-disconnect cancellation semantics. A narrowly internal write observer/dispatch interface may reuse its compiler and wire implementation while keeping signal policy explicit. Avoid an external arbitrary callback that can replace commands or acknowledge fictitious results.

The receipt must be host-owned outside `databaseQueries` and survive worker termination, late driver errors, explicit token/session revoke and post-write script/extraction/HTTP failures. `scripts.finish` needs a single finishing promise: latch script termination, abort read/subrequest work, terminate worker, await owned mutation finalization, then attach its immutable receipt before resolving/rejecting. Re-entrant worker-exit/close paths must join that same finalizer. No promise that arbitrary unrelated script async work is undone.

## 6. Evidence, persistence and caller delivery

Versioned compact receipt fields: host run/preparation correlation, project-scoped receipt ID, phase/task ordinal/ID, command digest, safe bound source identity, terminal outcome and bounded failure category. Do not persist nonce tokens, credentials or extra copies of the value/target secrets. Request history already retains the frozen static query by its existing contract; do not pretend hashing a small value makes it confidential.

Successful ACK can still be followed by failed extraction, failed later script, failed HTTP, owner disconnect or failed history save. Preserve the write receipt independently of overall request status. The sole write slot always receives a terminal receipt, including not-sent when cancellation or earlier script failure prevents reaching it. A pre-SET error can still follow earlier script effects; preflight prevents invalid authorization but is not a general side-effect transaction.

Owner response explicitly includes `writeReceipts`; run result and history retain the same receipts. A cancellation outcome is not allowed to return an empty result and lose the receipt. Use PR30 recordSaved/attemptedRecordId/persistenceOutcome; confirmed ACK + recordSaved:false remains visible, never replaced by a generic retryable error. History append retry cannot re-execute the SET. If transport delivery fails, retain the bounded receipt/persistence outcome through the new explicit owner completion-cache/status contract; current manual controllers alone do not provide that capability. Do not invent success of persistence or delivery. Expiry is an explicit observation limit and process restart loses unsaved cached receipts, never an excuse to replay.

Backup/restore must preserve task intent and completed receipt schema, remap project-local references where existing restore policy requires it, and invalidate all authorization. A restored project can never use a source project's session, prepared entry or token. A fresh grant requires explicit current target. Do not claim receipts or unsaved in-memory outcomes survive a process crash when storage did not confirm them.

## 7. Expected implementation paths

New, single-owner modules (names provisional):

- `src/native-redis-write-intent.mjs`: static SET normalization, stable intent/review identity, write-task collection and whole-execution deny preflight.
- `src/native-write-authorizations.mjs`: bounded owner preparation/authorization/reservation ledger and generation-bound capability, no persistence.
- `src/database-write-receipts.mjs`: tagged sanitized immutable outcome projection/validation and host finalization bookkeeping (only if splitting improves single ownership).

Existing minimal feature paths:

- `src/apipost-database-import.mjs`: map observed set/key/value only, never source-supplied authorization/mode markers.
- `src/script-database-tasks.mjs`: canonical inert SET intent, strict mode/result validation and ordinary OK scalar semantics.
- `src/redis.mjs`: internal pre-dispatch cancellation check/post-dispatch drain with terminal receipt, preserving standalone API and PR71 close contract.
- `src/database-sessions.mjs`: generation-bound target access/revalidation; read query remains readonly.
- `src/scripts.mjs`: ordered broker dispatch + host-owned write finalizer, without granting VM command construction.
- `src/core.mjs`: normalize all enabled tasks then capability preflight before any effect; snapshot/result/receipt propagation; stop after write-related failure/cancellation.
- `src/server.mjs`: owner-only three-stage routes plus revoke/status, completion retention/lifetime/cleanup, explicit response receipt projection/history behavior.
- `src/execution-evidence.mjs` / `src/plan-evidence.mjs`: prefer reuse unchanged; modify only if typed receipt preservation needs a central projection, never add execution callbacks/retries.
- `src/runtime.mjs`: only if strict persisted receipt/restore validation requires it; do not duplicate journal machinery.
- `src/mcp.mjs` / `scripts/run-plan.mjs`: only necessary clear fail-closed preflight adapters; core check is mandatory regardless. No mutation executor is passed to these paths.

Integrated-root boundary review (not justification to drag broad root into base): `src/cli-database-grants.mjs`, `src/cli-runtime-credentials.mjs`, `src/mcp-database-grants.mjs`, `src/mcp-stdio-database-grants.mjs`, `src/mcp-stdio.mjs`, `src/native-mcp-tools.mjs`, `src/plan-repeat.mjs` and load runner. Their valid readonly behavior remains; every write-bearing entrypoint without the owner capability must reject before effects. Native compatibility aliases must not execute a write then omit its receipt; first-slice behavior is rejection.

No required change to `script-worker.mjs` budget/VM implementation: retain host broker task indices and existing single lexical scope. If implementation proves a worker change necessary, stop and justify it separately rather than silently widen this phase.

## 8. Complete acceptance contract (ordinary CI only for runtime)

1. Static original set/key/value mapping; reject options/extra fields/templates/non-string/invalid Unicode/oversized args/forged markers/unsupported providers; atomic import and frozen task order.
2. Pure ledger tests: owner-only creation, deterministic versioned identity, wrong project/request/phase/ordinal/hash/target/session/channel, expiry, explicit revoke, edited/archive admission rejection, admitted frozen-definition continuity, concurrent reservation, at-most-one dispatch, no reuse after any failure; strict bounds and secret-free preview/storage; owner-only status/revoke, terminal retention without read-renewal, no active eviction, and capacity rejection.
3. Real Redis owner HTTP flow: import -> save -> denied without authorization -> prepare (zero connections) -> authorize (zero writes) -> execute -> exact value and TTL-loss readback -> OK scalar extraction -> following script/HTTP -> persisted receipt -> restart/restore denial -> fresh explicit authorization. Before and after phases, ordering, immutable snapshot and unrelated project isolation.
4. Independent actual TCP/TLS peers: AUTH/SELECT blocked, pre-send cancellation/explicit generation revoke/phase deadline sends zero SET; dispatched SET + phase timeout/cancel stops script/HTTP yet ACK/unknown receipt is retained; ACK just before cancellation remains acknowledged; malformed ACK/error/EOF/3s timeout yields unknown; no replay/reconnect; actual socket close precedes final outcome; unrelated active invocation survives.
5. Real Redis ACK-withheld proxy: observe applied mutation while owner receives unknown; read back once without replay; separately prove late valid ACK after stopped script yields acknowledged receipt and no subsequent HTTP.
6. Failure after ACK: extraction/script/assertion/HTTP error plus unconfirmed history save retain receipt and correct recordSaved:false; recovery reads saved evidence without replay; response disconnection/cancellation does not release ownership early; owner status remains able to retrieve the terminal compact receipt after response loss plus history-save failure, until its declared retention expiry.
7. Every unsupported entrypoint: old owner execute/run, repeated/multi-step/load requests, MCP HTTP/stdio/canonical/native aliases, CLI imported plans, copied IDs/tokens, ordinary read grant + MCP write/execute -> zero database/script/HTTP effects. Existing real readonly native HTTP/MCP/CLI suites still pass.
8. Restore/export/privacy: no credential/token/capability persistence; task/receipt semantics retained across save/reload/backup restore; foreign project/source/session mapping and restored grants rejected; no native export claim.
9. Full feature CI plus root integration CI/artifacts and actual portable source correspondence on final heads. Syntax/format/pure static checks may run locally; no local app/VM/XML/SQLite/provider/network/pressure execution.

Parent decisions confirmed: owner-only exactly-one-request/exactly-one-enabled-SET bound; latest PR17 included in six-leaf narrow join; 20 entries / five-minute nonrenewing preparation window, five-minute compact terminal retention, 4 MiB per snapshot / 8 MiB total serialized payload ceiling; explicit revoke/status lifecycle operations; outcome categories not-sent / acknowledged-applied / unknown. Dependency join and ADR publication are authorized; feature implementation remains WIP. No performance/safety budget weakening is proposed.
