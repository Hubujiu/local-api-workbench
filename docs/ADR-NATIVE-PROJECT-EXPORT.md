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

## Native directory definitions (work in progress, 2026-10-26)

The directory exporter reuses the native HTTP serializer and PR #7's directory
and frozen-flow importer. PR #14 is now stacked on PR #7 for this actual dependency;
its diff remains the export feature. GET export?format=apipost-directory returns
a bounded JSON file manifest and does not write host paths or registry entries.

This slice supports up to 50 strict200 HTTP plans and 200 enabled steps. Each
snapshot has a project-scoped stable ID independent of the mutable live API.
Actual step scripts are written only to pre_script/post_script; pure non-inherited
customScript source is written only to the frozen API task fields. These source
tasks are not copied to live API records or promoted to step execution. Already
materialized request input is exported directly, with empty native input maps;
old MCP input is not replayed. The full generated directory is imported into a
detached project before returning output. This is validation, never execution.

Both native export modes now support explicit response bodies (including empty
text), delays/headers, unique status/media pairs and matching inline object
schemas. Description/name conflicts, reference-dependent/boolean-root schemas,
unknown fields and ambiguous pairs reject. Response auto-validation is explicitly
disabled; documentation schemas do not become runtime assertions.

The directory remains definition interchange, not an execution backup. Existing
source archives, DB/mixed task provenance, inherited task origins, unsupported
protocols, disabled steps, non-strict200 policies, assertions/extraction and shared
function snapshots reject rather than silently lose semantics. Session grants and
runtime history are not recreated. The normal full Workbench backup remains the
complete preservation path for unsupported resources.

Local acceptance covers live API edits not changing frozen steps, separate source
and step scripts, real HTTP execution across import/re-export/restore/restart,
response/schema roundtrip, read-only authenticated export and cross-project IDs.
Original application reopening/saving of the generated directory has NOT yet been
verified: the known UI storage picker creates a new project, not an established
open-existing-directory operation. No registry modification or inferred original
runtime success is used to hide this remaining gap. Current/initial environment
values in generated directory files also need that original-runtime verification.

Static compatibility review found and corrected missing native response editor
identities/defaults: each example now has a stable API-scoped example_id,
raw_parameter:[], is_default:-1, verify_type:"schema", mock:"", and string status.
Directory snapshots namespace those IDs separately from live APIs. Raw text uses
native body mode plain (the observed original UI enum), not the import-only text
alias. Parameter schemas preserve supported basic types and reject constraints
that the native importer would discard. Different step/request labels reject
rather than silently change the label. These static corrections still need the
separately pending original UI verification; local roundtrips do not replace it.

## Frozen directory identity and recoverable resource state

Directory export must not add active API directories merely because a frozen plan
still references a deleted or moved path. A snapshot requiring a folder absent
from the active definition export now rejects with a project-backup instruction.
Explicitly retained active folders remain valid; ancestor presence alone does
not authorize recreating a removed descendant. This conservative guard preserves
both the frozen plan and current project rather than rewriting either silently.
Native definition export also rejects populated `apiResourceTrash`; it cannot
represent recoverable Workbench resource state. Full project backup is distinct.
Independent negative tests reproduced both omissions before the fix; pure native
roundtrip and authenticated HTTP/disk/backup tests cover the guard and unchanged
state. This is not new original-UI roundtrip evidence.

## Bounded conditional Mock reverse interchange (WIP)

JSON and directory definitions now serialize native conditional Mock data without
evaluating conditions, sampling schemas or running scripts. Generated data is
read back through the existing native importer and compared before returning.
Rules retain order, IDs, names, enable state, AND conditions and literal values;
sourceStatus is retained while runtime remains fixed HTTP 200. Headers, delays,
fallback, inline object/array schemas and raw JSON object/array bodies survive.
Inline rule examples avoid altering the separate request documentation examples.
Condition/example IDs are stable; directory output uses final project/API IDs and
one settings/mock\_<target>.json configuration rather than conflicting mirrors.

Scalar/raw-XML serialization, model/external references, non-JSON raw bodies,
ordinary/native mixed rules, global custom Mock-library dependencies and paths
that cannot reverse faithfully reject. Existing unsupported project resources
still reject. Retained mock_inner_rules and execution archives are not consumed
per-API Mock config and cannot be discarded as redundant. No original GUI or
XML/engine-special audit was performed for this feature.

settings.mockEnabled=false previously disappeared during export, reopening Mock
serving on re-import. No verified native project-wide equivalent exists, so both
exports now refuse this state. smartMockBuiltins=false, builtinDictionary=false
and recursiveFolderScopes=false are neutral defaults; empty resource collections
remain accepted. mockSeed=0 was already rejected, never silently discarded. True
recursiveFolderScopes cannot affect the supported export subset because inherited
settings are rejected independently. Future unknown settings are not thereby
assumed neutral.

