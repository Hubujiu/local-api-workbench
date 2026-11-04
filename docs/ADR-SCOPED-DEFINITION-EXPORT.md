# Scoped definition export (WIP)

## Behavioral basis and scope

Read-only inspection of the official Offline 2.0.0 work bundle established a
resource-selection export flow: snapshot, API/sample/model/environment selection,
ancestor completion and native JSON output. The inspected work.asar SHA256 is
36c1f506f9dbee4eef487248874c1f2a061451eebfa9f6cad1735441cc8553fd;
its index bundle SHA256 is
20bb6e21fd678ead16bd91807dc9623b8cd3e7019d44ac874a167c31a37f39fb.
The selected-scope adapter is module 258928, index byte range
[2774503,2789424); the selection UI is module 513101, [880565,890580).
Only independent behavior is implemented here, not vendor code. No original
application, proprietary bytecode or license module is executed.

The original empty-selection fallback exports the whole project. Environment
empty-selection also keeps all environments. Model discovery precedes the
sample-to-API completion and does not establish a transitive model closure.
These are not safe defaults for a new backend contract and are not reproduced.
The original selected-scope flow does not select saved plans; this module does
not add plan selection or claim complete original-project migration.

Existing full owner GET export and localapi_export_project remain unchanged.
This feature adds an independent read-only preview and export flow for the two
existing native formats, apipost and apipost-directory. It does not add Swagger
versions, new frontend UI, import semantics, a backup format or persistent grants.

## Explicit scope

Selection is either {mode: "all"} for all selectable live definitions, or
{mode: "explicit", resources: [{kind, id}], exclude?: [{kind, id}]}.
The latter requires a nonempty resources list. Unknown, duplicate, cross-kind,
deleted or missing identities fail. Empty lists never become a whole-project
export. Explicit exclusion of a required dependency fails instead of silently
overriding the exclusion.

Selectable kinds are API, document, API folder, sample/case, sample folder,
model, model folder, environment, project globals and indivisible protocol or
collection bundles. An explicitly selected API folder expands its live subtree;
this is an explicit Workbench contract, not an inferred original backend API.
An explicitly selected folder is an indivisible subtree in this first slice; excluding one of its descendants is a conflict. Samples include their live API and ancestor groups. Schema references include
their transitive models and model ancestors, without expanding recursive schema
values. Literal example/default/extension data does not create references.
Unknown external, dynamic or name-dependent semantic bindings fail at their
actual declaration positions. Partial native inheritance or protocol source
graphs must remain complete or fail, never lose authority metadata to export.

Project settings affecting selected definitions remain present. Globals are an
atomic dependency, not guessed variable-by-variable from dynamic scripts. Their
inclusion and any required environments are visible in preview and must be
accepted before export. Static HTTP authentication can remain in output under
the existing native exporter contract; preview reports that risk without showing
secret values. Database catalogs require explicit databaseMode: "rebind" and
keep the existing credential-free output. No runtime credential/grant is read.

Definition history, execution records, trash, directory archives and saved
plans are not selectable live resources. New scope "all" is all supported
definition kinds, not a complete project backup. Existing backup export remains
the only full-state export route.

## Snapshot, permissions and output

Owner POST export-preview and POST export-selection share the same bounded
planner. Preview returns metadata, inclusion reasons, dependencies and a digest,
never the artifact. Export requires the matching configRevision, digest and
complete accepted dependency identities. The digest binds actual format/options
and output; any changed resulting artifact requires a fresh preview. It is a
consistency check, not an authorization token. Each request rechecks ordinary
owner or MCP project access. No new write/execute permission is needed.

The final conversion still uses existing native exporters and their readback
checks. An unsupported selected definition, required setting or ambiguous graph
fails closed. A provably independent unselected resource does not poison the
requested scope. The source project, peer projects, history, revisions, registry,
execution counters and runtime settings stay unchanged on success and failure.

The source graph has at most 10000 resource identities and 50000 dependency edges.
Selected definitions have a 32 MiB, 64-level, 200000-value projection budget;
reference declarations are limited to 8192 UTF-8 bytes and 64 pointer segments.
Literal example/default data is not interpreted as a reference. Unselected
large payloads and execution history are not deep-cloned to apply these limits.
Preview shows resolved model-name and database-rebind options (null means no
explicit database export approval).

