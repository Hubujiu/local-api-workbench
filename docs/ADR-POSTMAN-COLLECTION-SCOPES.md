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

## Model/import checkpoint (WIP)

The initial model and owner opt-in path now allocate and validate registry/bindings,
retain them through normalizing/restoring, and reject lossy OpenAPI output. Four
standalone pure JSON-model tests pass locally; core/server/Store syntax checks pass.
These tests import no app/VM code. Actual owner import/save/restart remains CI-pending.
Bound collection execution deliberately rejects with a WIP error until the complete
scope pipeline lands, rather than accidentally running with the old variable layers.
The registry uses the existing metadata journal and rejects active missing-value,
external/secret and non-finite inputs; original duplicate/disabled editor rows are
not promised as an archival representation. No old import mode is migrated.

## Scope pipeline checkpoint (WIP)

Host-private collection execution sessions now select A/B/A layers, with request
and returned-scope identity checks before stage commits. Collection diffs use the
same expected-old-value transaction and exact cancellation signal as existing
scopes. Registry definitions retain initial values for updates of the same type;
unset/clear deletes a variable definition, so a later set creates a new any-typed
variable. get/toObject return copies. The small facade is self-contained pure code
serialized into the existing worker; it is not a host-object bridge or new engine.

Owner/SDK debug requests use collection-aware cache keys and fingerprints including
the original (even shadowed) collection values and types, while unbound fingerprints
stay byte-compatible. cURL resolves project context; the context-free formatter
rejects unresolved bindings. Load requests reject bindings before execution.
The initial WIP execution refusal is replaced by this wiring, not by fallback to
old flattened values. Real behavior remains unverified until workflow CI.

Local inspected pure tests: model4 + scope/facade6 + existing cancellation5 + CAS3.
The newly added shadowed-collection cache assertion initially failed (twice while
the source replacement had not applied), then passed after the fingerprint included
the actual collection layer. This is pure regression evidence, not application or
VM execution. No assertion or execution budget was changed.

## Complete workflow specifications (CI pending)

The new ordinary workflow files are syntax/format checked only, not executed
locally. HTTP and stdio each exercise owner import, effective scope/falsy values,
seven facade methods, true curl wire, SDK saved A/B/A plans, live rebinding,
backup/restore/restart and actual CLI execution with unchanged old snapshot hash.
The same chain checks denied projects, legacy default imports, source/disk rejection
atomicity, lossless backup and unsupported exports/load. Owner script exceptions,
identity forgery and concurrent same-field edits retain real completed responses
while refusing uncommitted variable stages.

Separate owner/HTTP/stdio cases use the existing test-only real Store lock gate
for both pre- and post-stage cancellation. Pre-stage cancellation sends no main
request; post-stage retains the admitted pre-commit and actual response, rejects
queued new scope changes, persists terminal evidence, restores and restarts without
replay. The preload is the existing main-thread-only fixture. Production transport,
Store locks, script engine and budgets are not replaced. PR17 typed uncertainty is
not present on this dependency base and remains an explicit root composition test.

## Root composition: bounded cross-feature acceptance

The feature's first normal CI 40864878554 passed on the dependency base (source
`ddd106365546574511265d2a9d20035dd7ad2dfc`, tree
`d801f80da8974b3738966fe852aadc1ba238ff5f`). This is not root acceptance.
Root integration retains canonical `planLeaves`/`planOccurrences`, existing
ordinary-step identities, protocol/native guards, Postman response media handling,
Store typed commit outcomes and all prior cancellation tests. Engine and safety
budgets are unchanged. Native JSON and directory exporters now reject collection
registries/bindings at their outer entrypoints, before lossy projection can occur;
this is an explicit unsupported boundary, not a native collection mapping.

Three additional root-only CI specifications cover:

- Actual owner-created repeat A/B/A twice, SDK execution, unique occurrence
  identities, current collection values with unchanged frozen request bindings/hash,
  and backup/restart followed by explicit execution in an isolated restored project.
- Both native formats through direct, owner, HTTP and stdio SDK export entries,
  rejecting even unused registry data without project/disk/network side effects;
  full backup restoration remains available.
- A real admitted Store journal whose apply fails on an owned filesystem obstacle,
  then a later execution abort. The completed response and typed unknown/non-retryable
  receipt remain truthful; the failed result append is not claimed saved. Repair,
  read recovery, backup restoration and restart do not replay the request and retain
  the collection's admitted changes and original initial definitions.

The last check is transaction admission, not an atomic abort guarantee through
physical journal publication. Historical evidence is never rewritten. The existing
root typed-uncertainty case is unchanged. These application workflows are only
syntax/format checked locally; actual root acceptance awaits its own ordinary CI.
