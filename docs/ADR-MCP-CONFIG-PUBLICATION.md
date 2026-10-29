# MCP remembered policy publication (work in progress)

## Defect and scope

Within one running workbench, an older auxiliary remembered-config write can
finish after an owner disables, rotates or forgets MCP access. Atomic rename
alone does not order policy transactions: disk can retain the old bearer and
grants while memory reflects revocation, then restart restores stale access.
The existing persistence test only exercises sequential changes.

## Contract

A per-app coordinator serializes complete owner policy transactions: validate
current active projects, compute policy, persist it, then synchronously publish
memory and invalidate existing temporary grants/sessions. Queue order is the
order admitted after parsing input. A failed task rejects its caller but never
poisons the queue. Failed pre-commit persistence does not publish a new policy.

Auxiliary canonical project-create saves carry policy identity and read current
state only when admitted. An old dispatch must not persist or promote its old
project array into a replacement policy. Native-created project grants remain
session-only. Same-policy successful creates are retained together.

Archive save, its existing commit-aware revocation, and remembered policy save
share this queue with owner config changes. Other project writes do not. Owner
validation rejects missing, archived or unreadable projects, so a queued stale
selection cannot restore an archive-revoked grant. Unarchive never grants access.
The existing archive uncertainty classification must remain intact in root.

Temporary config files are cleaned after failed writes/rename without hiding
the primary error. Existing opt-in persistence, token generation, write/execute
permission requirements and port-conflict behavior remain. No real credentials
or external account configuration is involved. This is per-app ordering, not a
claim of cross-process root locking, transactional project+config storage or
crash-proof atomicity across these separate files.

## Required acceptance (not yet run)

Deterministic coordinator barriers establish both queue orders: an auxiliary
write held before rename precedes a pending disable/rotate/forget; an old
auxiliary queued behind owner publication skips after identity changes. Never
wait for a queued owner to finish before releasing the earlier barrier.

Actual filesystem and owner HTTP/MCP SDK workflows use synthetic managed roots:
remembered enable, two canonical creates, denied other project, disable/rotate/
forget, archived project, restart, old bearer rejection and preserved unrelated
policy. Include pre-rename save failure, recovery by a later explicit owner
change, and no replay of successful project creation. No token is logged.

Only pure coordinator/helper checks and syntax checks run locally. Application,
SDK and restart workflows require ordinary exact-commit CI. No VM/DB/provider
workload, timeout change, manual CI rerun, merge, deployment or frontend work.

## Dependency and production checkpoint

This isolated PR targets `fix/project-archive-grant-atomicity`, not develop:
PR64 remote `faf6a660d7e7b66990200b135119bf2dd12a2117`, equivalent local
`af05a1414aa0461c9760c2c5746a05bdd9af7c7e`, tree
`ec9a0da18d058f1f447012259812b2e1cc69f69c`. This preserves the existing typed
archive-commit classification without duplicating its storage prerequisites.
Root composition must retain its later session/grant invalidation code inside
the owner transaction and session-project removal inside archive revocation.

Production coordinator and call sites are implemented; syntax only checked.
Whole-flow and concurrency verification remain pending. Not accepted.

Static review additionally found two ordering edges now addressed: archive
removal preserves the policy projects-array identity for unrelated in-flight
canonical creates; occupied-port fallback holds the queue while opening its
replacement listener and saving the disabled policy. Pure helper/filesystem
checks pass locally; application whole-flow acceptance remains pending CI.

## Root combination obligations

Root preserves its existing HTTP authorization epoch: a successful admitted
create may be durable but its response after owner policy replacement is an
explicit `-32000` authorization-changed error, not a replay or a fresh grant.
Root SDK workflows assert that error and independently inspect the exactly-once
stored project. Existing temporary database grants and HTTP sessions are
invalidated inside the serialized owner publication, after persistence.

Native-created projects remain session-only. Root's additional workflow holds
one native create while another session project is archived, verifies the new
unrelated grant survives in-memory without becoming remembered, then replaces
the owner policy during another native create. Stale-generation response is
rejected; neither old native grant survives replacement/restart. Existing
PR64 genuine uncertain-archive tests remain unchanged, including the explicit
boundary that uncertainty does not claim durable remembered-grant cleanup.
