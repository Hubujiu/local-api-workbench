# Redis SSH first-CI evidence and correction

## First run

[CI run 42857224635, attempt 1](https://github.com/Hubujiu/local-api-workbench/actions/runs/42857224635) tested PR #163 head `b3267a9b644f377ab6a3e1046828bb1099cb4bf3`, tree `4cdd07b05a4ec75ac82f8a40d49def264cb0ec20` (checkout `e13ce5eb549fcae42930e6e0d612d344b213948d`). All 43 jobs reached terminal state: 39 succeeded, 4 failed, with 5 failed tests across platforms.

Each platform covered 796 unique files and 5,764 tests:

- Ubuntu: 5,763 passed, 1 failed, 0 skipped.
- Windows: 5,754 passed, 2 failed, 8 skipped.
- macOS: 5,761 passed, 2 failed, 1 skipped.

The 53 Redis SSH-specific tests and 140 focused regression tests passed on each platform. Actual Redis 7.2 SSH acceptance completed all four markers: password/key GET/SET/NX/XX/TTL and local close; one lost real SET acknowledgement with uncertain outcome/readback; MCP stdio grants/isolation/restart/secrets; native read rebinding, CLI stdin and HTTP MCP revoke/restart. This is not acceptance against a TLS-enabled Redis service.

The verified first-run report, `final-report.json`, has SHA256 `0032a127ebfdb4980bced3c1c939fc5ade0dec490d5d93608dd4d4aa035da6e9`.

## Different findings, different conclusions

1. **Confirmed import-boundary regression, corrected here.** The unchanged Base64 preflight mutant test failed on all three platforms because its pure template bundle reached `cpu-features` through Redis command validation → Redis transport → SSH. Two inert consumers needed command policy only: native Redis write intent and script database task validation. The existing encoding/command functions are moved byte-for-byte to dependency-free `redis-commands.mjs`; both consumers use that module, while `redis.mjs` preserves its existing exports. No optional dependency is hidden, no test is weakened, and no command or transport semantics are changed. The unchanged failing case was reproduced and then passed after the correction. A new bundle-metafile regression checks that inert validation excludes Redis transport, SSH and optional native addons.
2. **Windows SQLite unknown outcome, still unexplained.** The first trigger-write rejection in `database.test.mjs` failed the original `/1000/` expectation. Subsequent rollback checks and oversized RETURNING were not executed. The SQLite child-process graph contains no Redis/SSH, and its involved production files and dependency declarations match the base. Approximately 2,650 ms alone does not establish a timeout. A test-only reporter now emits bounded phase/operation/exit/result/error evidence before the assertion receives the unchanged original error. Its diagnostic digits cannot satisfy `/1000/`; reporter failure cannot replace the original exception. The original `/1000/`, later `/1MiB/`, operation order/count, 2,000 ms budget, memory limit, cancellation and unknown-outcome behavior are unchanged. This adds evidence, not a claimed SQLite fix.
3. **macOS quota timeout, still unexplained.** `script-sequence.test.mjs` expected `/最多1000次/` and received a script timeout. No budget, assertion or runtime behavior is changed here. The older PR #160 macOS directory-export restart failure also remains unexplained; later green runs do not establish its cause or prove it fixed.

## Local verification and execution deviation

The correction adds 7 tests in two independent files: 2 command/bundle-boundary tests and 5 fake-error reporter tests. Final verification uses only explicitly independent pure/build files, syntax, formatting and diff checks. Real database, application, network and SDK acceptance remains ordinary-CI work.

One earlier verification command attempted to exclude the old helper suite's TAP subprocess probe using a negative test-name pattern. That filter did not exclude it: one fake-error Node subprocess probe executed. It did not open SQLite or run network, application or SDK workflows. This was a deviation from the instruction not to run local process workflows and is not counted as evidence of compliance with that restriction. The mixed suite was not run again. Subsequent verification uses independent pure/build files or syntax checks, without negative name filters.

The reviewed report-only helper SHA256 is `9484de0af92713fd917583ffc4367e2600eb284bb714bb1dec47f5de7a5d8e61`. Corrected-head ordinary CI is still required; the first run is not represented as fully green.
