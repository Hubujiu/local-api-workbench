# Native protocol resource import (work in progress)

This feature depends on PR #12's bounded SSE request/TCP completion semantics
and PR #23's explicit bounded protocol text-template runtime.
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
- Outside the bounded subsets below, active headers/cookies/auth/scripts/inheritance, binary modes,
  TCP processing/other completion rules, endpoint/handshake templates, unknown resource fields and
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
reverse export is claimed. The later sections define the bounded handshake and
payload-template subsets; scripts, endpoint templates, binary WS/TCP modes,
custom TCP frame completion and nondefault WS settings remain unsupported.
Source response examples/config are inert metadata, not an
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
auth/header overlap remain rejected. Socket.IO uses the same ephemeral requirements, with its additional transport-control header restrictions.

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

### Socket.IO handshake extension

The same source-value removal and runtime requirements now cover native
Socket.IO. Its definition carries only safe literal headers and required names;
normalization preserves the exact old shape when handshake is absent. The
connection builder merges/validates the complete runtime set, retaining
Socket.IO transport-control header exclusions and TLS verification. Both HTTP
sessions and saved-plan/MCP calls use that builder. Every enabled Socket.IO step
is checked before the plan starts, not only steps receiving a credentials object.

An independent real Socket.IO fixture verifies native import → persisted frozen
event/Ack plan → SDK permission denial/missing binding (zero connections) →
authorized Ack → restored copy execution → restart. A separate original UI
fixture confirms polling handshake X-Fixture and raw Cookie values before its
event/Ack exchange. Response data is still not a secret-redaction system.

An actual regression test first showed both v2/v4 polling silently overwrote
explicit Accept with _/_. The bounded polling adapter now supplies that default
only when absent; real version-2/version-4 handshake and acknowledgment tests
retain the caller's declared Accept without changing framing/encoding limits.

## Native gRPC metadata declarations (intentional divergence)

The original UI saved enabled text metadata rows for a fictional localhost Unary
and Watch method. Two Unary calls and one server-stream call reached the service
without those rows (only the library User-Agent arrived). This matches a static
wrapper-shape mismatch suspicion, but does not establish every original build's
behavior. Workbench does not replicate this observed omission or claim equivalent
metadata wire output.

Migrate only unique normalized application metadata names to optional
requiredMetadata. Delete every original metadata row value in a detached source
copy across all protos/services/methods, including disabled/blank rows, unconfigured
methods and client/bidirectional streams that do not generate plans. The original
input is unchanged. All values must be supplied explicitly for this invocation.
No imported credential becomes authority and no source value is silently sent.

The requirement survives frozen definitions, HTTP request construction, gRPC call
validation and plan request construction. All enabled gRPC steps are preflighted
before any plan transport. The existing runtime accepts bounded ASCII text or
canonical Base64 for -bin; native -bin source interpretation is deliberately
rejected because original encoding behavior is unverified. Duplicate native keys,
templates, transport-controlled metadata, native TLS and external file references
remain rejected. Old definitions without requirements retain their old shape.

Independent real Unary/server-stream tests cover HTTP and official SDK permission
denial, missing bindings with zero network, exact int64, source-value removal across
all method branches, restored copies and process restart. Runtime binary parsing
is verified separately and is not claimed as original binary-input compatibility.
Response messages/status/source response examples may still echo sensitive data;
this is not arbitrary-content redaction.

requiredMetadata checks key presence, not nonempty values or successful server
authentication. Empty text/binary values remain valid explicit metadata. Remote
authentication status is still determined by the actual RPC result.

## Verified native TLS declaration subset

Only the observed gRPC TLS + certificate-verification-on tuple (tls:1, ssl:1)
is newly accepted and mapped to grpcs://. The previous plaintext -1/-1 tuple is
unchanged. Verification-off/ambiguous combinations and reconnection overrides
remain rejected; there is no plaintext downgrade or verification bypass.

Original renderer analysis distinguishes tls (protocol choice) from ssl (the
verification preference), not a client-certificate flag. Certificate settings
are global to the original app, not project method credentials. They are never
read or imported. Runtime bounded PEM ca/key/cert uses the existing grpc-js path;
private key and certificate must be paired. No PFX/file-path/hostname override or
global trust installation is added. Without custom CA, grpc-js/Node default trust
is used; importing TLS does not imply a mandatory custom CA binding or zero
network on a trust failure.

The original UI saved that tuple and a fictional localhost TLS endpoint. Its
request did not complete or deliver an RPC in the bounded observation window and
was cancelled; no global CA change or verification disable was used. Thus native
successful TLS wire parity is not claimed. Workbench independently verifies the
declaration with a real mTLS service: no CA fails, CA without required client
identity fails, full per-run binding succeeds, insecure override rejects, official
SDK executes, and restored/restarted projects do not inherit trust or client keys.
Existing test certificates are fictional fixture identities, not production PKI.

## Fixed-endpoint native text variables

Only these native text payload fields opt into canonical `templateMode:
"variables"` when they contain `{{`: `websocket2.message[].request.raw`,
`socket_method.request.body.raw`, and POST SSE `request.body.raw`. A literal
payload without that marker retains its old definition shape (no new mode).
The final `normalizeProtocol` validation rejects malformed delimiters and
non-text/oversize definitions. Import remains atomic and does not contact an
endpoint. Input objects and the archived raw payload strings are unchanged;
the existing detached archive credential removal remains in force.

