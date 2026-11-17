# Additive load report semantics (version 1)

Based on PR171. This change describes existing results; it does not change the
one-shot 2xx requirement, staged plan status evaluation, admission, execution,
network budgets, assertions or cancellation. No opt-in policy, persistence,
history migration, MCP permission or external transmission is introduced.

New reports include `reportSemantics: {version: 1, statusPolicy: ...}`.
One-shot uses `2xx-and-assertions`; staged uses `plan`, meaning the existing
plan strict200 / per-step expectedStatus / explicit status assertion / default
2xx evaluation. The marker is an output description, not an input option.

A real 404 with a successful explicit status assertion still fails one-shot load
but passes an ordinary plan and staged load. This is intentional existing behavior.
The one-shot result now explains that failure as `http-status-policy` rather than
showing zero failed assertions without a classification.

Each one-shot result adds `failureReasons`, an ordered, deduplicated array drawn
only from these five fixed strings:

- `http-status-policy`: an actual response status fails that entrypoint's policy.
- `assertion`: at least one recorded assertion failed.
- `execution`: execution/finalization failed, or no more specific category exists.
- `cancelled`: execution was interrupted by the run's cancellation signal/status.
- `redirect`: the executor produced a trusted redirect failure.

A redirect's intermediate response is not treated as a final status-policy
failure. A cancelled redirect may carry both cancelled and redirect. Error
messages are never parsed to guess a category. Categories are observations, not
a causal ranking; multiple independent observations can coexist. No new category
copies URLs, errors, response bodies, headers, assertion names or variable values.

One-shot top-level `failureCounts` counts samples once per category. Staged
reports add counts at both levels: top-level counts failed iterations once per
category, while each step counts failed step occurrences. Two failing steps in
one iteration can therefore give step totals larger than iteration totals.
All five keys are present with zero defaults. Category totals may exceed overall
failed counts because categories overlap. A pre-aborted run with no iterations
has zero category counts and retains its existing cancelled/stopReason metadata.
Progress reports copy counts, so later samples cannot mutate already emitted data.

All prior fields retain their meaning and values. Existing consumers may ignore
new fields; they must not infer version 1 semantics for saved/legacy results
without the marker, or backfill historical failure reasons from current rules.
There is no historical-report reader or migration added here. The helper operates
only on current in-memory execution records. Ordinary plan execution/history is
unchanged. One-shot existing diagnostic fields remain as before; staged SSE
continues to expose only bounded aggregate information.

Validation uses isolated loopback HTTP and owner API/SSE workflows, with no
production load, new licensing, GUI claim or deployment.

Local evidence: 13/13 focused tests (10 real owner/API/SSE workflow tests plus
3 helper tests), 48/48 load/redirect regressions and 46/46 workflow/collection/
runtime-row regressions passed. Batches overlap. Syntax and full format checks
passed. The prior exact-key runtime-row assertion now permits exactly the two
new top-level fields and verifies their fixed values; all old outcome conditions
remain unchanged. Existing persisted plan history is checked unchanged after new
one-shot and staged load executions; no missing legacy marker is synthesized.
