# Manual import: backend root composition

This is an isolated composition checkpoint of PR98 into the current backend
integration branch. It does not add frontend behavior or claim full equivalence
with the original application's fileDB implementation.

## Fixed inputs

- Backend root public `c7fbe040adba48830fca4c704a5a0ecd99fa07c7`, tree
  `53f7292c87ac9774481aeeb51c3d1ee4edf0a282`.
- Reviewed PR98 public `2327c52956852ffc7cde4e88ecb0f0687bb0a659`, tree
  `077aaa50fdcd62e048e07556c5538fcbbb506761`. Its independent exact CI
  `41808259225` passed all25 jobs; this is not root-composition acceptance.
- Feature delta is relative to corrected PR97 public
  `991e6158d70f94a0fdc255486de4d1837ad2bb43`, tree
  `dd9bae6b68b7372ad0ed4c151ca160f04e0f764b`.

The isolated root cache was checked against all41 changed GitHub blobs fetched
at the fixed root commit, then against the complete expected tree. Local Git
history contains a missing ancestor object, so an inconclusive merge message was
not used as evidence. The exact feature delta was applied with three-way blob
resolution. Only the initial import regions in runtime/server conflicted; both
the existing raw-media imports and new manual-import imports were retained.

Current core normalization, raw marker validation, late body/media finalization,
OAuth signing/token behavior, history owner and quota, project owner projection,
native-export refusal, frontend and dependency files are unchanged from the
root. No dependency installation, new license acceptance, original application
execution, proprietary source copying or deployment is part of this batch.

## Actual cross-boundary tests

`tests/manual-import-root-integration.test.mjs` adds real owner workflows with
fictional inputs and counted loopback endpoints:

- Postman XML raw input and OAuth1 parameter policy survive preview/apply,
  case/plan freezing, overwrite history, reopening and fresh-identity backup.
  Preview/apply/restore send no HTTP or token traffic. Intentional plan execution
  verifies OAuth1 independently and checks actual body bytes and Content-Type.
- `pm.request.body.update(string)` retains the existing contract: runtime media
  resets to default/text/plain while the frozen stored XML marker stays intact.
  The test does not assert an invented XML override after that reset.
- Saved Postman OAuth2 and supported native OAuth2 definitions preserve their
  explicit state without acquiring, refreshing or following credential URLs
  during import, restore or inspection.
- Marked live and frozen-only native definition exports still fail explicitly;
  ordinary backup is not confused with a lossy native export.
- Invalid raw metadata is rejected before persistence, including explicit empty
  selection. Public errors remain generic and do not echo secret-like source
  values. Changed input cannot reuse an already-issued preview token.

Existing manual-import suites exercise final pre-journal cancellation, project
and write-grant revocation, HTTP close and stdio EOF, same-byte journal guards,
published-then-thrown rename outcomes, process-exit recovery and independently
valid cross-process token contention. These run on the composed code, rather
than borrowing feature CI results. Existing history suites cover retained raw
definitions,8MiB current bodies,14MiB target configuration,32MiB full history
owner rebinding and backup transport bounds without imposing the source budget
on the existing target.

## Reproduction and acceptance

Run the new cross-boundary test and the combined regression set on the fixed
candidate:

```sh
node --test tests/manual-import-root-integration.test.mjs
node --test --test-concurrency=2 \
  tests/manual-import-*.test.mjs tests/postman-raw*.test.mjs \
  tests/*oauth*.test.mjs tests/request-definition-history*.test.mjs \
  tests/project-owner-projection.test.mjs \
  tests/api-resource-restore-commit-outcome.test.mjs \
  tests/native-folder-lifecycle-commit-outcome.test.mjs tests/mcp-expanded.test.mjs
npm run check
```

The independent reviewer checks the exact final candidate and actual test logs.
Publication must use a non-forced expected-head update against the current
`wip/backend-integration` branch. If the branch advances, reconcile before
publishing. Its push triggers normal exact-head CI; only that terminal result
can establish root acceptance across Linux, macOS and Windows. This document
does not authorize merging main or deployment.
