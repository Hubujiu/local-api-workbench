# Debug variable publication generations

Single-request execution starts with a detached runtime variable snapshot. Its
response, extracted values and history remain evidence of that execution. They
must not overwrite a later manual runtime edit or repopulate a cleared session.

A private ticket captures the cache instance, entry identity and project-clear
epoch before execution. A completion publishes only if all still match. Manual
writes replace entry identity, even when the JSON value is unchanged. Clear
advances a project epoch even when no cache entry existed, preventing absent-entry
ABA. Overlapping requests use first **successful cache publication** wins; losing
publication does not suppress the actual response/history or retry any request.
Existing response eligibility and persistent scope writes are unchanged. The
final persisted-variable fingerprint still reflects legitimate scoped writes.

The WeakMap registry allocates nothing on reads; only clear retains one epoch per
cleared project until the owning cache is collected. There are no per-environment
tombstones, pending-run registrations or serialized generation fields. Existing
runtime entries retain their prior cache lifetime. Runtime is separate from saved
environment definitions; execution history intentionally retains its own evidence.

## Verification boundaries

Pure identity/epoch tests cover same-value edits, clear-before-first-entry ABA,
concurrent stale publication, project/environment isolation and distinct cache
instances. Real delayed-loopback owner and official HTTP SDK workflows are
provided without scripts or external services; official stdio covers sequential
cache persistence and restart. Owner export/restore verifies no live runtime
state enters saved environment definitions. These workflows are authored for ordinary CI and
**not executed locally** under the current execution restriction. No local RED or
end-to-end pass is claimed. Syntax, formatting and inspected pure tests are the
only local execution evidence.

The develop base has no native MCP aliases, concurrent stdio dispatch or
explicit save receipts. This isolated feature does not import those
unrelated features. Combined-root acceptance must supplement those entrypoints
and backup behavior on its exact tree. No deployment, merge or full parity claim.
