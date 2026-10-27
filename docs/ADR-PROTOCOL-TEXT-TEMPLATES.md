# Explicit protocol text templates

## Decision and compatibility

A saved WS/TCP/SSE definition may opt into `templateMode: "variables"` or
`"literal"`. An absent field stays absent: existing direct/live calls remain
literal, and existing canonical plan messages retain their historical implicit
interpolation (including its existing built-ins/encoding-object behavior).
Explicit modes accept only UTF-8 text. WS/TCP messages are at most 1 MiB;
SSE mode requires POST with a body of at most 64 KiB. Literal mode never expands
placeholders, including in plans. Explicit text modes send an empty WebSocket
text frame when the resolved message is empty; unmarked empty one-shot/plan WS
messages retain their old connect-only behavior. TCP has no zero-length message
framing: an empty payload writes no data bytes and retains normal timeout/EOF
outcomes. No new dependency or frontend control is added.

Variables mode recognizes `{{ name }}` and uses only an own, data-property key
from the selected project's global/environment scopes (environment wins); plans
also retain the existing precedence of earlier runtime extraction. A value must
be a string, finite number or boolean. Zero, false and empty string are meaningful.
Null, arrays, objects, missing keys, malformed placeholders and accessors fail.
There is no expression, built-in, custom-function or recursive replacement.
Expanded UTF-8 length is accumulated before joining segments; there is no giant
intermediate replacement string. Project execution/live scope capture is bounded
to 10,000 entries / 4 MiB and keeps non-scalar values invalid, not stringified.

URLs, query parameters, TCP host/port, headers, cookies, TLS and authentication
are not interpolated or inherited. Existing endpoint and temporary-credential
validation stays in place. Saved definitions cannot override templateMode at a
call site. Structured encodings/binary messages remain available only through
legacy, unmarked paths. This is opaque text substitution, not JSON/XML escaping.

## Entry points and lifecycle

- Canonical frozen protocol plans resolve each enabled step immediately before
  its executor, using the run's selected environment and current runtime scope.
  The frozen plan/template remains unchanged; actual result payloads are resolved.
- Project HTTP one-shot execution resolves before claiming a run/transport slot.
- Project live open captures the selected environment once, validates the default
  message before connecting, and resolves SSE body before fetch. Subsequent
  WS/TCP sends use that private captured scope, not newly selected/edited values.
  Finish/close removes it; session GET and persisted session evidence omit it.
- Global unscoped live endpoints reject explicit template modes/environment IDs;
  they cannot silently pretend to have project variables.

Missing/default/oversized values fail before a one-shot/open connection. An error
in an explicit send on an already open session guarantees no message write, not
that its earlier handshake never happened. Plans retain sequential failure
semantics: failed-step resolution makes no call for that step but cannot undo
prior steps, and does not imply whole-plan transactionality.

## Evidence and persistence

Definitions and frozen snapshots keep their original source. For new explicit
variables executions, one-shot/session evidence uses the resolved literal
execution definition, plus bounded `templateProvenance` containing only
`sourceDefinitionHash` and `environmentId`. Existing request/definition/result
hash validators still verify actual recorded values. SSE body is the actual
resolved text in the definition (the existing SSE requestHash remains null).
Session event hashes describe individual actual sends; its default definition
message is not a claim that every send used that message. Prior record formats
get no default provenance. Full Workbench backup/restore retains both definitions
and inert evidence. Live sessions are not resumed after restart.

This is not blanket secret redaction: open-time resolved default definitions can
already contain referenced values even if WS/TCP send is never invoked. Actual
message/body values and peer echoes are evidence; existing plan history also
retains variable fields.
Only private live variable context is newly excluded from serialization.

## Scope and evidence limitations

This runtime branch is based on PR12 request semantics, not the native importer.
Native PR13 mapping and actual original-project import acceptance are separate.
Legally acquired original static WS sender paths show scoped message replacement,
but original expressions/functions/error handling are not copied and no original
runtime template parity is claimed. No original app, GUI, license, service or
external endpoint is exercised by these tests.

## Local verification checkpoint

`node --test tests/protocol-text-templates.test.mjs` covers actual loopback
WS/TCP/SSE HTTP, canonical plan/MCP dispatch, frozen edits and runtime extraction,
live open/send/stop, concurrent project isolation, zero-connect/zero-write failures, bounded expansion,
backup/restore, strict provenance validation, invalid legacy environment IDs and restart.
The official SDK stdio test launches real authorized child processes twice and
checks denied execution/cross-project calls without wire traffic. The five existing
request-semantics/wire-plan/wire-evidence/wire-session-evidence/protocol-sessions
files were also run (22 pre-existing tests). This checkpoint is not full CI or
native-import acceptance; the parent publishes exact commit/test results.
