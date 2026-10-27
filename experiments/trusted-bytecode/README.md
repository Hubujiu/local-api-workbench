# WIP: fixed trusted-bundle bytecode experiment

This is an isolated experiment, **not a production loader**. No worker/default
loading path changes, deployment, main/develop merge, or macOS-flake-fix claim.
The base is develop `88f70bb515c48b93536b28b7fe3ec780f2e150f3`, tree
`107767d4d92f69fc0b5a048d41371267fea5a568`.

## Reproduced starting point

- Official quickjs-emscripten v0.31.0, commit
  `235f6da2fd4f7354fa4765fde4aea880d2a4aef5`.
- Official emsdk 3.1.65, commit
  `3eb3e02dfd10eaa527ba61b89cfcfba13d1c060d`; SDK installation was confined
  to a temporary directory, with shell-local activation only.
- The existing rejection-tracker patch and build reproduced the committed WASM
  `e12c1e8b0ad1c137564ca8a8a3979208c86b9e9f3a10fb08c704e1fd3053375f`
  and glue `4764f04399ab57b544f4654219c09d36cb6104c17cf8b1ab6baba39b806f3807`.
- Current public `compileOnly` plus `callFunction` does not execute bytecode;
  binaryJSON is a different API and will not be redefined.

## Important baseline accounting finding

The fixed source's `js_def_malloc_usable_size` returns zero under `EMSCRIPTEN`;
that macro is defined by the fixed non-STRICT SDK invocation. The existing
bundled WASM's `runtime.dumpMemoryUsage()` says `malloc_usable_size unavailable`.
A normal retained 1 MiB string changed its `memory allocated` count from 835 to
837 and bytes from 6680 to 6696, not by the string allocation's actual size.
This predates the proposed bytecode bridge. Merely using `js_malloc` cannot yet
prove that a bytecode input buffer is charged against the 16 MiB limit.
The experiment must resolve or explicitly block on accurate accounting; this
finding is not permission to weaken memory, stack, activity or worker limits.

## Planned boundary

Only fixed application-owned sources may be compiled. Source, wrapper,
bytecode, flags, virtual filename, actual WASM and glue identity must be bound
and checked before C reads the same verified bytes. No request/project/script
may select a path, manifest or byte buffer. No silent text fallback.

A fresh WASM instance/memory/runtime/context is required per evaluation. Limits
remain 16 MiB, 512 KiB stack, 250 ms cumulative active **wall time**, and 2 s
worker wall time. Hashing, copying, reading and evaluation must be charged, and
an operation finishing beyond its limit cannot be accepted.

The experiment initially targets the develop tree's unchanged schema and script
library bundles. Schema must remain first-use/lazy in any later integration;
user schema bounded JSON, inspection, self-validation, compilation, validation
and cache limits are untouched. The separate native XML bundle is not on this
base. XML intrinsic work is excluded; any later XML bundle path must preserve
its complete private IIFE, not expose its library/factory.

## Status

Baseline engine rebuild: passed locally. The private bridge, fixed-source build
and load adapter, and test sources are drafted but NOT compiled/executed. The
`pins.mjs` and `artifacts/` inputs do not yet exist: the experiment fails closed
until its explicit build is completed. Work is paused pending the separate
`fix/quickjs-heap-accounting` prerequisite. Performance/equivalence evidence is
not established. Not ready for production or merge. Existing CI and all
acceptance checks remain required.
