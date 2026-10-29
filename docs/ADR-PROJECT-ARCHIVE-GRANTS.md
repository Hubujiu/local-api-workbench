# Owner archive save outcome and MCP project grants

## Defect and necessary dependency

An owner project PUT previously removed its target from the in-memory HTTP MCP
allowlist before Store validation or optimistic conflict checks. For example,
`archived: true` together with an empty environment name rejected the project
save, but revoked the previously authorized client's next read. With remembered
configuration the on-disk grant remained intact and returned after restart.
This is failed-save state inconsistency, not an authorization bypass.

This bounded change is stacked on PR17 `fix/project-commit-outcomes`, remote
`82336c421e9702b258228c2cdfd95197c1eb8125`, local
`12a8534ea125231a9a9f166b407ea208844fbdd6`, exact tree
`2c5ae3d2324129fb9f1ba6594b92a574e6a09e1f`. That Store distinguishes errors before
journal publication from `ProjectCommitUncertain` after a recoverable write,
readback or committed lock cleanup. The independent develop base
`88f70bb515c48b93536b28b7fe3ec780f2e150f3` lacks this classification, so silently
assuming every thrown error means rollback would weaken its failure policy.
The PR targets the explicit storage dependency, with eventual develop integration
only after that dependency; no unrelated integration ancestry is included.

## Boundary

- Only the owner project PUT's explicit HTTP MCP project-grant revocation is
  coordinated with the existing Store save. No retry, transport, parser, budget,
  Store transaction, token format, permission or execution capability is added.
- Successful archive removes the target from the **current** in-memory allowlist,
  then follows the existing remembered-config write. Other projects and the token
  remain unchanged. Unarchive never grants access.
- A definite validation, optimistic conflict or pre-journal failure leaves this
  grant state unchanged. Project and remembered-config bytes are unchanged for
  the validation/conflict regression cases. Subsequent MCP activity logging is
  allowed and is not project configuration or grant mutation.
- A genuine, same-project `ProjectCommitUncertain` still removes the target in
  memory and rethrows the identical primary error. A code-shaped ordinary Error
  or foreign-project outcome is not a substitute for this Store classification.
  There is no automatic retry, grant restoration, or rollback claim.
- The uncertain path retains the existing absence of a remembered-config write:
  it does not claim that grant cleanup was durably saved. Recovery/read may apply
  the journal exactly once; the archived project is then denied by both HTTP and
  independently authorized stdio clients, including after restart.
- A later remembered-config write failure is **outside** the Store catch. The
  archive has already committed and memory remains revoked. The existing error
  response is not a rollback promise or a new Store uncertainty classification.
  This change does not make project storage and `.mcp-config.json` one transaction.
- Revocation governs future dispatches, not cancellation of already-dispatched
  work. Concurrent MCP configuration writes remain separate transactions; no
  serialization or global atomicity guarantee is added. Independently started
  stdio grants remain independent, but every read still checks archived state.

## Combined-root integration requirements

The accumulated root also has `mcpSessionProjects` for native MCP-created projects
and an active-import session. Its revocation callback must remove the target from
both explicit and session project lists on acknowledged archive and same-project
uncertainty; this independent branch must not import the native MCP feature merely
to add that field. Keep active-import stop-before-save and failed-acknowledgement
fail-closed behavior unchanged; never restore temporary source credentials or
silently reactivate/retry after uncertainty. In the combined workflow, native
SDK-created session projects need the same failed-save/success/uncertainty checks,
with unrelated session projects preserved. These are root-only acceptance, not
standalone feature claims.

The combined root implements that shared callback without changing the
active-import sequence. Its additional workflow uses actual HTTP SDK native
creation with write enabled and execution disabled. Invalid-name and stale-owner
archive requests preserve both explicit and session authority; successful and
real journal-uncertain archives remove only their target session grant. Owner
unarchive does not regrant it, unrelated session projects remain accessible, and
restart retains only remembered explicit grants. This combined-root workflow is
specified for CI, not a locally executed or standalone-feature result.

## Evidence and acceptance

The pure coordinator tests import only the coordinator and error class: deferred
revocation, current-list isolation, exact error identity/no retry, definite and
foreign failures, genuine same-project uncertainty and ordinary saves/unarchive.
Local execution is limited to these pure fixtures plus static syntax/format checks.

The application workflow specifications are reserved for ordinary exact-commit
CI: owner HTTP invalid-name and stale-version rejection, actual official SDK
HTTP/stdio readback, target-only successful archive, unchanged unrelated project,
remember on/off, unarchive without HTTP regrant, restart and explicit regrant.
Actual temporary filesystem obstructions cover a journal-published archive error,
single recovery without replay, and a remembered-config error after project commit.
Project bytes/revisions and config bytes/token are asserted at the appropriate
boundary; no execution tools are granted and history stays empty. These workflows
have not been run locally, and this note does not claim their CI outcome in advance.