Native documents retain the existing 4 MiB and directory 5000-file bounds. MCP
retains the 4 MiB document and 8 MiB complete encoded frame bounds. A large
unselected resource or unrelated history must not acquire a new save/read limit.
MCP preview also validates the complete future artifact frame using the worst encoded permitted request ID, before removing the artifact from the preview response.
No host file reads, URL retrieval, scripts, Mock, signing, database connection or
HTTP execution occur during preview/export.

## API sequence

Owner routes are POST `/api/projects/:id/export-preview` and
`/api/projects/:id/export-selection`; they accept no query parameters or extra
path. MCP names are `localapi_preview_project_export` and
`localapi_export_project_selection`, with the same body plus `projectId`.

Preview input: `format`, `selection`, optional `modelNameMode`, and optional
`databaseMode: "rebind"`. `selection` is `{mode: "all"}` or
`{mode: "explicit", resources: [{kind: "api", id: "saved-id"}], exclude?: []}`.
Kinds use the lowercase names listed above: `api`, `document`, `folder`, `case`,
`case-folder`, `model`, `model-folder`, `environment`, `globals`,
`protocol-bundle`, `collection-bundle`. Folder IDs are full saved paths. Fixed
bundle IDs are `configuration`, `definitions`, and `registry`, respectively.

Export repeats the original input and adds the returned `configRevision`,
`scopeDigest: preview.scope.digest`, and the exact typed identities from
`acceptedDependencies: preview.scope.dependencies`. Dependency order is not
significant; missing, extra and duplicate identities reject. Preview includes
scope reasons, omitted categories, resolved options, document byte count and
warnings. Only the successful export response includes `document`. Errors never
fall back to a wider selection. A changed config or artifact requires preview
again; no preview token is persisted.

## Required acceptance

- Real owner and official SDK HTTP/stdio preview/export, read-only authorization,
  revocation, archived and cross-project refusal, stale preview and exact errors.
- API and sample ancestry, model transitive/cyclic references, literal false
  positives, bundle boundaries, explicit exclusions and global credential warning.
- Both native artifacts roundtrip through the real public importer, persist and
  reopen with the selected semantics, without source mutation or side-effect replay.
- Existing full exports remain unchanged; unsupported selected metadata remains
  rejected, including raw-media, auth and DB policies with no verified mapping.
- Descriptor/Proxy/size/depth/node/frame boundaries and zero execution counters.

The first checkpoint recorded three real missing-route owner failures. The
implementation now has actual graph, owner and official SDK HTTP/stdio acceptance,
including selected recursive models, source/peer immutability, cancellation and
revocation during a real locked Store read, persistence/reopen and complete-frame
limits. Independent review corrected Proxy/getter reads, empty-folder authority
loss and preview approval of an oversized artifact. The first implementation CI
also exposed the old exact tool inventory (50 rather than 52); the fixture now
asserts both new tool names while retaining its complete lifecycle/grant checks.
This is still a draft until its final exact commit has passed CI and independent
review. Local test totals are not a feature-completion percentage.

Errors do not echo arbitrary Store error values. The adapter consumes persisted
ordinary JSON and does not execute accessors or Proxy traps; this is not a
serializer for arbitrary live JavaScript objects. Native Promise assimilation
of a caller-supplied async Store is outside that synchronous data boundary.

## Combination with two-step manual import

The separate integration candidate composes this feature onto accepted manual
import integration `6e193775b5a84aed34b82bc47b777f37d1602c68`
(tree `44bb25d25e3d0e794ab6c3fb461697ed16735a71`). The import planner,
session-bound token, Store and journal implementation are unchanged. HTTP and
stdio retain both tool families' cancellation leases; only import apply requires
write access. Full canonical/native inventory is 54/30, with 84 unique names.

Scoped export allocates no import token and consumes none. Applying an import is
a configuration change and invalidates an older export preview. Ordinary Store
reads retain their established recovery semantics: a previously published
journal may roll forward, but export itself creates no configuration commit or
new execution evidence. Transport observability is not project definition state.

The initial combination is WIP. New cross-workflow assertions and exact combined
CI are required independently of the feature's local and CI results. No main
merge, release or deployment is implied.
