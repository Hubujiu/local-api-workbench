# Retained failure: lazy source initialization under 13 MiB guest pressure

Observed locally on 2026-10-27 at approximately 04:07 UTC, Node 24.22.1,
Linux x64. This is an **unresolved engine/parser failure**, not a passing OOM
test, a performance result, or permission to enable the experiment.

No rerun was performed to prepare this record. The command below is retained
from the actual invocation. A complete raw stdout/stderr file was **not** saved:
the tool displayed combined output and truncated the large final data-URL stack
trace. The readable observations below are transcribed from that actual output,
not presented as a complete raw transcript. Stream attribution and a final
process exit code were not captured separately. No comprehensive worker-isolated
rerun or production-engine control has yet established the full failure scope.

## Tested identity and unchanged limits

The invocation used the in-progress v2 experiment and its then-current fixed
artifacts after the engine dependency merge. This was not a committed standalone
checkpoint. Artifact identity checked immediately afterward:

- Private WASM SHA-256:
  `b624737c046e372d22e53151d470421e90489b4e9df905f3baf0f772d96d31b7`
- Private glue SHA-256:
  `9b384524fcebc4d5177dbeccd2d560ff829e0b5af65fa0a2d92d999036c1c2e7`
- Fixed manifest SHA-256:
  `4bdf8b6eb76e93808f4f0e4fc9d6966adb52c09ca0f9b594d5a2ae4e756b16bf`
- Production dependency WASM recorded in that manifest:
  `ac4822f75275ccf8cb936649383dc947843511784379518948cf61087a418c9e`

Limits were not changed: 16 MiB guest heap, 512 KiB stack, and 250 ms cumulative
active wall time. This standalone diagnostic did **not** run inside the usual
2 s worker supervisor. All explicit guest evaluations used the charged
`evaluateGuest` helper. The response API setup used unchanged
`responseCompatibilitySource` with the fixed local scaffold and the same
bytecode library/prelude prerequisites in both schema modes. No guest-selected
bytecode, C pointer, module, path or flags were supplied.

## Exact standalone command

Working directory:
`/workspace/scratch/75c2273f6a80/api-trusted-bytecode`

```sh
node --input-type=module <<'JS'
import {createLazySchemaSession} from './experiments/trusted-bytecode/lazy-schema.mjs';
import {evaluateGuest,installActualSchemaAPI} from './experiments/trusted-bytecode/lazy-fixture.mjs';
for (const mode of ['bytecode','source']) {
 const s=await createLazySchemaSession(mode);
 try {
  installActualSchemaAPI(s);
  console.log(mode,'baseline bytes',s.raw.mallocSize(s.runtime.rt.value));
  console.log('allocation',evaluateGuest(s,`globalThis.pressure = new Uint8Array(13 * 1024 * 1024); pressure.length;`));
  console.log('pressured bytes',s.raw.mallocSize(s.runtime.rt.value));
  try { console.log('load',evaluateGuest(s,`typeof globalThis.__validateJSONSchema`)); } catch(e) {console.log('load error',e.message);}
  console.log('state',s.lazy.state,'loads',s.lazy.loads,'heap',s.raw.mallocSize(s.runtime.rt.value));
  console.log('release',evaluateGuest(s,`delete globalThis.pressure; 6 * 7;`));
  console.log('released bytes',s.raw.mallocSize(s.runtime.rt.value));
  try { console.log('retry',evaluateGuest(s,`typeof globalThis.__validateJSONSchema`)); } catch(e) {console.log('retry error',e.message);}
 } finally {s.dispose()}
}
JS
```

## Readable observations retained from combined output

```text
bytecode baseline bytes 2284356
allocation 13631488
pressured bytes 15891584
load error Trusted lazy schema load failed
state failed loads 1 heap 15891584
release 42
released bytes 2259800
retry error Trusted lazy schema load failed
source baseline bytes 2284356
allocation 13631488
pressured bytes 15891584
Aborted(Assertion failed: label >= 0 && label < s->label_count, at: ../../vendor/quickjs/quickjs.c,21661,update_label)
[C to host error: returning null] RangeError: Maximum call stack size exceeded
    at wasm://wasm/001fd236:wasm-function[660]:0x326d1
    at wasm://wasm/001fd236:wasm-function[111]:0x459c
    at wasm://wasm/001fd236:wasm-function[860]:0x4778f
    at wasm://wasm/001fd236:wasm-function[609]:0x2c9a8
    at wasm://wasm/001fd236:wasm-function[378]:0x1e22e
    at wasm://wasm/001fd236:wasm-function[839]:0x46054
    at wasm://wasm/001fd236:wasm-function[598]:0x2be72
    at wasm://wasm/001fd236:wasm-function[381]:0x1e41c
    at wasm://wasm/001fd236:wasm-function[23]:0x1b6f
    at wasm://wasm/001fd236:wasm-function[44]:0x26ad
load undefined
state failed loads 1 heap 16776984
Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: ../../vendor/quickjs/quickjs.c,1999,JS_FreeRuntime)
```

The tool then displayed a very large `data:text/javascript;base64,...` engine
stack trace and truncated it. That unreadable/truncated remainder is not
reconstructed here. No source-mode `release`, `released bytes`, or `retry` result
was observed. `load undefined` after an engine assertion is **not successful
loading or clean error propagation**.

## What this establishes, and what it does not

- With this fixed 13 MiB guest allocation, bytecode lazy loading rejected
  normally, preserved the pre-attempt heap count, permitted release/arithmetic,
  and stayed failed without retry.
- Source-mode lazy initialization instead reached a QuickJS `update_label`
  assertion, followed by a C-to-host error and a runtime-disposal assertion.
  The exact parser root cause and production scope remain unverified.
- A separate earlier 12 MiB source-pressure observation rejected cleanly; the
  focused tests retain that smaller clean-rejection case and the 13 MiB bytecode
  case. Those tests explicitly do **not** establish safety of the failed 13 MiB
  source path, and this failure is not replaced by their passing results.
- The failure was reported immediately to the parent for engine-fix coordination.
  No limits were relaxed, no fallback was added, and no default was enabled.
