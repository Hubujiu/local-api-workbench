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

## Recursive dependency join for canonical controls

The isolated dependency branch joins PR44 head
`adc89ac359ebb0999b6f081213693c75878dc0ed` (tree
`cc9c83019d7bd5ea85af0aff57486ab9b79fd4e2`) and PR88 head
`35ee364709386fc69bf47bd4df6521ffa5e6972e` (tree
`6d45fe304a9b4f6a72844403c2b473df7867239c`). Both share develop
`88f70bb515c48b93536b28b7fe3ec780f2e150f3`. PR44 already contains the
native/frozen-plan dependencies recorded in ADR-BOUNDED-PLAN-REPEAT, including
PR41 (PR30/17), PR42, PR43, PR28, PR2 and PR19. No further native-plan feature
branch or attribute/Mock integration ancestry is required for this dependency
join. This commit contains no conditional-control implementation.

PR44's recursive repeat traversal, identities, ordering, budgets, evidence,
protocol leaves and grant consumers remain unchanged. Core snapshot/run and
version admission use the repeat-aware type helper from root commit
`3269b3b99b30b0979a3ee20781fda92b000ced5b`, exact blob
`9cfa37a7830877c3a0eb7d063446f9281e425398`. Restore checks types before generic
plan traversal, while preserving the earlier invalid-runs diagnostic. Both CLI
entry and direct grant helper check types before reading credential input or
registering grants.

Store combines PR88 lock-held, single-retention legacy comparison with root's
bounded inert-input guard before any normalizer. Activity writes retain exact
stored plans, changed/new/duplicated malformed plans reject, and inheritance
identity checks see normalized candidate plans. Historical evidence remains
inert on unrelated saves. This carries only relevant admission/security changes,
not the root runtime's unrelated lifecycle feature implementations.

`tests/plan-step-types-repeat-dependency.test.mjs` selects the 11 applicable
root type/CLI/repeat/Proxy/diagnostic tests without weakening their assertions.
The one root Postman OAuth2 owning-validator diagnostic test is not included:
its independent OAuth2 model is absent from PR44. That original root test must
remain unchanged and be rerun on later root integration. The generic OAuth1/
native OAuth2 accessor and Proxy tests remain included and pass through existing
repeat data validation; they do not assert token-policy feature support.

Initial focused verification passes all 9 unchanged PR88 owner/MCP/legacy
retention tests and all 21 selected admission/basic-recursive-repeat tests.
No original application, VM, proprietary bytecode, REA or full CI was run.
