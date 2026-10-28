# Bounded opt-in HTTP redirects (work in progress)

This is a Workbench contract, not a claim of complete Apipost redirect parity.
The default remains **off**. Ordinary HTTP request definitions may explicitly
contain `redirect: { mode: "same-origin", maxHops: 5 }`. `maxHops` defaults to 5
and must be an integer in 1–5. Unknown policy fields and implicit coercion are
rejected. This policy is not inherited from project/folder settings, mapped from
unverified native configuration, or enabled by MCP temporary request input.

## Definition and execution boundaries

- Normalization preserves an absent policy as absent. Cases and plans freeze a
  normalized copy; changing a live request does not change frozen definitions.
- Before-script output cannot add, remove, or change the policy. This guard does
  not roll back side effects that a before script already performed.
- A trusted redirect transport failure retains its actual response when one
  exists, records `redirectFailure`, marks the step failed, and stops later plan
  steps. It cannot become passed merely because an assertion accepts HTTP 302.
  Assertions, extraction, and after work do not run on the failed operation.
- Owner execution exposes the same `redirectFailure` field. Persisted evidence
  is evidence, not a request to replay a network operation.
- Load testing rejects enabled policies before inspecting environments or
  creating traffic. Logical request counts must not conceal redirect traffic.

## Round-trip and exports

Project backup is the lossless interchange path. cURL and OpenAPI exports reject
an enabled policy on an actually exported definition rather than silently
discard it. OpenAPI exports only non-deleted live requests, so cases, frozen
plans, deleted requests and historical execution evidence do not block that
export. cURL validates only its input request.

This branch is based on the Cookie cancellation feature branch. That base has
no Apipost exporter or native MCP workflow adapter. Integration must add the same
export refusal to actually encoded request nodes in those later modules, and preserve any native result adapter's
explicit Workbench failure projection. Their absence here is not a claim that
those integration paths have been tested.

## Transport contract and evidence status

The transport implementation, URL/method/auth/Cookie rules, cumulative budgets,
partial-response behavior and real transport test evidence are developed in the
same feature. This document alone does not establish their acceptance. Local
validation must remain restricted to pure data and inspected script-free
fixtures; it must not execute local VM/XML/native database pressure tests or
relax security limits. Exact final commits and CI evidence belong in the PR.