The native adapter accepts trimmed placeholder names of at most 200 characters
using Unicode letters/combining marks/numbers, underscore, dot and hyphen.
`__proto__`, `prototype`, `constructor`, internal spaces, `$` builtins,
parentheses, quotes and operators such as `+` or `/` are rejected. Dots and
hyphens are **whole-key names**, never property traversal or arithmetic. This is
a conservative vocabulary, not a claim to recognize every expression intent.
Wider original names are rejected rather than renamed or silently ignored.
No custom function, JavaScript or recursive expansion is performed. Scalar
values include numeric zero, false and empty text; a value containing another
placeholder is sent literally.

The endpoint, Query, Header, Cookie, Auth, TCP host and port remain fixed.
Socket.IO/gRPC templates, scripts, inherited execution and advanced TCP framing
are not opened by this mapping. HTTP/MCP execution permission and explicit
temporary handshake bindings are still required; environment values do not
become authentication grants. Runtime uses the existing 1 MiB WS/TCP and 64 KiB
SSE expanded-text bounds (the native source payload keeps its existing 64 KiB
import bound). A missing/oversize value before open produces no connection;
the same error during an existing live session produces no additional write.

Saved definition-ID execution and canonical frozen plans use current project
environment/global scalar values. A frozen plan keeps its imported payload and
endpoint despite later live definition edits. An open interactive session instead
keeps its private open-time scalar snapshot, even after environment switching or
editing. Evidence stores the resolved literal request plus its source-definition
hash/environment identity, not the complete private variable context. This is
not arbitrary-content redaction: the resolved messages and remote echoes can
contain sensitive variable values and are retained in records/backups.

The original WS static chain establishes the source text-field/variable path.
There is **no original TCP variable-substitution wire observation**: this is
Workbench's bounded variable semantics over the imported TCP text field, not
full original TCP behavioral equivalence. No original application was run for
this implementation and no proprietary implementation was copied.

Independently authored fixtures exercise actual WS, TCP and POST SSE servers:
native HTTP import, unchanged input/source text, save/reload, concurrent projects,
whole-key Unicode/dot/hyphen names and zero/false/empty values, saved-ID execution,
frozen plans over HTTP and the official SDK stdio client, explicit missing-grant
denial, live open/send/stop, and records through backup/restore/server restart.
Atomic endpoint/expression/script rejection and missing/oversize pre-open versus
live-send failures are distinguished by real connection/write counters. Restored
records do not resurrect sessions or grant removed handshake credentials.

## Legacy composed identity collision rejection

Persisted derived IDs remain unchanged, including colon-containing source IDs.
Before any project mutation, imports now compare structured identity tuples
against their legacy colon-joined keys. Distinct tuples cannot silently become
one equal gRPC definition or one message plan. The check includes existing
redacted protocol sources from the same source-project namespace, so splitting
an ambiguous archive into successive imports (including after restart) cannot
bypass it. Reimport of the same tuple is still idempotent; different source
projects remain separate namespaces. Inert method/message identities reserve
that namespace too. No archived credentials are reconstructed or transmitted.

This rejects new ambiguous imports; it does not repair or reinterpret a project
that already lost definitions before this check. Native export must independently
reject historical collapsed graphs. Full HTTP import/Store/restart tests prove
atomic rejection and zero endpoint connections; existing real gRPC/Socket.IO,
TCP/WS/SSE, frozen-template and restore chains remain part of the batch.

## WebSocket identity and empty text fidelity

Native WebSocket message identities also share the legacy `protocol` namespace
with single-target TCP method and SSE definitions. Structured source tuples now
reject ambiguous colon-joined keys before mutation, including archived sources
from earlier imports/restarts. Existing persisted ID algorithms are unchanged;
this does not repair projects whose distinct sources already collapsed. Separate
source projects retain separate namespaces. Native exporters must reject already
ambiguous provenance independently.

New native empty text messages carry optional `sendEmptyMessage: true`. This is
an explicit WebSocket text-send intent, not a template mode. Only boolean values
on WebSocket definitions are accepted; an explicitly marked message must be
text. The field is preserved by normalization, frozen plans, CLI execution,
record validation, persistence and restore. Saved-definition calls cannot override
it. Nonempty messages send normally. Missing/false flags do not request an empty
frame: old unmarked one-shot empty messages remain receive-only. Existing
explicit template-mode empty-frame behavior and live explicit `send("")` are
unchanged. Old projects/snapshots receive no inferred intent or migration.

No TLS, redirect, message-size, duration or collection limits are relaxed. The
native importer still uses the 64 KiB source bound and runtime uses the existing
1 MiB message and bounded collection limits. Independent real loopback tests
cover empty/nonempty frames, receive-only compatibility, invalid flags with zero
connections, Store/HTTP identity rejection before and after a fresh child-process
restart, cross-project isolation, frozen plans after live definition edits, actual
CLI child execution and evidence/backup restore. Original app code was not run;
this is bounded Workbench behavior, not a claim of complete native WS parity.
