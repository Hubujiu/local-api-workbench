# Bounded redirects in load runs

This slice supersedes the load-only refusal in ADR-BOUNDED-HTTP-REDIRECTS.md.
It does not change ordinary redirect transport security or enable unrestricted
load traffic. It adds no target-QPS pacing or whole-run QPS guarantee.

## Admission

Only runs containing an explicit existing `same-origin` redirect policy opt in.
The existing 1..5 maxHops policy and authentication whitelist remain unchanged.
Every active HTTP request in an opted-in run, including non-redirect leaves,
must use that authentication whitelist. Scripts (including inherited stages),
legacy before/after operations and native before/after tasks are rejected.
Dynamic inputs are limited to fixed values or variables without function chains;
Mock and Apipost/custom-function sources are rejected in this first slice.
Ordinary runs without redirect keep their existing behavior and report shape.

Single-request admission requires count × (1 + maxHops) <= 100. Staged admission
conservatively requires maxIterations × worst-case expanded step count × largest
per-leaf hop weight <= 100. Non-redirect leaves weigh 1. This may reject a mixed
plan that a more precise weighted analysis could accept. It never silently clamps
counts. Prepared plans are re-admitted. Existing count/concurrency/stage/time and
snapshot limits remain in force.

## Shared transport budget

An in-process branded capability is created per run, never from request JSON.
All workers, iterations, stages and main HTTP leaves share it. Each initial
request or redirect hop reserves one of 100 permits synchronously **before**
prepareConnection, which may establish a proxy tunnel. Failed connections do
not refund permits. Exhaustion stops further work and aborts the run with a
wire-budget reason. Each logical chain still occupies a single worker/VU and
uses its original absolute request deadline. Duration and cancellation signals
still abort active work. No stage or iteration resets the budget.

The preflight upper bound should make exhaustion unreachable for admitted static
runs. The runtime check is an independent defense, tested by consuming permits
before executing a real two-hop chain. It is not a configurable user override.

## Reporting

`mainRequests` retains its logical execute-invocation meaning; it is not wire
traffic. Opted-in reports also include `networkBudget`:

- `limit`: 100 main-chain connection reservations.
- `reservations`: permits consumed before connection setup, including failures.
- `started`: requests reaching the transport send point (before body write/end),
  not guaranteed bytes delivered or server receipts.
- `redirectHops`: those starts after the initial hop of a chain.

Redirects never increment iteration or logical step counts. Existing percentiles
remain response/chain durations, not per-hop latency samples. Rates remain
observed logical completion rates, not a controlled QPS setting. Staged progress
and final reports add only fixed reason counters per step; no new URLs, bodies,
credentials or raw error messages are exposed. Single-request load reports retain
a bounded classification of redirect failure and actual last response status,
without introducing a fabricated status or claiming a redirect failure passed.

## Safety and evidence scope

Same-origin restrictions, cross-origin credential refusal, manual Cookie first-hop
behavior, per-iteration in-memory jars, redirect response-byte budgets, method
rewriting and entity-header stripping remain delegated to the existing transport.
The new regression tests use isolated loopback fixtures, including one-shot and
staged execution, budget admission, method rewriting, cross-origin refusal,
cancellation and Cookie isolation. They do not constitute desktop GUI acceptance,
production throughput validation, or new authorization for scripts, databases,
SQL Server licensing, merging main or deployment.

Authentication is checked again after runtime value resolution. A template that
resolves to a forbidden mode fails before that leaf's connection; earlier valid
leaves in the same iteration may already have run. This is not an atomic rollback
promise for an entire plan.

Local evidence: `docs/evidence/load-redirect/` contains 24/24 focused checks,
64/64 transport/load regression checks, 35/35 entrypoint/collection checks and
full format validation. Batches overlap; these are not 123 distinct tests.
Two older tests expecting a universal redirect refusal now assert the new
unsupported-script / over-budget refusal instead. No live production load,
GUI validation, merge or deployment was performed.
