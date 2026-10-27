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

Initial candidate build completed with WASM SHA-256
`c09ec397ce8419fc385b46044659da9a4a9ac35d6dec8ccb1cedb3821d56fd3c`;
glue remains byte-identical. Independent clean reproduction and runtime/platform
validation are pending; this initial WIP checkpoint is not acceptance evidence.
