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

## Immediate process-local attenuation (2026-11-03)

This section supersedes the old failed-disable memory behavior above, not its
publication ordering. A valid owner request which only disables the service,
removes write/execute permission, or removes existing canonical project grants
replaces the process policy synchronously, with a detached projects array. It
advances a revocation generation before joining the existing publication FIFO.
New MCP calls and requests which were still receiving their body cannot cross
that fence. The owner HTTP request still waits for actual ordered persistence:
there is no 202, early success, frontend change, or automatic retry.

Only strict Boolean capability inputs, the unchanged retention choice, no token
rotation, and a subset of existing canonical grants qualify. Effective execute
permission remains write AND execute. Mixed additions, rotation, retention
changes, malformed inputs and ordinary grants use the original validation path.
Rotation therefore remains an atomic disk-before-memory owner update; combining
rotation with reduction does not partially revoke early. Ordinary owner requests
capture the revocation generation before body parsing and check it at queue
entry, after validation and after persistence. A superseded write already in
progress may complete on disk but cannot reinstall its runtime grants. It fails
explicitly; this is not a rollback claim. Ordinary FIFO updates do not advance
this generation and remain sequentially valid.

The reduction's ordered turn saves a fresh current snapshot, including any
archive removals which completed earlier. It never reinstalls a captured policy
at completion. Old canonical-create references are detached and the existing
identity check rejects their remembered publication. Current-generation creates
and unrelated archive grants retain their normal behavior. Retention-disabled
owner snapshots still write the existing disabled sentinel, rather than using
the auxiliary writer's null-snapshot shortcut.

Persistence failure returns the existing non-2xx JSON error channel with an
explicit warning: current-process permissions were restricted, but persistence
is unconfirmed and restart may restore old authority. Runtime restriction is not
rolled back. The existing UI already surfaces this error and does not show its
success toast. A later explicit owner operation may recover. This is not a
crash-durable revocation journal or a cross-process authorization guarantee.

The independent PR70 baseline predates PR19 HTTP cancellation. This stage blocks
new admission but does NOT abort already admitted execution. Composition must
call the existing PR19 epoch/controller invalidation in the synchronous fence,
then prove the long-request/revocation/no-next-step/persisted-cancellation flow.
Already-sent network operations and admitted or confirmed writes are not undone.
No second cancellation implementation is introduced here.

At this checkpoint, nine real loopback HTTP/SDK/filesystem workflows passed,
including all four attenuation classes held behind an older owner operation and
a real project lock, prior-owner supersession, create/archive isolation, real
persistence failures, and actual restart from unchanged prior bytes. Fifteen
pure coordinator/filesystem/state-contract tests also passed. The finite
policy-state enumeration and transition tests are executable contracts, not a
TLA proof or a refinement proof. Wider tests, exact-head CI and combined PR19
cancellation remain pending; earlier CI results do not validate this change.

Design references: [OWASP default deny and per-request authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html),
[AWS IAM explicit deny precedence](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic_policy-eval-denyallow.html),
and [RFC 7009 revocation outcome semantics](https://www.rfc-editor.org/rfc/rfc7009.html#section-2).
These inform local deny precedence and truthful outcomes; this application does
not claim to implement an OAuth revocation endpoint.

Additional real HTTP contracts now cover partially received MCP and owner bodies
crossing the fence, and two successive reductions while an older owner holds the
FIFO behind a real project lock. Superseded requests return non-2xx; only the
latest intersection is persisted and an unrelated project remains usable. A
combined real archive/create/reduction interleaving preserves the archive removal
and denies both the late old create and explicitly removed project after restart.
The delayed create is confirmed to exist exactly as admitted; it is not rolled
back or silently replayed. All 61 MCP and archive tests passed locally against
this independent feature tree, plus repository-wide formatting and syntax checks.
Exact-head CI and the PR19-composed abort contract remain separate requirements.
