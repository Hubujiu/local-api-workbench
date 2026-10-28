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

The opt-in path consumes the URL, authentication headers and entity bytes prepared
once by the runtime. It does not recursively normalize the definition, append
query/path inputs again or regenerate multipart boundaries. Each hop gets a new
connection, including forward-proxy absolute targets and HTTP/2 captured targets.
The default-off transport/authentication path is unchanged.

Only 301, 302, 303, 307 and 308 with a Location are considered. 301/302 rewrite
POST to GET; 303 uses GET except HEAD remains HEAD; these transitions discard
entity bytes and entity/framing headers. 307/308 preserve exact bytes and method.
Missing Location leaves an ordinary final response. Duplicate/invalid Location,
nonempty Retry-After, userinfo, non-HTTP(S), cross-origin (scheme/host/effective
port), loops and exhausted hop budget fail with trusted evidence, not success.
Location is bounded to 8 KiB; whitespace/control/backslash forms are rejected.
Empty and repeated queries are preserved. A missing fragment inherits the prior
fragment, but fragments never appear on the wire. Templates are not interpreted
in Location. No Referer or permanent redirect cache is created.

The first slice permits none, Basic, Bearer, an already-acquired OAuth2 resource
token, or ordinary header API keys. Query keys and Digest, NTLM, OAuth1, AWS,
Hawk, EdgeGrid, JWT and ASAP are explicitly rejected before transport. Explicit
Host, Proxy-Authorization and manual connection/framing controls are refused.
Proxy credentials still follow the existing trusted proxy configuration path;
they are not forwarded to origin. This is intentionally narrower than original
Apipost behavior, not a claim of complete compatibility.

Manual Cookie is used only on the first hop. Subsequent hops remove it and ask
the same captured Cookie session for that URL. Each completed response captures
Set-Cookie before following. Intermediate Cookie persistence failures stop;
ordinary final Cookie persistence failure remains a warning. Cancellation or
deadline always stops. Already committed cookies are not rolled back.

One absolute monotonic deadline includes all hops, preparation and Cookie work.
Encoded and decompressed response bytes each have a cumulative 8 MiB ceiling.
The existing 8 MiB prepared request body and at most six sends bound uploads to
48 MiB. Trace is bounded to 256 KiB and contains URL/method/status/size, not
request headers/bodies. State-loop hashes include method, fragment-free URL,
effective headers and prepared body; Cookie-changing loops still meet maxHops.
HTTP/1 response parsing is capped at 1000 header pairs; a saturated raw pair list
is rejected rather than trusting potentially truncated Location evidence.

From headers arrival onward, failure retains the actual response object and its
decoded byte prefix. It never fabricates an HTTP status. A later attempt failing
before headers retains the previous complete response plus attemptedUrl and
requestStarted; receiving later headers replaces it with that real response.
The private failure reader exposes responseComplete and retry_safe:false.
Incomplete bodies do not undergo MessagePack decoding or post-response work.
Successful MessagePack final responses retain existing display decoding.
An internal-only capture callback permits integration with live header-evidence
identity; neither the callback nor trusted failure branding is a request option.

Inspected local fixtures cover policy/shape, the five-status/seven-method HTTP
matrix, byte replay, Cookie refresh, partial response/cancel/deadline, cumulative
budgets, real H1/H2 with HTTP/TLS proxies and independent TLS verification, and
owner/CLI persistence and restoration. Stage failures and exact fixed-commit
reruns remain in evidence logs. This document alone does not establish final
cross-platform acceptance. Local
validation must remain restricted to pure data and inspected script-free
fixtures; it must not execute local VM/XML/native database pressure tests or
relax security limits. Exact final commits and CI evidence belong in the PR.
