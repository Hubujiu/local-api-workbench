# Opt-in Postman collection variable scopes

Status: contract frozen; implementation WIP, not accepted. No application or VM
workload has been run locally. Ordinary CI owns real workflow verification.

## Dependency boundary

Functional branch: `feat/postman-collection-variable-scope`.
Base: `deps/postman-collection-scopes`, local
`37a715782535d1d6616646864024591458093268`, tree
`934650b9c0134f13e300051cb0535e3a0c18895b`.
Its parent is PR19 local `3744196b294fe2d09fa7c77b4fbe06eafa362e11`,
remote `ad06548d96dd7c338bc2caaaf02de55a69d6edb8`, exact source tree
`6e13bc6d6ad9ecc82afe0cd543eaa60ed3d73cad` (not a CI merge tree).
The sole added dependency is PR65 local `b1e8b75739ae21d85b649087e90e00ea1ea1e72c`,
remote `c26d8b90cca6f546e0d05d2d160ff6209d90caaa`, tree
`59907790ca836467e46f7994f6c523157b94ce7a`. Its CAS changes were composed
with PR19 cancellation, progress and persistence receipts, not substituted for them.
PR19 already carries PR3's cumulative-budget prerequisite. No integration-root
ancestry, native exporter, new package, engine or budget change is included.

## Public evidence and scope

This is a Postman compatibility enhancement, not proof of an Apipost original
collection scope. Apipost's environment.getCollection means an environment view.
Primary references:
- https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-variables/
- https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json
- https://github.com/postmanlabs/postman-collection/blob/develop/lib/collection/variable-scope.js
- https://github.com/postmanlabs/postman-collection/blob/develop/lib/collection/variable.js

`postmanVariableMode: "collection"` opts an owner import into the new model.
Omission or `"environment"` retains the old independent-environment import,
including old projects, tests, frozen plans and history. Unknown mode, non-Postman
input or synchronization in collection mode rejects before mutation. No heuristic
migration from environment names, source IDs or folders is permitted.

`project.postmanCollections = {version: 1, items: [...]}` stores project-local
collection identities, names, current variable maps and initial definitions/types.
Every import allocates a new identity even for the same source collection ID;
requests bind through optional `postmanCollectionId`. Empty collections also get
an identity so their scripts can create variables. The property `collections`
remains reserved for the existing disk manifest. Registry data travels in the
existing project metadata/journal; no new path or external storage is discovered.
At most 100 collections, 10000 variables in aggregate and 4 MiB registry JSON;
existing project/request/VM/frame limits remain unchanged.

Variables use the v2.1 string/boolean/number/any types (default any), with bounded
JSON values and finite numeric conversion. Active variables without a value and
unsupported external/secret resolution reject. Last enabled duplicate wins,
disabled rows do not mask enabled rows. Only the effective definition is imported;
this is not an archive of disabled/duplicate editor rows. Names retain existing
prototype-key exclusions. Missing, null, false, zero and empty values are not
conflated. Script writes preserve an existing variable's type; newly created
variables use any. No cloud shared/local value or Vault support is promised.

## Execution and freezing

Effective order: request-local > existing run/debug/CSV override > selected
environment > bound collection > project globals. No folder-variable scope.
The environment remains independently selected. Existing apt aliases, local
variable lifetime, globals and environment contracts do not change.

pm.collectionVariables supports get, has, set, unset, clear, toObject and replaceIn.
Reads access only this collection and copies do not leak mutable host objects.
Unbound reads see an empty layer; writes reject rather than create a project-wide
implicit collection. The host fixes collection identity from the normalized frozen
request. Script-produced identity changes cannot redirect reads or commits.

Frozen definitions retain collection identity, not variable values, exactly as
existing environment placeholders remain runtime values. Live rebinding does not
rebind old cases/plans; existing unbound snapshot bytes/hash remain unchanged.
A mixed A -> B -> A plan switches only the collection layer, not runtime/global/
environment layers. Switching is not a mutation. Initial execution scope copies
are private; other collections are never exposed to the VM. References are checked
before effects; removing an in-use collection rejects. Old execution evidence is
read as historical data, not rewritten or newly renumbered.

Collection changes join the same stage transaction and compare-before-value
persistence as globals/environment. Failed scripts publish no half-stage values;
pre-script commits precede network send and survive later network errors.
Cancellation is forwarded to Store admission, not claimed atomic at physical
journal publication. Admitted writes may commit after cancellation. No post-success
abort throw, unsafe retry or replay is introduced. History saves remain unsignalled.
Debug keys/fingerprints include collection identity and values while preserving
PR65 generation/entry CAS. Load mode must use isolated copies or explicitly reject
collection-bound requests before any effect; it must not silently flatten scopes.

## Interchange and isolation

Backup/restore/restart preserves registry and all live/frozen references inside
the restored project. Equal historical collection IDs across projects do not share
values, grants or storage. Hostile/missing references reject before persistence.
Existing history remains evidence, not an execution grant.

cURL export resolves the selected collection/environment into a request snapshot;
it is not a scope backup. OpenAPI cannot express this layer and rejects a bound
request/project instead of silently dropping it. Root native JSON/directory
composition must likewise reject; this feature base has no native exporters.
No new Postman collection exporter is claimed. Existing native-only MCP import
must not be widened implicitly; owner imports feed existing authorized SDK flows.

## Acceptance (pending)

One coherent owner/official HTTP SDK/stdio/CLI fixture must cover two collections,
two environments, globals, inherited scripts, all seven API methods, falsy values,
A/B/A isolation, cURL wire equivalence, freeze/rebind, save/restart and restored
execution without replay. Negative fixtures cover source/mixed import atomicity,
forged references/identity changes, same-name concurrent writes, cancellation while
queued, denied project access and unsupported exports. Root additionally verifies
native rejection, PR17 typed uncertainty receipts and PR65 stale cache publication.
Keep legacy/default import and existing scope/cancellation suites intact. Pure
helpers may be tested locally after dependency inspection; app/VM/DB/XML workloads
and stress tests are not locally authorized. No passing claim until exact CI proof.
