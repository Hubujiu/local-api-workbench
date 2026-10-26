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

## Extended protocols (next checkpoint)

Socket.IO v2/v4 default configuration and literal text messages can be migrated
as bounded auto-transport connection definitions. Saved messages become clearly
labelled one-step frozen plans, with a 3-second acknowledgement wait only when
explicitly selected. Empty native listener lists remain empty. Plans are not
original execution plans or existing results and never run during import.
Nonempty listener rows/query/headers/cookies/auth, binary/JSON message modes and
nondefault reconnect/handshake settings remain unsupported.

Embedded gRPC Proto definitions can migrate configured unary and server-stream
methods and each saved JSON message as a separate one-step frozen plan.
Unconfigured methods remain inert source metadata; no target is guessed. Proto
paths/include directories/files, remote definitions, native TLS options,
metadata credentials reject rather than reading host files or guessing behavior.
Configured client/bidirectional stream definitions are retained for explicit
manual Workbench calls; saved native messages remain inert source metadata
(with a clearly stated no-generated-plan note), because original
UI and its static call dispatcher explicitly report these calls unsupported.
No message schedule is invented and no source message is auto-executed. Native
stream flags must match the locally compiled embedded Proto. This slice has a
5-second execution bound and no automatic retry; source response examples remain
inert, not assertions. Existing namespaces, plan hashes, project guards and
explicit HTTP/MCP execution permissions still apply.

Original tests in a separate project verified Socket.IO v4 polling, event text
and Ack, plus gRPC no-reflection -> manual owned Proto import, unary binary/int64
and two-message server stream. An original precision defect was observed:
source string 9007199254740993 arrived as 9007199254740992. The same fixture with
an independent official gRPC client preserves 9007199254740993. Workbench keeps
its existing exact string integer handling; it does not reproduce this defect.
REA selected Socket.IO and gRPC renderer modules were analyzed statically.
Synthetic committed tests exercise actual import/persist/restore and HTTP/MCP
execution including exact int64/base64 data. The separate original 9-file extended project also imported, saved, restored
and restarted in the combined worktree, producing one Socket.IO definition,
two gRPC definitions and three explicit message plans. Six actual executions
verified Ack, exact int64/base64 and two-message server streams with unchanged
source files. Precise-commit CI remains separately required.

## Bounded WS/SSE handshake input

Native WS and SSE Header/Cookie input can now be migrated through a frozen
handshake description. Only accept, accept-language, content-type, cache-control,
pragma and user-agent literal headers may persist. All other/custom headers,
Cookie and supported SSE Basic/Bearer/header API-key authorization become required
runtime header names; their source values are removed, including disabled and
blank-key rows. Unknown templates/inheritance and ambiguous Cookie/header or
auth/header overlap remain rejected. Socket.IO active headers remain unsupported.

Execution must explicitly supply the complete runtime Header values. This adapter
does not invent Cookie encoding, reconstruct removed credentials or acquire
authority from imported settings. Original WS and SSE fictional localhost
observations both sent fixtureCookie=a b%2F unchanged (SSE source cookie_encode:1);
explicit runtime bytes preserve that observation without guessing a conversion.

Normalize and combine headers case-insensitively with the existing 50-entry/8KiB
bounds, including required names and SSE's default Accept. All enabled protocol
steps are checked before any plan execution, so a missing later binding cannot
allow an earlier network step. Single HTTP, interactive sessions and official
MCP SDK calls share the fixed definition and ephemeral credentials path. No
runtime binding may overwrite the frozen endpoint or persist into definitions.
Old definitions without handshake retain their exact shape and evidence hash.

Source credentials are not stored in definitions, provenance or snapshots.
This is not arbitrary-data redaction: response bodies/messages/source response
data may contain remote echoes and must be reviewed before sharing/exporting.
The six-header whitelist is a conservative usage policy, not a secret detector.

Independent real WS/SSE fixtures cover SDK project denial, absent binding with
zero transport, stored/restarted/restored definitions, immutable plan inputs,
case/size conflicts, original object preservation, interactive session finalizing,
and source/request-credential removal. The new genuine original Header Matrix
directory also contains settings requiring the combined importer; the isolated
PR branch cannot import that whole directory by itself. Original full-directory
acceptance is recorded separately only after the combined version is run.