Focused acceptance covers authenticated HTTP exports; real hit/fallback/disabled
rules, duplicate query and combined header/bracket-body POST conditions; declared
404 versus executed200; raw JSON/schema responses; repeated dual-format roundtrip;
document examples and source immutability; disabled API roundtrip; project
isolation, backup restore and restart. An invalid regex literal is transported
inertly, not executed. The dependency-only base joins native directory import,
conditional Mock and verified runtime/CI prerequisites without root integration.
MCP export is absent from this isolated baseline and requires root integration
acceptance rather than importing an unrelated MCP feature. Exact-commit CI is
required before acceptance; local workflow results are not full compatibility.

## Explicit SDK URL mode must not silently downgrade

A request using scriptURLMode=sdk and pm.request.url.query.add previously exported
successfully, but native import kept its script and dropped the mode. Re-execution
then failed because the imported URL was a string. No verified native field carries
this Workbench mode, so both exporters now reject it explicitly, even without an
active script. Frozen directory steps pass through the same guard. No script
rewriting, inference or global import-default change is attempted.

The ordinary HTTP workflow proves the original SDK query edit reaches the wire,
authenticated native exports return400 without mutation or execution, and the full
Workbench backup preserves the frozen SDK step through restore/restart and actual
HTTP execution. Editing the live API to ordinary mode does not erase the frozen
step's restriction. Ordinary legacy/apipost8 definitions retain positive coverage.
This small format guard does not change the URL implementation or script runtime.

## Active document definition roundtrip

The document slice reuses PR21's bounded static `target_type: "doc"` contract.
Current title/content/folder and status selection are exported as name/description,
parent relationship and mark reference. Current statusId takes precedence over a
historical source mark. Source sort/version/status remain inert scalar metadata.
Empty content, CRLF, Unicode, Markdown, HTML, template-looking text and URLs are
preserved literally: no rendering, interpolation, execution, attachment fetching,
link migration or internal-link rewriting takes place.

Both formats assign output project/target/parent/mark identities consistently.
Old Workbench document IDs and apipostSource identity are NOT preserved verbatim:
reimport derives a new identity from the exported source. Workbench backup alone
preserves exact historical identities. No invented provenance extension or body
annotation is emitted. Generated IDs are deterministic for a fixed input project;
reimport into a new project is not a claim of unchanged IDs across generations.

Supported plain Workbench text documents need no native source metadata. Native
names must be nonempty and at most 200 characters (narrower than the 500-character
Workbench title limit). Unknown source fields, custom import notes, populated
attributes, deletedAt and resource trash are rejected; they are not filtered away.
A historical mark without a current validated statusId is rejected rather than
silently revived. Non-string rich-text/attachment bodies and native task payloads
remain unsupported. Empty attribute objects and absent/empty generated notes have
no extra exported semantics. Existing whole-project unsupported-feature guards
continue to apply.

The dependency-only base joins the existing export prerequisites with PR21 and
its PR20 prerequisites, not PR14 or root integration business commits. The feature
changes only export conversion, regressions and this ADR. Tests exercise owner
JSON/directory import, edits through authenticated PUT, double export/reimport,
plain and native documents, mixed and document-only projects, current status
edits, same titles in different folders, source/project isolation, exact backup
restore and restart. Deleted archives and unsupported metadata fail closed.
Source fixtures are independently authored, not original GUI roundtrip evidence.

## Bounded reusable model definition graph

The exporter now uses the existing model importer, model folder validator and
schema-position classifier as a static reverse adapter and readback oracle. It
never executes, samples, compiles, expands or fetches a schema. Model/folder IDs
are generated together; API body and response schema references use the same
mapping. JSON `models` and directory `schemas/index.json` plus wrapped
`schemas/<id>.json` carry the definitions, including empty model folders. The
previous intermediate guard rejected modelFolders explicitly rather than silently
losing them; supported folders now actually roundtrip.

Only a one-to-one exact dictionary/schema-component graph is accepted, with
existing bounds (100 models plus folders, 20 folder levels, 50000 schema traversal
nodes, 40 schema levels and project byte limits). Unknown fields and other
component categories remain unsupported. Source sort and folder relationships
remain data. Model object/boolean definitions, whole-model references, static
self/mutual references and same-model local pointers are preserved without
inlining. Cross-model subpaths, unresolved aliases, external references, dynamic
anchors and custom model-combination extensions reject. Literal example/default/
enum/extension objects are copied as data, even if they contain `$ref`-looking
keys. Parameter schema and conditional-Mock reference limits remain unchanged.

