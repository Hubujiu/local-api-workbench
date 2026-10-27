# Explicit native HTTP inheritance graphs

Status: implementation in progress; no complete delivery or original-runtime
equivalence is claimed. This independent feature depends on PR14's native JSON
and directory exporters (including PR8's active-auth codecs), not root integration.

## Entry and authority

`importIntoProject(project, document, {inheritanceMode: "preserve"})` and the
owner HTTP import endpoint opt into this mode. Omission or `"flatten"` retains
the existing import-time snapshot behavior. Unknown modes reject. Preservation
requires an empty business project: no requests, folders, plans, cases, documents,
models, protocols, history, custom settings or global/environment values. A sole
pristine default environment created by Store is replaceable by imported source
environments. Existing project identity and authorization do not change.
Neither preserve nor ordinary import may append to an already preserved graph.
Old flattened projects cannot recover discarded parent values and are not
automatically upgraded. Imports never execute requests.

Only native modern JSON and directory HTTP APIs/folders are in this first mode.
Project/folder/API auth and Header/Query/Cookie layers and the existing global and
environment variable catalogs are supported. There is no invented folder-variable
field. Non-HTTP resources, samples, execution flows, tasks, shared functions,
inherited bodies, files, active system-row flags, ambiguous duplicate rows and
unsupported metadata reject rather than flatten. Other default-mode features are
unchanged.

## Active definitions, not an inert archive

`settings.nativeInheritance` is a bounded, versioned graph containing its source
namespace, a project layer, folder identities/parents/paths/layers and explicit
API bindings. Each live API retains only its own ordinary parameter/auth values
and a `nativeInheritance` binding with original auth intent: absent, inherit,
none or own. Disabled rows remain disabled; unlike ordinary Workbench masks,
disabled native children do not remove active ancestor rows. Header identities
are case-insensitive; Query/Cookie identities are case-sensitive. Active child
rows override their ancestor group in declaration order.

Only the selected provider's mapped canonical auth fields are retained, never an
entire auth editor object with inactive-provider secrets. A pure resolver applies
the same graph rules for import validation, live requests and freezing. Parent
edits change later live resolutions. A freeze writes the effective request,
removes its live binding and blocks ordinary target shared settings from being
injected a second time. Existing frozen plans do not acquire later graph edits.

Graph identity is resolved only inside the supplied current project. Historical
source IDs are not project authorization and do not index a global registry.
Restore-copy projects may share historical source IDs without sharing values or
credentials. Store/save and restore validate the entire graph, all binding IDs,
source namespaces and folder paths before persistence. Missing or forged bindings
cannot silently become ordinary requests. Move/delete relationships not yet
implemented are rejected atomically, not repaired by recreating source nodes.

## Round trip and limits

Native export automatically preserves a saved graph; omitting an export option
must not discard it. It emits project and folder layers plus each API's own layer,
not the effective flattened request. Reimport in preserve mode must retain graph
intent and effective requests over two JSON/directory generations. Existing native
export limitations remain explicit. Successful export is not a backup of runs or
an execution grant, and its auth/header/variable definitions can contain secrets.

The source envelope remains limited to 4 MiB. This first graph is limited to 100
folders, 1000 APIs, 30 ancestor levels, 100 rows per parameter kind/layer and 256 KiB
of graph metadata/shared definitions. Existing auth, request, transport, script
and storage limits are not increased. No new library or host capability is added.

## Evidence and acceptance

Static format evidence is the already acquired official Offline2 2.0.0 directory
mapping (`global_params.json`, `apis/*` records) and send adapter module 842216.
Existing code evidence is `apipost-modern.mjs`'s ancestry/active-row/auth rules,
`apipost-import.mjs`'s codecs, `apipost-directory.mjs`'s assembler and PR8's noauth
target-isolation behavior. No original executable is run or proprietary code
copied. This is a bounded current-importer semantic profile.

Acceptance uses fictional credentials and real loopback HTTP: project/two-folder/
API inheritance, explicit noauth, disabled children, parent edits versus frozen
requests, two variable environments, two export/import generations, saved graph
and result evidence, backup/restart and same-source-ID project isolation. Bad
graphs, nonempty target, unsupported source and partial CRUD must yield zero
network and no partial Store mutation. Owner execution, existing MCP execution,
CLI frozen plans and cURL must agree or reject explicitly. The optional import
argument for PR29's separate MCP interchange feature is a later composition
adapter, not a reason to import root feature ancestry into this branch.

## First implementation checkpoint

The graph resolver runs before generic shared defaults in owner execution,
load execution, canonical MCP execution and plan creation; cURL uses the same
resolver. Raw transport and snapshot constructors reject unresolved bindings.
Previously saved frozen steps can be edited without reconnecting them to the
live graph. Store saves reject removal/reparenting/replacement of graph identities;
value-only parent layers and own request configuration remain editable. Restore
validates the graph entirely inside the restored project, with no cross-project
registry or grant implied by a source identifier.

A frozen request is **the request configuration merged at that time, with the
live graph binding removed**. It is not a frozen environment: placeholders are
still resolved against the selected environment/global variables under the
existing execution contract. Editing a parent literal does not alter old frozen
configuration; editing an environment variable may affect an old snapshot.

Native graph export automatically preserves the graph (no opt-in export switch).
This first slice explicitly rejects native export with plans/cases/case groups;
full project backup retains them. Export/reimport the graph first, then construct
and execute frozen plans in either generation. The default flatten mode's existing
sample/flow/protocol capabilities are unchanged. Parent Query/Cookie encoding
switches, shared bodies and request-internal descriptions are rejected rather than
silently discarded. A Store-created untouched default environment (including its
known loopback `baseUrl`) is treated as pristine and replaced on import.

Current local acceptance covers both native formats over two generations, actual
owner HTTP/cURL/canonical MCP execution, parent edits versus frozen configuration,
0/false/empty environment interpolation, explicit noauth, same-source-ID project
isolation, Store roundtrip/backup restoration and invalid-graph fail-closed paths.
The final local workflow also covers an absolute-URL/no-service graph via official
SDK HTTP, safe temporary input overrides, invalid binding/flag overrides with zero
network, closing/reopening the owner server, and a separate CLI child executing a
stored frozen plan against a selected environment. A restored case snapshot can be
edited without reconnecting to its live graph.

MCP temporary input for a preserved bound API rejects a selected parameter name
matching more than one effective row (Header case-insensitive; other kinds
case-sensitive), including active-parent/disabled-child pairs. The check retains
trusted stored-API context across freezing and also covers native-compatible plan
construction. Unique matches retain existing semantics. Ordinary/flattened APIs'
pre-existing multiple-row override behavior is unchanged. This restriction does
not make disabled source rows into masks or change the stored graph.

A non-default empty environment is not pristine: only the exact Store default
shape may be replaced. Reads as well as saves/restores validate graph closure;
manual graph damage on disk fails closed, rather than silently running own-only
requests. No partial resource detach/move/delete operation is implemented.


### Saved frozen-case execution

A frozen case retains its original request ID but has no live binding. Direct
owner execution, cURL/load and creation of another plan may reuse it only when
the complete request exactly matches an already saved case or plan snapshot in
that same project (and all four snapshot flags are present). Flags or ID alone
do not establish this context. Unsaved modifications must first go through an
existing case/step edit context; this does not reconstruct parent values. Actual
HTTP acceptance covers create case → parent edit → saved case execution and plan
creation → backup restore/server restart → execution, with a changed-field fake
rejected before network. Environment placeholders remain dynamic as above.

Preserved-graph case records must also associate `sourceRequestId` with that same
request ID in the current bound graph; inconsistent associations reject at Store
save/read and backup restore, before execution.

## Bounded text form layers (same graph version)

Graph version 1 layers optionally add `form` text rows. An absent field means an
empty layer; validation and export do not mutate older stored graphs. New imports
emit explicit arrays. Own API `form` stays separate; project/folder rows use the
existing bounded text-row codec and native active-child override merge. Inactive
children remain editable but are not canonical masks. Existing duplicate/system
row restrictions remain. API body mode selects urlencoded or form-data; a parent
accepts only absent/none mode and cannot choose a child's mode. A nonempty parent
form requires an explicit non-GET/HEAD form API. Raw/JSON body inheritance, binary,
files, schema-generated bodies, part media types and unsafe multipart field names
remain rejected. Multipart cannot carry an explicit active Content-Type in any
contributing layer; urlencoded permits only absent or standard
application/x-www-form-urlencoded. These restrictions apply to inherited-form
graphs, not ordinary flattened requests. The existing transport supplies the
multipart boundary; equal field semantics do not mean identical random bytes.

Legal static sender index.js SHA256
5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff,
module842216, LF-normalized Unicode-character offsets (not bytes/UTF16):
33601767 body joins the inherited parameter kinds; 33611539 selects API body
mode; 33611786 consumes effective form rows; 33613405 disables source SDK body
pruning. This last observation does not authorize GET-body parity. No original
runtime execution or proprietary implementation was copied.

Import compares effective form/bodyType to the existing modern converter before
publishing. Export checks both original own rows and each graph layer after full
forward reimport, including older graphs without form. The preserved graph's
existing MCP ambiguous temporary-input guard also applies to effective form rows
in execute_api and native flow creation/update; default flattened behavior stays
unchanged.

The new whole workflow covers two formats and two generations for both body
modes, UTF8/empty/special values, nested scopes, live edits versus frozen case/plan,
real SDK calls, CLI, backup and owner restart. Unsupported source inputs are
rejected atomically. Initial local failures exposed a missing allowance for the
existing encoder's inert binary:null field (nonempty binary still rejects), then
a test incorrectly referenced src/cli.mjs instead of the actual run-plan entry;
both were corrected before the first five-case PASS. Final CI remains pending.


### Review corrections before final form acceptance

The first form stage f45c1d2b / tree ff6a8228 passed its own CI 40526742319,
but subsequent ordinary-entry review found two real gaps; that green is not the
final acceptance. Owner execution froze before canonical method normalization,
so lowercase get/head and omitted/empty methods could admit inherited forms.
The narrow inherited-form guard now requires a string method and applies the
same default/uppercase interpretation; owner and Store negatives first failed,
then passed without network or disk changes.

MCP header overrides enable even disabled rows. For preserved graph form APIs,
temporary Content-Type is therefore restricted by the actual effective/frozen
base body mode: multipart cannot enable a declared Content-Type, and urlencoded
only accepts a standard string value. This deliberately includes own-only forms
on preserved graphs, since an older frozen flow must not lose protection when
live ancestor form rows are subsequently removed. Ordinary flattened APIs keep
the existing contract. No new caller-trusted flags or live re-resolution of old
flow bases are introduced. Official SDK execute/create/update negatives cover
existing enabled urlencoded and disabled multipart Content-Type rows, including
old-flow updates after live parent rows are cleared; a standard urlencoded patch
remains a real-wire positive. The SDK negatives were also RED before this guard.
