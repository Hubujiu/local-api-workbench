# WIP: fixed trusted-bundle bytecode experiment

This isolated experiment is **not a production loader**. No default/runtime
loading path is switched, and no main/develop merge or deployment is authorized
by these results. In particular, this does not establish a fix for the separate
macOS 250 ms URL SDK interruption.

PR #37 depends on the verified heap-accounting PR #36 and targets
`fix/quickjs-heap-accounting` so its review diff remains experiment-only.
The original develop base was `88f70bb515c48b93536b28b7fe3ec780f2e150f3`.

## Fixed boundary

- Only the closed catalog's application-owned sources are compiled. The real
  schema and script-library bundles keep their complete, unchanged private IIFE.
  The script library needs the existing `Event` / `EventTarget` bootstrap: the
  exact excerpt from `src/script-worker.mjs` is pinned as `library-prelude.js`,
  explicitly loaded in both comparison modes. This is not the full production
  bootstrap, and the ordinary library check is not full API equivalence.
- Source, complete wrapper, virtual filename, compile/write/read flags,
  bytecode, actual WASM/glue, loader and build provenance are verified. The
  runtime manifest itself has a source-controlled SHA-256 pin. Bytes are read
  once, checked, and those same private bytes copied before the C bridge reads
  them. No import-by-file race after checking separate glue bytes.
- No guest/project/request source, byte buffers, paths, manifests or eval flags
  select this loader. No module, SAB, reference or ROM modes; no text fallback.
  Source comparison is a separate explicit host-only test mode.
- Fresh WASM instance, memory, runtime and context per session. Limits remain
  16 MiB heap, 512 KiB stack, 250 ms cumulative active wall time and 2 s worker
  wall time. Verification/copy/read/evaluation are charged, including a final
  late-success check. No limit was relaxed to pass the experiment.
- No schema bundle load occurs for an unused session. First-use schema remains
  explicit; its existing bounded JSON, inspection, meta-validation, compilation,
  validation and cache behavior is unchanged. XML-specific work is excluded;
  no original GUI or separate native XML audit was run.

## Engine and accounting prerequisite

Official quickjs-emscripten v0.31.0 source:
`235f6da2fd4f7354fa4765fde4aea880d2a4aef5`.
Official emsdk 3.1.65 manager:
`3eb3e02dfd10eaa527ba61b89cfcfba13d1c060d`.
The known Linux x64 compiler distribution and SDK Node executable have explicit
byte-digest allowlists. No additional software was installed in this continuation.

The original engine's `js_def_malloc_usable_size` returned zero under the fixed
SDK, omitting ordinary payload bytes from admission accounting. That predates
this bridge. PR #36 uses the SDK's existing official dlmalloc
`malloc_usable_size`; its production WASM is
`73dd53a3e384549688c49a1724e43139160e40d3136b0c8da62bfd4f138a1b94`.
The experiment includes that repair, not a replacement allocator or higher limit.

The private bridge actually compiled and ran. Two clean, independently prepared
source directories on this host reproduced:

- WASM `12ccc975fbc668837b17f77ae0606e125eedade6733df3704d625dda7eaa58f6`
- Glue `59c0544e03c487e3f290c22b168edefb5e48afcdcb9ca453523aa3ecfacf5f57`

This is same-host reproducibility, **not cross-host build validation**. The
receipt binds the actual local make/Python/shell recipe too; a different host
requires explicit review, not silently accepting changed provenance.

## Build and verification

The builder compares actual files against the immutable pinned Git tree, not
just `git diff` or the mutable index. Exactly the reviewed interface, heap source
and Makefile patches are allowed; generated exports are rederived and checked.
Unexpected tracked/ignored/untracked overlays, symlinks, initialized unused
submodules, modified SDK bytes and changed outputs reject. Build directories are
cleaned before compilation. SDK cache is frozen and Python uses a source-only
cache path; merely disabling `.pyc` writes would not prevent stale cache reads.
Input fingerprints are checked before and after compilation. Collection requires
an exact matching build receipt, not just a copied binary claiming a version.

With the previously obtained, reviewed SDK already installed:

```sh
node experiments/trusted-bytecode/build-runtime.mjs prepare /tmp/private-qjs-source
node experiments/trusted-bytecode/build-runtime.mjs build /tmp/private-qjs-source /path/to/reviewed-emsdk
node experiments/trusted-bytecode/build-runtime.mjs collect /tmp/private-qjs-source /path/to/reviewed-emsdk
node experiments/trusted-bytecode/build-bundles.mjs
node --test --test-concurrency=1 experiments/trusted-bytecode/*.test.mjs
node experiments/trusted-bytecode/measure.mjs
```