Naming is intentionally narrow: existing native import prefixes every dictionary
name with the source project name plus `/`. Export requires that exact current
project namespace and a nonempty native suffix no longer than 200 characters.
It removes exactly that prefix and verifies the original name on readback. It
never guesses, changes generic import naming, or repeatedly adds prefixes.
Importing into an arbitrarily named destination is allowed, but that destination
may not satisfy the next native export precondition; rename mismatches explicitly
reject. Arbitrary names and historical IDs are preserved by Workbench backup,
not promised by this subset. Two-generation tests deliberately keep the required
project name and separately test mismatch rejection.

The regression workflow imports both source formats, edits the linked model with
existing saveModel, saves through owner PUT, checks request/response links, exports
both formats twice, sends a small literal body to fictional loopback HTTP, then
backs up/restores/restarts. The schema remains a definition; no new schema runtime
or generation path is enabled. It also checks empty directories, literal reference
annotations, persisted source identity in backup, unrelated-project isolation and
atomic refusal of unrepresentable graphs. No original program or special runtime
stress/audit was used.

Boolean **model** definitions and API `$ref` to such a model are distinct from a
direct API boolean schema. This slice rejects a direct request boolean before
normalization, which would otherwise replace false with `{}`; it does not change
generic normalization or recover information already discarded on earlier input.
The response exporter retains its existing object-schema contract. No boolean
schema execution acceptance is claimed.

### Explicit model-name mode

Native import and export now accept the caller option `modelNameMode: "preserve"`.
Owner imports supply it in the request body beside `document`; owner exports use
one `modelNameMode=preserve` query parameter. Each side must select it independently.
Omission or `namespaced` keeps the existing namespace behavior and its export
preconditions. Imported file fields never opt in; no project setting or private
native extension is added. The existing native `name` / effective `display_name`
carry the exact current name in preserve mode (valid Unicode, nonblank, <=200
UTF-16 units). No guessed truncation or prefix removal occurs. Duplicate effective
names reject rather than silently rename. Project renaming and mixed-source names
are thus reversible only when both callers explicitly choose preserve.

The option propagates through directory frozen API conversion and final readback,
without freezing a new model-library snapshot or changing schema execution. Invalid
options, repeated export query options, and options for nonnative formats reject
before persistence. Existing reference-graph and unsupported-data limits remain.
Full Workbench backups continue preserving identity and all names without this option.

### Bounded native signing-auth definitions

AWSv4, Hawk and EdgeGrid definitions now reverse-map only the fields already
accepted by `importExtendedApipostAuth`, with pure importer readback equality.
No signer, credential acquisition or network operation runs during export.
AWS accessKey/secretKey/sessionToken/region/service and optional Boolean
addAuthDataToQuery are retained; query mode remains limited to explicit S3.
Hawk id/key/dlg/ext map to authId/authKey/delegation/extraData. Workbench's default
algorithm sha256 is explicit, and payloadHash default enabled is emitted as
includePayloadHash=true: omission would incorrectly import as disabled. Explicit
disabled emits false. EdgeGrid baseURL maps to the established `baseURi` spelling;
its existing token/secret/header-list/nonce/timestamp strings remain unchanged.

Unknown authentication fields, AWS signingDate and EdgeGrid maxBodySize (even an
explicit runtime-default value) have no proven native slot and reject rather than
vanish. Nonstring timestamps/header arrays and invalid hash modes reject. Optional
missing string fields normalize to the importer's empty-string definition, while
Hawk's runtime defaults become explicit. This preserves supported behavior, not
property-presence identity; full Workbench backup preserves exact stored objects.
Saved secrets can appear in the authorized export; no secret-free claim is made.

The dependency-only base adds existing PR8 and its PR22 S3-query prerequisite to
the prior base, without PR14/root business ancestry. No new library or signing
runtime is introduced. Real fictional localhost tests independently verify AWS
header and S3-query HMAC, Hawk SHA256/hash-enabled and SHA1/hash-disabled MAC,
and EdgeGrid HMAC using node:crypto (not production signer output). Owner JSON and
directory import/export two generations remain network-free until explicit plan
execution; frozen auth survives later live auth edits, backup/restore and restart.
Unrelated projects and input documents stay unchanged; unmapped fields return
owner400 without altering persisted definitions. The first fixture's stale-revision
cleanup PUT was correctly refused by Store; the fixture was corrected, not the
optimistic-lock policy. The old blanket-Hawk rejection test now rejects an unmapped
user extension instead, preserving its unsupported-data error path.

Wire coverage also asserts fixed AWS region/service/date-scope, Hawk timestamp,
nonce/ext/app/delegation, and EdgeGrid timestamp/nonce rather than merely accepting
self-consistent signatures. A Workbench-edited Hawk definition without algorithm
or payloadHash is exported with explicit defaults and authenticates its actual
POST payload after both roundtrips and restart. AWS templated secret credentials
remain templates in exported/frozen definitions and resolve against the selected
saved environment only at explicit execution. EdgeGrid's nonempty signing baseURL
uses a fictional host for the MAC while all HTTP traffic stays on loopback.

