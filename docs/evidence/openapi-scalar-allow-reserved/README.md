# Reject unsupported scalar query reserved-character semantics

Baseline: PR #159, `1d91d3aea2a12b055be9d9236062640866a422cc`.

The query importer rejected unsupported `allowReserved` values for arrays only.
Its scalar early return silently discarded `allowReserved: true`, including
malformed values such as `"true"` and `null`. The accepted scalar `a/b:c` was
therefore emitted as `a%2Fb%3Ac` despite the source's reserved-character intent.

This fix moves the existing validation before the scalar/array split. It keeps
the same explicit error and supports only absent or false `allowReserved`.
There is no new query encoder, proprietary representation or interpretation of
already persisted rows. Existing array rules and ordinary scalar encoding stay
unchanged. Swagger's shared scalar importer now rejects the unsupported field
consistently rather than treating it as implemented.

## Local reproduction

`tests/openapi-query-allow-reserved.test.mjs` on unchanged baseline: 3 passed,
7 failed for missing expected rejection. After the fix: 10/10 passed. Captured
RED/GREEN output is included, with only trailing whitespace removed.

Pure tests cover OpenAPI 3.0/3.1 and Swagger 2, malformed values, source
immutability, whole-batch rollback for import and every MCP cover mode, local
parameter references and path-level inheritance. Absent and false values keep
the original scalar value and encoded cURL bytes. Existing query-array,
scalar-value and operation-admission tests are included in local checks.
Those local checks passed 32/32, without skips, failures or cancellations.
Independent review passed 29/29 pure tests and found no blockers. Syntax,
whole-repository formatting and diff whitespace checks passed.

## Runtime acceptance

The separate workflow file is authored with syntax checks locally and runs in
ordinary CI. It covers real owner HTTP and official SDK HTTP rejection, no
partial overwrites or project revision/file changes, project isolation, no
fixture requests during import, and unchanged data after Store reopen. Accepted
absent/false values for all three formats must still produce exactly
`/search?filter=a%2Fb%3Ac` on a real loopback receiver and through cURL export.

Complete cross-platform workflow results and source/artifact provenance must be
verified for this commit independently. No full local suite, original Apipost,
restricted export integration, cancelled multipart publication, merge or
deployment is claimed.