Prepare refuses an existing destination and fetches only the official pinned
source. The fixed-bundle builder accepts no source/path/flag arguments. Repeat
prepare/build with a second source directory, then use `verify` instead of
`collect` for the independent reproduction check. Generated licenses remain
alongside artifacts. Do not treat this directory as an arbitrary bytecode API.

## Verified locally, 2026-10-27

- Five build-input/provenance unit tests; source/Makefile/export/template/ignored
  header mutation negatives; changed output WASM rejected before collection.
- Eighteen runtime/ownership/outcome checks: late-context setup rollback, idempotent
  ownership, staging heap accounting and free symmetry, ordinary OOM recovery,
  borrowed compile handles, non-bytecode writer rejection, result/exception
  disposal, cleanup failure and late-cleanup success rejection, fixed
  identity/flag/hash mismatches before C, fresh instance
  isolation, schema and ordinary library source/bytecode equivalence, cumulative
  wall time, interruption and worker cancellation.
- `npm run check`, experiment formatting and `git diff --check` passed.
  Sixteen focused existing production heap/library/schema/workflow tests passed.
- Early real execution exposed and fixed two previously untested draft defects:
  the loader needed `quickjsEmscriptenInit()` before reading the memory extension;
  script libraries needed the existing Event bootstrap. Those failures were not
  timing failures and were not addressed by relaxing limits. See the retained
  `evidence/` failure records; the failing library test was fixed, not removed.
- CI now runs runtime/ownership checks on all three OS core jobs and build-input
  tests on Linux. The existing engine-rebuild CI validates the heap prerequisite,
  not the separate private C bridge. Final exact-commit CI remains required.

## Limited measurements, not enablement evidence

[`measurements/2026-10-27-linux-x64-lifecycle.json`](measurements/2026-10-27-linux-x64-lifecycle.json)
contains all 70 final samples: ten sequential fresh workers for each fixed operation,
including schema first-use and repeated validation, rotating order, Node 24.22.1 / Linux x64, same host/process. All succeeded within
unchanged limits. Active wall time includes verification and engine startup;
parent total wall time includes worker startup and confirmed termination.
Success is published only after guest disposal; disposal is charged to the
active budget, and cleanup failures cannot be recorded as successful samples. This is not a cold-process,
cross-platform, full script-workflow or macOS-flake benchmark.

| Operation | Active median (range), ms | Parent total median, ms |
| --- | ---: | ---: |
| Unused session | 13.9 (11.5–15.9) | 70.9 |
| Schema source | 78.0 (69.2–83.3) | 135.2 |
| Schema bytecode | 29.8 (25.0–35.6) | 87.7 |
| Schema source + first/repeated validation | 93.1 (82.4–143.1) | 151.4 |
| Schema bytecode + first/repeated validation | 43.1 (39.2–54.2) | 100.0 |
| Libraries + prelude source | 141.0 (126.8–147.8) | 196.4 |
| Libraries + prelude bytecode | 63.7 (56.4–70.7) | 123.7 |

The fixed ordinary schema/data pair returns `valid: true` twice. First validation
median is 11.92 ms (source-loaded) versus 15.58 ms (bytecode-loaded), and repeated
validation is 0.50 versus 0.39 ms. Thus this sample does **not** show every phase
getting faster; the observed saving is principally fixed-bundle initialization.
Both validations remain charged to the same 250 ms session budget.

The earlier 50-sample `-initial.json` and 70-sample unsuffixed `.json` observations
are retained as **pre-cleanup / startup-to-result** measurements, not full
lifecycle evidence and not mixed into the final distributions. Independent
review found that the old harness posted success before its finally disposal;
the parent could then terminate before a cleanup failure was observed. The
current outcome helper disposes before success, rejects cleanup failures and
late cleanup, and guarantees disposal even if an already-expired budget rejects
the charged callback before it runs. Three deterministic tests cover this fix.

These samples show lower cost for the fixed bytecode path on this host only.
They do not justify changing defaults. Production integration, broader behavioral
coverage, platform CI, end-to-end lazy-load/budget/atomicity evidence and an
explicit enablement decision remain outside this checkpoint. Keep draft.
