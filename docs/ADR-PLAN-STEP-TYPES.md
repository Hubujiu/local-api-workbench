# Explicit plan step type admission

An unrecognized linear step discriminator previously fell through to HTTP in
both snapshot normalization and execution. A synthetic loopback POST reproduced
an actual request and a passed run after `snapshotPlan` silently removed the
unknown discriminator. Owner plan creation also accepted it with HTTP 200.

The supported linear discriminators are absent/undefined (historical HTTP),
`http`, `grpc`, `socketio`, and `protocol`. Null, empty strings, differently cased
aliases, other strings and non-string values reject. Validation is whole-batch,
including disabled leaves, before cloning or interpretation. Accessor and Proxy
discriminators reject without invocation. Existing protocol validators retain
responsibility for each supported protocol's configuration and authorization.

Snapshot, direct execution, versioning before binding resolution, Store save,
and backup restore share this admission boundary. Restore also checks every
historical run snapshot before the existing retention truncation; it does not
normalize or rewrite historical evidence. CLI admission occurs before waiting
for runtime credentials on stdin. This is not a new grant or transport feature.

This feature is based on develop 88f70bb515c48b93536b28b7fe3ec780f2e150f3.
That baseline has no repeat groups or CLI database-grant helper. Integration
with PR44 must retain its complete recursive repeat validation, including
children under disabled ancestors, and apply the same leaf admission contract
before any work. Do not simply add `repeat` to this linear allowlist. PR79/81
script validation and PR2 grant preparation require their existing ordering to
be retained, with admission before binding or registration. Those integration
contracts are separate from this feature's tests.

Invalid previously stored linear discriminators now fail closed on save/run
instead of being silently interpreted as HTTP. Already normalized historical
HTTP snapshots without a discriminator remain valid; no migration invents the
lost original type. Existing empty-plan behavior is unchanged.

Tests use synthetic inputs, isolated temporary storage and real loopback HTTP.
They cover invalid snapshots/restores, no earlier request before a later invalid
step, disabled invalid steps, zero getter/proxy calls, historical snapshots past
the retention boundary, owner plan POST/project PUT/restore rejection, unchanged
stored projects and project list, and valid HTTP execution after app restart.

A malformed legacy plan cannot be silently edited under the same identity:
versioning also snapshots the prior definition and therefore rejects it. The
controlled owner recovery is to retain a backup of the original definition,
explicitly replace the malformed plan with a reviewed valid plan under a new
ID through project PUT, and review any caller references. This does not rewrite
historical run evidence or execute either plan. The real owner regression tests
same-ID rejection and explicit new-ID replacement. A malformed historical run
snapshot instead requires deliberate backup repair; it is never normalized away.

Compatibility correction: stored inert history is not executable input and is
not revalidated by Store.save. Restore preserves null/absent/step-less snapshots,
but checks any snapshot with a defined steps collection before retention. A real
regression demonstrated that blanket validation let an unrelated valid HTTP run
finish before its evidence save failed. Store now admits unchanged malformed
legacy plans only by exact deep comparison against the current disk project
while holding its lock, after the existing conflict gates. Any newly added or
changed malformed definition still rejects. Activity writes cannot change the
plans collection and inherit the lock-held disk plans without normalization.
Thus unrelated execution can record evidence without rewriting an inert bad
plan. Owner versioned edits remain strict; explicit replacement under a new
identity is the supported repair path described above.

## Integration adapter

The combined tree retains PR44 repeat validation, recursively including disabled
ancestors. The new admission checks only array/node/type/child-step descriptors and walks
all descendants, including disabled ones, with a four-group-depth and 100000-node
ceiling. Existing complete repeat validation remains in the original snapshot,
execution and grant paths. Request/auth payloads are deliberately not inspected
by the type pass: Postman OAuth2 and repeat-data validators keep their existing
diagnostics and accessor protections. This ordering avoids the initial generic
repeat-data rejection masking more specific OAuth diagnostics.
CLI database-grant preparation now performs admission before reading connections.
Root Store moves plan normalization to its lock-held save stage; conflict gates
run before retaining any exact unchanged legacy definition. Native inheritance,
resource-trash identity and history validation remain in place. These combined
owner/Store workflows need exact-root CI where all locked dependencies exist.

Repeat input additionally receives a separate descriptor-only data safety scan:
it rejects data-valued Proxy descendants, cycles, excessive depth and node work
before existing validators can observe them. It never evaluates accessors and
leaves ordinary accessor diagnostics to their existing OAuth/repeat validator.
Thus preserving diagnostic precedence does not reintroduce Proxy trap execution.
