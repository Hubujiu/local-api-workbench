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
Original source files remain private; repository fixtures are independently
written. Initial synthetic conversion/atomic-rejection tests passed before an
additional inheritance guard. A transient workspace disconnection interrupted
creation of the planned end-to-end test; files were recovered without rollback.

At this WIP checkpoint the complete HTTP import/save/reload/restore/execute
pipeline, source directory plus earlier features, and precise-commit CI have NOT
yet been accepted. No claim of full native protocol compatibility, all resource
migration or original reverse export. Further tests/fixes update this PR.
