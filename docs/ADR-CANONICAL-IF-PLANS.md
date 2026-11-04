# Bounded canonical IF execution plans

## Status and evidence

This feature adds an independent canonical backend control, not a saved native
automation adapter. It depends on the fixed PR44 repeat-plan and PR88 discriminator
admission join. Neither dependency is implicitly merged by this feature.

The official IF help page describes a variable condition deciding whether child
APIs execute: https://wiki.apipost.cn/docs/test/if/ . Read-only inspection of the
legally downloaded Offline2 2.0.0 Linux archive corroborates ordered enabled child
execution only when the condition matches, and an error path for failed condition
evaluation. Archive SHA-256:
7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942.
Plaintext send/index.js SHA-256:
5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff.
Relevant zero-based decoded-text offsets: comparator 33551953, variable helper
33552743, IF handler 33631365, true-only child guard 33632042. These identify
static evidence, not code copied into this repository. The original was not run.

Original comparison includes coercion, empty-value special cases and additional
operators. Its variable merge includes sources not represented by this canonical
plan. We do not claim those broader semantics. In particular, a saved nonempty
event_list → ordered children/request/settings assembly contract is still missing.
This does not make native automated_testings imports executable.

## Definition and supported domain

A group is { type: "if", id, name?, enabled?, condition, steps }. Its condition is
{ op, left, right }. Each operand is exactly { literal: value } or
{ scope: "globals" | "environment" | "runtime", name }. No interpolation, expression,
function, regex, implicit variable source, alternate branch or fallback is added.

- eq/neq compare same-type primitives: null, boolean, finite number, nonempty
  well-formed text of at most 8192 UTF-8 bytes.
- gt/gte/lt/lte require two finite numbers.
- Mixed types, empty text, nonfinite numbers, objects, unknown operators/fields and
  missing variables are errors, not coerced values or false.
- IF descendants in this first scope are HTTP leaves and IF/repeat groups.
  Existing protocol siblings and existing protocol repeat groups are unchanged.
- All definitions, including disabled and false descendants, undergo complete
  static validation before any request. Enabled potential protocol leaves retain
  existing credential preflight; false is not a way to evade admission or grants.

The six primitive comparisons need no new dependency or third-party source.
They are independently implemented using JavaScript primitive operations under
the repository MIT license.

## Ordering, scopes and effects

A condition is evaluated when execution reaches it, against the current committed
scope state, never during pre-expansion. Repeat evaluates an inner IF anew on each
iteration. A false decision skips the complete descendant subtree without request
preparation, scripts, native tasks, database queries, extraction or scope writes.
Disabled groups do not evaluate conditions or emit decisions.

Scope lookup is explicit and uses an own data property. There is no precedence
fallback. The legacy hidden-name list suppresses IF lookup in all three scopes,
including explicit globals/environment. This is intentionally stricter than
pm.globals.get/pm.environment.get, which can read their explicit maps. Deleting a
runtime name can therefore hide an older global, and a subsequent explicit
environment write alone does not remove that hidden marker.

Only plans containing IF preflight initial variable inputs as bounded hook-free
JSON data before createScopes can serialize them. Explicit scope fields must be
plain maps (absent/undefined retains the historical default); hidden must be a
dense variable-name array. Proxy, accessors, custom serialization hooks, cycles,
nonfinite numbers and custom prototypes are rejected without calling hooks.
Inputs share a conservative 4 MiB accounting bound, 100000 visited nodes and
depth 32. No scope grants or secrets are created.

A runtime condition error stops the whole plan, including outer siblings. Prior
completed network effects and accepted scope commits remain. No rollback or replay
is implied. Ordinary leaf failures retain existing continue-on-failure semantics.
Cancellation before a decision performs no lookup; cancellation during a request
retains existing request evidence and starts no later child or sibling.

## Bounds and evidence

IF and repeat share maximum group depth 4, at most 200 potential expanded request
leaves, 4 MiB logical expanded configuration, existing frozen-definition and data
limits, and 8 MiB soft evidence stop. Additionally, at most 200 potential IF
decisions are admitted. Disabled/false definitions still consume static budgets.
Condition literals are charged with their repeat multiplier.

The evidence ceiling includes leaf records plus condition decisions. It is checked
before the next occurrence, preserving the terminal record that crosses it; it is
not a new transport response cap. A cursor tracks actual control traversal instead
of treating result count as a flattened index. Evidence receipts identify a pending
condition by kind and occurrenceId; remaining request count is explicitly potential
when IF is present. Pure repeat identity and existing evidence shapes are retained.

conditionResults are separate from HTTP results. Each decision has stepId/groupId,
an injective repeat-aware occurrenceId, status, and either matched or a sanitized
PLAN_CONDITION_INVALID error. Operand values are not repeated into decision logs.
A false-only plan passes with no fabricated HTTP successes. Initial cancellation
has no decisions. Condition errors return failed with stopReason condition-error.

## Storage and consumers

Canonical snapshot/version/hash, owner run/history, full project backup/restore and
restart retain IF definitions and decisions. Changing a condition produces a new
frozen version without rewriting earlier runs. Restoring a project grants no
runtime database/protocol access and triggers no requests.

Canonical history and MCP plan lists expose small condition count/failure summaries
(maximum five failed decisions), not every decision. Full evidence remains in the
canonical execution-result reader. HTTP failedStepCount remains a leaf count;
failedConditionCount is separate.

MCP final progress marks potential total, actual completed leaves, finished status
and decision count. Final activity changes execution status without blaming the
last successful leaf or removing its repeat identity. Existing project allowlist,
read/write/execute grants and record persistence behavior remain required.

Native-compatible plan/result projections reject canonical IF. Result rejection
also checks conditionResults when a historical record has no snapshot; no silent
linear projection is allowed. Definition-only native export policies are otherwise
unchanged. No UI feature, saved-native bridge, else group or automatic replay is
included.


### CLI declaration-level grant preflight

For IF plans only, enabled potential declarative before/after database operations
or nativeTasks database entries require an explicit invocation grant before any
wire, even if a condition would be false. Without --database-stdin the existing
grant validator sees an empty map and rejects those required bindings. This is a
deliberately stricter new IF contract, not evidence of an earlier authorization
bypass: an unexecuted false branch previously performed no database call.

Disabled ancestors require no binding. Pure HTTP-only IF does not newly validate
an unrelated legacy DB catalogue. Existing non-IF linear/repeat behavior is
unchanged. This is static declaration recognition only; arbitrary script-driven
database calls retain their existing runtime authorization checks, not a claim of
complete static discovery. No connection is persisted or borrowed across runs.
