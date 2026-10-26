# Native project definition export (work in progress)

Independent backend JSON exporter, exposed by GET /api/projects/:id/export?format=apipost.
It follows the observed Offline2 export envelope, not proprietary implementation.
The official UI selects APIs, models and environments; this first implementation
only supports bounded HTTP definitions, nested folders, environments/global
variables and service bindings, basic/bearer/API-key authentication and native
custom-script source. It never executes scripts, opens local files or grants a
database connection. It depends on PR #5's native mirrored-query import fix for
Workbench re-import, so its draft PR targets that branch rather than including
unrelated feature changes.

The output is a definition interchange, not an execution backup. Runtime history
and permission grants are not exported. Unsupported plans, protocol resources,
models, examples, inherited settings, database tasks and signing-auth types fail
explicitly; the existing full project backup remains available. No incomplete
output is returned after an unsupported dependency. Private source archives or
vendor code are not included. Explicit export can contain the project's saved
HTTP credentials and variable values, just as the existing project backup does;
the exporter does not fetch runtime-only credentials.

Local acceptance currently covers native JSON re-import, storage/reload,
restored-project isolation, repeated query rows, raw URL query, disabled rows,
body/header/auth output and initial/current environment values using actual HTTP.
Atomic rejection and input immutability are covered. The representative original-application roundtrip is recorded below; final
exact-head CI is tracked separately. This is not native-format parity or complete
project delivery, and remains draft while the remaining matrix is verified.

## Original runtime roundtrip, 2026-10-25

A separate fictional project received the independently generated JSON through
normal Offline2 import UI, explicitly selecting its HTTP API and environment.
The API then executed POST /echo?fixture=workbench-export&repeat=one&repeat=two
against loopback. Both repeated values remained, the disabled query row was not
sent, JSON contained the imported current environment value, and Basic auth
matched the fictional credentials. The echo fixture's old fixtureBasicMatches
flag checks a different historical account and was false; the actual recorded
Authorization bytes, not that unrelated flag, were compared.

The original UI re-exported that project. Workbench imported both the generated
file and original re-export, saved/reopened/restored each, and executed equivalent
HTTP requests. Initial/current variable values and folders remained; the original
files were unchanged. The native echo allowlist did not record the custom header,
so native wire equivalence for that header is not claimed; Workbench checked it
and the original re-export retained its definition. These private runtime files
are not published with the implementation.

Public API tests also cover missing-token rejection, distinct project identity,
read-only success, atomic unsupported-script errors, current-vs-stale script
provenance, unset/null variable rejection, service reference errors and duplicate
IDs. An independent script/urlencoded-body workflow verifies pre-script variable
changes, repeated/disabled text fields, post-response persistence and disabled
task source remaining inert. Stale source metadata is never exported in place of
edited executable code. Empty model-component containers permit repeated
export/import; actual named components still require a full backup.

Remaining original-runtime matrix: script/form/service/path/auth variants beyond
the recorded JSON + Basic + environment workflow, plus the unsupported resource
classes above. Passing CI does not replace that matrix or full delivery.

## Matrix-discovered compatibility corrections

Original import rebuilt the URL from native query rows and discarded query pairs
present only in the URL. It also discarded a per-API custom service ID. These
cases were discovered by inspecting the original persisted imported records,
not inferred from a green local re-import. URL-only literal pairs are now promoted
to the front of native Query rows. Noncanonical/encoded literal spelling that
cannot be guaranteed unchanged rejects explicitly. The initial local raw `%2f`
self-roundtrip was insufficient evidence and is now a rejection regression.

Only a single default service is exported, mapped to native ID `1`; multiple
services reject rather than silently select a different destination. Native runtime re-verification now passes for the single default service,
scripted urlencoded form with repeated/disabled fields and Bearer auth, literal
URL Query plus Path and query API-key, and repeated multipart text fields.
Do not generalize this to multiple native service bindings or arbitrary raw Query
encoding.

The original UI re-exported only those three corrected requests and Matrix Fixed
environment. Its exported current variables confirmed both pre-script and
post-script changes. The combined backend imported generated and original
re-export files, reopened/restored each and executed all three flows, comparing
actual path/body/auth with the original; multipart compares parsed ordered fields,
not random boundary bytes. Sources stayed unchanged. The isolated PR #5 base
lacks PR #8's native kv importer, so its committed matrix tests API-key export
shape and executes Path without auth; the original and combined private matrix
execute the actual API key. This dependency is explicit, not a silently skipped
assertion or copied authentication implementation.

An earlier head 4788331 had a Windows CI failure in the existing SQLite write
process test (SQLITE_WRITE_OUTCOME_UNKNOWN, run40239943970), not the exporter.
Later c3dd0de and combined c512ab1 passed their exact CI, but no SQLite cause was
fixed by exporter changes. The root cause remains under investigation; unknown
writes are never retried automatically and the two-second process bound remains.

Ordered nativeTasks are an executable pipeline, not interchangeable with the
legacy beforeScript/afterScript strings. Until the exporter can faithfully encode
that whole pipeline, any such field is explicitly rejected (including disabled
tasks), even when an older normalizer would omit it. Actual HTTP regression first
returned 200 with erased tasks; it now rejects without modifying the saved project.
This guard does not claim native pipeline export is delivered.
