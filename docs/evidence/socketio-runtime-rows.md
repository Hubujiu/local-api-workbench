# Socket.IO runtime-row evidence

Base: exact PR #150 head `bd57ba40cc88d9f6472c700804a10480d4fc3c27`.
Production change: only the shared runtime-row capability admits independent
Socket.IO leaves; the transport and peer-diagnostic sanitizer are unchanged.

- RED: the 16 new model/synthetic executor tests all fail against unchanged PR150
  because Socket.IO descendants are not admitted.
- GREEN: 16/16 model/synthetic executor tests pass after admission. They cover
  nested control intersections, unresolved references, static and consumer limits,
  preflight, invalid later rows, atomic extraction, evidence limits, ordinary
  failure policies and uncertain scope-commit fail-stop.
- Real workflow: 40/40 tests pass. Real v2/v4 clients use websocket, polling and
  auto transports against the local Socket.IO fixture. Owner HTTP, official MCP
  SDK HTTP/stdio and CLI preserve frozen definitions/rows and transient credentials.
  The suite covers persistent extraction, v2/v4 ACK/wait/whole-flow/handshake
  failures and disconnect under stop/continue, cancellation cleanup, expected
  failed-status partial extraction, both nested rows/until/IF directions,
  uncertain commits, atomic batches, and reopened stored evidence.
- Diagnostic regression: rejected nested-auth fixtures carry raw, Base64 and
  reversed synthetic secret markers. Results, CLI output and every saved artifact
  are checked for absence across owner/MCP/CLI. A separate test verifies normal
  ACK and event data equal to a credential is retained: this is diagnostic safety,
  not blanket application-payload redaction.
- Broad command:
  `node --test --test-concurrency=2 tests/plan-*model.test.mjs tests/plan-runtime-rows-*.test.mjs tests/plan-repeat-until-socketio*.test.mjs tests/socketio*.test.mjs tests/staged-load-runtime-rows.test.mjs`
  passed 539/539.
- CI exposed one additional obsolete Socket.IO exclusion in the mixed-IF protocol
  chain matrix. The follow-up adds Socket.IO admission and an injected executor,
  preserving true/false, enabled/disabled dispatch checks and SSE rejection.
  Independent matrix verification passes 131/131; matrix plus the new row suites
  pass 187/187. Expanding the broad command above with
  `tests/plan-if-protocol-chain-integration.test.mjs` passes 670/670.
- `npm run check`, `npm run format:check` and `git diff --check` passed.

The full local aggregate and remote CI are reported separately with the PR; this
focused evidence does not claim an aggregate or cross-platform CI pass. Local
loopback evidence does not establish external-service or proprietary-format
interoperability. No merge or deployment is performed.
