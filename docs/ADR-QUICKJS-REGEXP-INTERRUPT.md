# WIP: use the existing activity deadline inside QuickJS regex execution

The pinned QuickJS 2024-02-14 regex VM performs backtracking in C without
checking the runtime interrupt callback. Its stack-overflow callback checks
only stack bounds, not time. The parent worker's two-second deadline remains
an independent last resort; it is not the 250 ms cumulative active deadline.

## Minimal licensed upstream backport

Backport Fabrice Bellard's official MIT-licensed 2025-03-13 commit
[`25aaa7737020d7ca98926abc532acc6c5755d562`](https://github.com/bellard/quickjs/commit/25aaa7737020d7ca98926abc532acc6c5755d562).
Only its three production files are patched: `libregexp.c`, `libregexp.h` and
`quickjs.c`. Paths are prefixed for the existing vendored tree and one upstream
trailing space is removed; functional patch content is unchanged. Existing
QuickJS and quickjs-emscripten MIT notices remain in the distributed LICENSE.
No proprietary implementation is used.

The regex VM polls after 10,000 selected backtracking/loop polling points,
not every 10,000 arbitrary opcodes. Its callback uses the already-installed
runtime interrupt handler and therefore the same current remaining deadline.
The simple-greedy recursive path propagates timeout separately from OOM. Both
`js_regexp_exec` and the global empty-replacement `JS_RegExpDelete` fast path
turn timeout into the existing uncatchable interruption error. Cleanup still
uses the original allocator and the separately corrected heap accounting.

No flags, parser grammar, UTF-16 behavior, bytecode format, QTS exports or host
permissions change. There is no new library, public bridge, timer, budget reset
or activity-time exclusion. Limits remain 16 MiB VM allocation accounting,
512 KiB stack, 250 ms cumulative active wall time and two-second worker wall
time. Existing heap-accounting alignment slack and total-process-memory caveats
are unchanged.

## Deliberate remaining limits

This patch does **not** add regex compilation interruption. Parsing, bytecode
construction/analysis and individual C copies/backreference character scans
are not individually polled. Input/memory limits alone are not proof that
each such operation finishes within 250 ms. Polling is cooperative, not an
exact-millisecond preemption guarantee. Final over-budget rejection cannot
retroactively stop work already performed.

Native assertion `regularmatch` remains unsupported. This engine repair is not
full regex hardening, an RE2 substitution, a handwritten safe-regex validator,
a repair of unrelated macOS activity-budget failures, or an XML-audit result.
No bytecode loading feature is introduced. Matching tests use only authored
valid patterns and bounded strings, with an independent two-second worker
termination guard that counts as failure if reached.

## Source and build provenance

The original source stays quickjs-emscripten `235f6da2fd4f7354fa4765fde4aea880d2a4aef5`;
the official Emscripten SDK stays 3.1.65, manager commit
`3eb3e02dfd10eaa527ba61b89cfcfba13d1c060d`. Rejection and heap patches are unchanged.
The manifest additionally identifies the upstream interrupt commit, exact
backport patch, and patched `libregexp.c` / `libregexp.h` / `quickjs.c` bytes.
The existing build verifier checks all five modified source paths and retains
the unchanged wrapper API. Every changed engine artifact must be rebuilt.

Two separate clean pinned-source builds with the same fixed official SDK
reproduce WASM SHA-256
`c09ec397ce8419fc385b46044659da9a4a9ac35d6dec8ccb1cedb3821d56fd3c`;
glue remains byte-identical. Both builds pass source/artifact verification.
The SDK cache was frozen and no SDK installation/activation or network was
needed for compilation. Independently reviewed WASM signatures preserve all
18 imported and 75 exported functions; all 76 export names/kinds are unchanged.
The simple manifest unit test checks consistency; exact source byte identities
are enforced by the build verifier and checked against both actual builds.

## Local validation and first WIP CI

- Seven focused tests pass: no-flags UTF-16 and primitive coercion semantics;
  direct C timeout at exec, global empty replacement and counted-loop paths;
  uncatchable interruption, cleanup and fresh-runtime isolation; the existing
  public script-stage timeout after prior activity; regex stack OOM remaining
  catchable and releasing capacity under the same 16 MiB / 250 ms limits.
- The real HTTP/debug/plan/restart workflow passes: before-phase interruption
  prevents wire execution and discards uncommitted variables; after-phase
  interruption retains raw HTTP evidence and prior commits; later plan steps
  use a fresh runtime; failures, scope isolation and recovery survive restart.
- Fifteen existing heap/rejection/compiled-module/URI/sequence checks pass.
- The default full suite passes **1036/1036** (143.3 s), no skipped/cancelled
  tests. Syntax checks, complete formatting check and `git diff --check` pass.
- A separate unchanged heap-fix engine archive fails the identical nested
  regex regression at its two-second guard. That guard termination is RED,
  not accepted interruption evidence. Only existing licensed OSS was executed.

The existing async script wrapper surfaces an exhausted activity budget as
`脚本执行超时` at `script` / `promise-state`, before inspecting its rejected
Promise. Direct engine tests separately require `InternalError: interrupted`
and show that guest catch/continuation did not execute. The test with 100 ms
prior activity checks public classification, not an independent exact elapsed
time proof; remaining-budget behavior also depends on the unchanged deadline
callback and cumulative ledger. No production wrapper behavior was changed.

Initial saved WIP head `b57c10754996319aa13197c28ca68882259bbea8` had two
incorrect public-error expectations. Its first CI
[40439160173](https://github.com/Hubujiu/local-api-workbench/actions/runs/40439160173)
finished RED: seven jobs passed, three OS core jobs each passed 1033/1035.
Both failures expected literal `interrupted` instead of the existing public
`脚本执行超时`. All ten actual checkouts were
`64ec391171ed775dd3010fd99ed0d19619f5a0f8`, whose tree equals that WIP head
(`e2cada4bbf51952e9b649403b6be249fa13a595e`). Low-level interruption cases,
official SDK reproduction, desktop, browser and database jobs passed, but do
not make that run green. The corrected tests retain strict script-stage and
promise-state classification, so parent wall timeout/OOM cannot pass instead.
No old CI rerun or budget relaxation is used. New exact-head platform CI is
still required; unrelated historical macOS budget failures are not claimed fixed.