## Source-backed TCP/SSE resource graphs (bounded subset)

Native JSON and directory output now support complete source-backed TCP socket
containers with UTF-8 raw socket_method children and GET/POST SSE definitions.
This is protocol **definition** interchange, not native protocol flow execution
or a claim that all imported resources can be exported. WS/WSS, Socket.IO/gRPC,
non-native-created definitions, missing/deleted children, orphan containers,
ambiguous source identities, changed executable names/endpoints/payloads/timeouts,
and stripped or runtime-required handshake credentials reject the whole output.
No history, current credential binding or private metadata is used to rebuild a
secret, and no empty credential is invented. Original inert descriptions, response
examples and accepted configurations remain inert. Export performs pure forward
reimport verification and never connects or sends.

The identity key is the original project ID plus target ID, verified against the
existing deterministic resource factory. TCP containers reserve their exact
canonical folder path rather than also creating a plain folder of the same name.
Directory target and parent IDs use one complete node map, including socket
parents. Known ordinary parent-folder identities are collected before creating
missing intermediate folders; A and A/B work in either input order. Original
ordinary folder names were not archived: their current unambiguous canonical
paths may be remapped, not falsely described as unchanged historical names.
Container names and each executable definition still require exact source-backed
agreement. Unknown/custom provenance notes are not silently discarded.

The first slice deliberately rejects WS, including ws://. Legal static analysis
of send.asar/index.js (SHA-256
`5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`)
shows `rejectUnauthorized: false` at LF-normalized Unicode-character offset
37654343, system-level certificate settings at 37654475, and the resource handshake
timeout at 37667842. These offsets are characters, not bytes or UTF-16 units.
The reconnect setting at 33908681 belongs to another Socket.IO call path and is
not evidence for a WS no-retry profile. No verified resource-only secure TLS /
no-retry profile was established. Copying archived defaults or guessing flags
would not prove safe equivalence; no original application was executed here.

Tests use independently authored loopback inputs, not vendor exports. JSON and
directory each make two pure generations alongside HTTP/document/model resources,
then create and execute Workbench frozen protocol plans, modify live definitions,
and retain execution through backup/restore/restart with project isolation.
Workbench protocol-step plans remain unsupported in native directory flow output;
projects containing such plans still require backup or an explicit separate
supported-definition projection. Frozen execution/backup evidence must not be
reported as native complex-plan roundtrip support. Existing framing, file-count,
4 MiB export and runtime permissions/budgets remain unchanged.

## Bounded frozen HTTP sample and group graph export

The same project exporter now prepares HTTP cases as native `sample` records and
case folders as `sample_group` records, with complete API ownership and parent
identity mapping. Directory output writes real `samples/index.json` and matching
wrapped detail records. Empty groups and numeric group sort values are retained.
Cases are emitted in current effective order (`sort` when explicitly present,
otherwise array position); the importer does not retain historical sample sort
numbers, so this contract preserves order, not those original numeric values.
IDs and source namespaces are remapped, not restored from names.

All four snapshot flags must be true. Unknown case/group/request metadata,
missing/deleted API ownership, conflicting IDs, cross-API/cyclic parents and
unrepresentable fields fail the complete conversion without mutation. The first
slice excludes sample scripts/tasks/functions, schema/response/example metadata,
custom status and SDK URL mode; existing API encoder guards also remain. It
reuses the existing HTTP/auth/body/query mapper and pure importer, not a new
protocol, parser, signer or engine. Current case and request names and API-folder
association must agree. No inheritance graph export is added.

The original-informed importer distinguishes root samples from grouped samples:
only grouped samples include the origin API's own request layer. Therefore both
outputs are forward-imported and their full supported frozen request semantics,
API ownership, group relations and order checked before returning. A live-only
header/query/cookie/form field or task that would be reinjected makes export fail;
disabled children are not invented as masks. Explicit frozen noauth and own body
are retained even when the live API's auth or raw body differs. This does not
promise exportability for every local case. See the existing root-sample and
sample-group import ADRs for legal static-source references; no original app was
executed for this change.

The new cohesive tests cover both formats twice, same-named APIs, empty nested
groups, two source namespaces sharing original sample IDs, effective ordering,
whole-export rejection/no mutation, actual loopback frozen case execution after
live API edits, stored history, backup/restart and source/third-project isolation.
The initial tests correctly encountered the existing multiple-service export
restriction and selected an empty default environment; fixture setup was corrected
without weakening guards. Four new groups and eight complete related files (46 tests) pass locally,
including root-only samples that correctly exclude extra live API headers/query.
Full format/check/diff checks pass. Exact final independent CI remains pending
until the updated PR14 tree is published and verified.
