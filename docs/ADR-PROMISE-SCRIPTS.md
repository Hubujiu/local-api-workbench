# Bounded Promise scripts

Status: implemented; publication must be accompanied by exact-commit CI evidence.

## Behavior

User scripts execute in an async function, supporting top-level await, native Promise jobs, pm.sendRequest(config) Promise responses, existing callbacks including async callbacks, timer async callbacks and pm.test async assertions. Callback assertions retain explicit done semantics; mixing done and Promise is rejected. Unfinished assertions remain failed. Unfinished root/callback promises fail rather than produce successful output. Pure function preview awaits returned values but retains its no-network policy.

Microtasks drain after synchronous execution and after each HTTP/timer callback. Every job batch shares the existing cumulative 250ms active-execution budget; a script additionally has at most 10000 microtasks. The parent retains its 2-second total deadline, network request caps, cancellation and VM memory/stack limits. Pending jobs cannot renew budgets. Detached unhandled rejections cause execution failure, including errors after await. Rejections explicitly handled by user catch remain valid. A failed async assertion is recorded in its registered position without turning the entire worker into an unrelated exception.

Not full SDK parity: $.ajax remains the documented callback subset and rejects Promise-returning callbacks; no setInterval, unrestricted fetch, dynamic imports or Node modules. Custom-function definitions retain their existing synchronous declaration syntax (they can return Promises); previews await these results.

## Native rejection accounting

Upstream quickjs-emscripten 0.31.0 does not expose a supported host rejection-tracker API. Draining jobs alone can falsely report success after detached rejection. We compile a small reviewed C extension using JS_SetHostPromiseRejectionTracker, never exposing tracker reset/hooks to VM code. The extension retains at most 1000 rejected promise/reason pairs, frees them on handled notification and before context/runtime disposal, and reports overflow explicitly. The reporter does not invoke arbitrary getters, proxies or coercion hooks. It copies only plain Error.message or primitive text, bounded to 4096 bytes.

Each worker creates a fresh isolated WASM instance through the upstream public variant-loader and FFI API. Application startup verifies SHA-256 of generated glue and decoded WASM and compiles immutable engine code once; workers can share only that compiled WebAssembly.Module, never runtime memory or user state. Worker glue/manifest identity is rechecked. See ADR-COMPILED-ENGINE.md. The base64 asset is transport encoding, not encryption. This hash guards accidental asset mismatch, not an attacker who can replace both manifest and executable files.

## Provenance and reproducibility

Source: https://github.com/justjake/quickjs-emscripten at v0.31.0, commit 235f6da2fd4f7354fa4765fde4aea880d2a4aef5. Compiler: official Emscripten 3.1.65. Source, patch, generated glue and WASM digests are in src/vendor/quickjs-tracked/manifest.json; upstream MIT licenses are included. No Apipost runtime code is used.

The only upstream source modifications are the reviewed C patch and disabling optional Closure minification (not VM protections). scripts/build-quickjs.mjs prepare clones the pinned upstream revision, checks patch paths/digests and generates the release-sync export list. Build with make -j1 dist/emscripten-module.mjs in packages/variant-quickjs-wasmfile-release-sync using the pinned SDK. The verify mode requires byte-identical WASM and normalized-LF glue hashes. A fresh-path local rebuild reproduced both; CI repeats with the official pinned SDK container and networking disabled during compilation. Only vendor source is mounted into the build container.

Tests cover retained-value teardown over repeated VM lifetimes, bounded rejection overflow, getter-safe diagnostics, handled/detached errors, top-level await, async assertion order/failure, microtask limits/order, unresolved work, real HTTP evidence and pure-preview authority. Actual packaged desktop smoke now awaits HTTP and async assertions on all three supported desktop platforms.

Output serialization is a terminal phase: it cannot schedule HTTP/timer work, and pending microtasks or rejected Promises created by getters/toJSON fail execution rather than report success. A regression first reproduced the false-success case before the guard was added.
