# Native protocol resource import (work in progress)

This feature depends on PR #12's bounded SSE request/TCP completion semantics.
It does not modify the frontend or copy vendor implementation code.

## Initial scope

- Native websocket2 text message definitions, TCP socket containers and raw UTF-8
  socket_method definitions, and GET/POST literal-body SSE resources.
- Exact query-mirror multiset consumption; extra literal query rows appended.
- Native TCP first-data completion and 1–30 second connection timeout translated
  to bounded milliseconds. Socket containers become folders.
- Known native zero inner sort defaults use the matching index/wrapper sort;
  conflicting names, identities and nonzero ordering still fail closed.
- Source descriptions, response definitions and configuration are preserved as
  inert project metadata, not executed. Inactive auth provider editors are
  removed, so their forgotten credentials are not copied.
- Unsupported active headers/cookies/auth/scripts/inheritance, binary modes,
  TCP processing/other completion rules, templates, unknown resource fields and
  nondefault WS settings reject the whole import. Original insecure TLS and
  unlimited handshake defaults are not adopted; reconnection is not enabled.

## Evidence and remaining acceptance

Official Offline2 synthetic loopback WS text echo, TCP raw/first-data completion,
and POST SSE two-event execution have been observed. Pure conversion of the
current four original protocol records produces three execution definitions.
Original files remain private; repository fixtures are independently written.

Fresh local validation after the transient workspace disconnect includes actual
HTTP import (and invalid-import atomicity), save/reload/restore, nine real
WS/TCP/SSE exchanges across source/restored projects and frozen plans, query
mirror multiplicity, wrapper identity/order errors and the existing modern and
directory import regressions. The initial batch passed 40 tests; the HTTP-import
endpoint version was rerun after the final test edit.

The integration worktree combines this feature with database, Mock and native
flow imports. Its current genuine 27-file original directory imported, saved,
restored and restarted successfully. Six actual protocol exchanges preserved
observed original inputs, SSE POST/two events and TCP first-chunk completion;
source bytes remained unchanged. Original Mock's six cases were separately
compared across 18 HTTP calls with status/body/header equality after this merge.
These local results are not a substitute for exact-commit CI.

No full native protocol compatibility, complete resource migration or original
reverse export is claimed. Headers/cookies/auth/scripts, variable templates,
binary WS/TCP modes, custom TCP frame completion and nondefault WS settings
remain unsupported. Source response examples/config are inert metadata, not an
editable or executable recreation of every original setting.
