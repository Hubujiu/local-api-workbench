# WIP: restore actual QuickJS WASM heap accounting

## Confirmed baseline defect

The pinned upstream QuickJS `js_def_malloc_usable_size` returns zero when the
legacy `EMSCRIPTEN` macro is defined. The fixed Emscripten 3.1.65 build defines
that macro. QuickJS consequently records only eight overhead bytes per block,
not its payload. This is an admission-control defect, not merely a display bug.

With the existing verified engine and a 16 MiB runtime limit, a bounded local
probe retained twenty distinct normal 1 MiB strings. All twenty read back at
1,048,576 characters, with no OOM. WASM linear memory grew to 29,097,984 bytes.
The glue's 2 GiB linear-memory maximum is not a 16 MiB QuickJS heap limit.
No unbounded allocations or malformed bytecode were used.

## Minimal correction

Use the pinned SDK's existing `malloc_usable_size` for `__EMSCRIPTEN__`, with
`<malloc.h>` declared for that target. The fixed SDK's malloc, realloc, free and
usable-size implementation are all from dlmalloc. Do not introduce a new
allocator/header, change the 16 MiB limit, or treat external ArrayBuffer storage
as already charged. Existing QuickJS allocation counters and free/realloc
ownership remain in place. Other runtime, stack and wall-time policies remain
unchanged.

The ordinary upstream admission check uses requested size while accounting uses
usable size plus overhead. As on the native implementation, a final allocation
can have alignment/overhead-sized boundary slack; this change does not claim a
new exact byte-by-byte allocator guarantee. It closes the unbounded cumulative
payload omission. Any further hardening of arithmetic/rounding needs explicit
coverage and review rather than an inflated limit.

## Validation checkpoint

The separately built candidate rejects the sixteenth 1 MiB retained string with `out of memory`. Actual accounted
size at that point is 15,784,168 bytes; releasing the strings returns it to
54,944 bytes, and another 1 MiB allocation succeeds.

After normal library/schema validation (18/18 targeted checks), the candidate
WASM is vendored on this development branch with its new manifest identity.
The glue is byte-identical to the previous build. Four normal regression tests
pass against the candidate and fail against the old engine: real size/free symmetry; bounded cumulative
OOM and recovery; ordinary array growth plus failed replacement retaining the
previous values; independent instances and per-runtime OOM isolation. These
checks keep 16 MiB, 512 KiB and 250 ms cumulative active wall time unchanged.
The cumulative/independence regression tests use fast, bounded guest-created
ArrayBuffers (not host `newArrayBuffer` external storage) to avoid making the
memory test dependent on expensive guest string repetition. The original
string-based bounded confirmation above remains separate evidence.

The separate trusted-bytecode experiment is paused on this prerequisite. This
change does not enable bytecode loading or modify schema checks. The isolated candidate passed the develop-base full suite: **1027/1027**.
A second clean official-source/fixed-SDK build reproduced the new WASM hash
`73dd53a3e384549688c49a1724e43139160e40d3136b0c8da62bfd4f138a1b94`;
the existing glue hash is unchanged. Source verification now checks all three
modified source paths and their exact hashes, including QuickJS and Makefile.
The exact implementation branch then passed **1027/1027** again (142.1 s),
with `npm run check`, `npm run format:check` and `git diff --check` also passing.
An extra read-only integration archive at `818bb82b2f2cc847f11a63f1165f7f7aa8db434d`
with only this engine overlaid passed 27/27 ordinary schema/library and native
comparator/MCP entrypoint checks. It did not modify or merge that branch.
Platform CI remains pending; local checks are not a release acceptance claim. This is WIP,
not a macOS timing-failure fix or permission to deploy/merge.
