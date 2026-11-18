# Main consolidation cleanup — fixed snapshot 2026-11-17

This is the one-time maintenance record for `Hubujiu/local-api-workbench`.
It does not change application code or update `main`.

## Verified integration

- Integration PR: https://github.com/Hubujiu/local-api-workbench/pull/264
- Main: `f59b11ac3dc96c567db155dd871ef08ba445937c`
- Main tree: `4869acc4fc433b16b1d6b62750c310884c6f2f96`
- Main push CI: https://github.com/Hubujiu/local-api-workbench/actions/runs/44130790449
- That run completed its first attempt with 47 successful jobs.
- PRs #261, #262, and #263 are true ancestors of that main commit and have been closed as incorporated through #264.

The fixed inventory contains 337 original branches, including main. Among the
336 old branches to remove, 239 heads are main ancestors and 97 are not. The
latter include reviewed equivalent/superseded work and five deliberately
excluded experimental or diagnostic branches. Archival preserves their exact
commits without claiming their code was merged into main.

## Execution contract

The workflow runs only on the exact temporary maintenance branch. Preparation
checks the repository, ref, main SHA, complete live branch inventory, and exact
main CI. It creates non-overwriting archive tags for every removal target,
including the temporary maintenance branch, verifies each remote tag, and
creates and verifies a Git bundle containing the recoverable objects.

The workflow uploads that backup before allowing the deletion phase. Deletion
rechecks all refs and tags, then uses one atomic Git push with a separate exact
SHA lease for every branch. Main is never a removal target. A conflicting tag,
new branch, moved head, failed backup, or rejected lease stops cleanup.

The final expected state is the original main commit as the only branch and
337 archive tags: 336 former working branches plus this temporary maintenance
branch. The recovery manifest and final outcome are retained as Actions
artifacts; artifact retention is 90 days. The archive tags remain in Git after
artifact expiration. This maintenance commit, its fixed manifest, code, tests,
and these instructions are themselves reachable from its archive tag.

## Recovering one former branch

Fetch the archive tags into a fresh clone:

```sh
git fetch origin 'refs/tags/archive/main-consolidation-2026-11-17/*:refs/tags/archive/main-consolidation-2026-11-17/*'
```

For example, restore the excluded Oracle work into a new local branch:

```sh
git switch -c restore/oracle-readonly-wip refs/tags/archive/main-consolidation-2026-11-17/feat/oracle-readonly-wip
```

For any other entry, replace the suffix with its original branch name from
`manifest.json`. Compare `git rev-parse HEAD` with that entry's expected SHA.
Only push a restored branch if further work on it is intended.

If using the downloaded Actions backup instead, inspect its SHA256 and recovery
manifest and run `git bundle verify` before cloning the bundle. The backup
contains Git objects and refs, not runner credentials or local Git config.

## Interpretation

The complete original feature review and residual product limitations remain
in `docs/branch-audit-2026-11-17.md` and its `branches.json` on main. Cleanup
changes ref organization only. It is not a release, installer acceptance, or
a claim that every historical intermittent CI symptom has a proven cause.
