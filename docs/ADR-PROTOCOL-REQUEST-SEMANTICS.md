# Bounded SSE request methods and TCP completion

Status: backend implementation; original protocol-resource import remains separate work.

## Observed gap

Official Apipost Offline2 2.0.0 was exercised with fictional loopback fixtures on
2026-10-25. A saved SSE resource issued POST and displayed two actual events.
A saved TCP client/method sent and received the exact 18-byte text payload.
The TCP configuration UI exposes a first-received-data completion option
(`end_func.name = none`), distinct from waiting for peer shutdown. The original
first-data-versus-delayed-EOF behavior has not yet been independently isolated.
REA static inspection of the selected TCP renderer modules corroborates the
configuration fields. No vendor implementation, raw archive, or source data is
included in this change.

Previously Workbench SSE always sent GET and one-shot TCP only finished on EOF
or deadline. Neither behavior can silently represent those native settings.

## Contract

- Saved SSE definitions may explicitly contain `method: GET | POST` and a POST
  `body` of valid UTF-8 text, at most 64 KiB. Missing method retains GET. GET
  plus any body, unsupported methods, malformed text and larger bodies fail
  before transport. Text is sent literally, without implicit variable/template
  evaluation; callers must choose the Content-Type through ephemeral headers.
- Definitions, manual execution, frozen plans and live SSE sessions use the same
  validated method/body. A saved definition cannot be overridden at execution
  by method/body/completion arguments. Credentials remain ephemeral; no saved
  headers/TLS material is added. POST bodies, like other saved payloads, appear
  in definitions and run evidence; inspect exports before sharing secrets.
- One-shot TCP may explicitly select `completion: first-data | end`. Omission
  retains the existing end/deadline behavior. First-data finishes on the first
  received stream chunk and closes the socket; it is **not** a packet framing
  guarantee or a claim that an application message is complete. TCP may split
  one logical message or coalesce several messages. Use end for EOF-delimited
  protocols. Delimiter/length/function-based completion is not implemented here.
- Persistent interactive TCP sessions retain multiple-send semantics; the
  one-shot completion setting does not end an interactive session.
- TLS checks, no automatic redirects/retries, bounded response parsing,
  cancellation, timeouts and project-scoped evidence remain unchanged. No
  default reconnect behavior or original insecure TLS defaults are copied.
- New fields are covered by the existing canonical definition hash. SSE's
  legacy requestHash remains null; the body is bound by definitionHash instead.
  Old definitions and history retain their original normalized shape and hash.

## Acceptance

Synthetic local servers exercise POST body and two events, a TCP server that
never sends EOF, legacy GET and EOF/deadline behavior, cancellation, invalid
input before network, immutable plans, project isolation, disk reload, backup
restore, and normalized result/hash validation. Existing protocol/plan/session
and binary/TLS regression flows run alongside the new checks. This is not
acceptance of native WS/TCP/SSE directory import or all original protocols.
