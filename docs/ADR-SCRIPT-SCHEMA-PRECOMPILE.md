# Build-time compilation of the fixed Draft 7 meta-schema

## Problem and evidence

The packaged macOS aggregate script has exhausted the unchanged 250 ms activity
budget before asynchronous HTTP or timer work. Phase diagnostics at commit
4d53340891afa7d2b9e1e7051205581ab33fa947 measured 8 ms of compatibility setup,
1 ms of function-library setup, and 250 ms in synchronous script evaluation.
The last attempted operation (`promise-state`) is not a claim that promise
inspection consumed that time. Batching compatibility installation did not solve
this failure. These phase measurements do not identify an individual library.

A separate local experiment on the exact aggregate script identified repeated
first-use compilation of Ajv's fixed Draft 7 meta-schema as avoidable work. Five
alternating fresh-worker runs retained every assertion and the original budgets;
median activity time was 95 ms for the baseline and 58 ms for a prototype. This is
exploratory local evidence, not proof of macOS stability or full compatibility.

## Decision

Generate standalone validators for the installed, pinned official Ajv Draft 7
meta-schema during the existing sandbox asset build. Generate each combination of
`allErrors` and `verbose`, rather than silently changing diagnostics. Verify the
meta-schema source SHA-256 before generation. The package lock pins the compiler;
the existing reproducible-asset CI rebuilds and compares the committed bundle.
The generated code remains bundled into the same sandbox schema library.

Ajv's `validateSchema` option remains enabled. Its self-validation method uses the
precompiled validator only for the supported built-in Draft 7 meta-schema, with
original-method fallback for other inputs. Every untrusted user schema still
passes the same bounded JSON copy, keyword/reference/format inspection, Draft 7
self-validation, and user-schema compilation inside the isolated VM. Invalid
schemas continue to throw and cannot become successful negative assertions.

No activity, bootstrap, wall-clock, memory, stack, input-size, cache, network or
callback limit changes. No preflight evaluation of user schemas on the host, no
shared VM, no skipped assertions, and no retry mechanism. Runtime URI compatibility
transformation and the closed URL adapter build remain unchanged.

## Verification boundaries

The committed oracle test compares validity and complete error objects against
installed official Ajv across all four supported option combinations, including
recursive definitions, malformed keyword values, boolean schemas and local refs.
Existing sandbox and real-HTTP schema tests cover integration, unsupported refs,
negation, bounds and eviction. The ordinary full suite and packaged CI remain
required; one green run alone does not establish the historical macOS flake's
unique root cause. This change is a bounded optimization, not full Apipost SDK
parity or a relaxation of sandbox safety checks.

Reference: https://ajv.js.org/standalone.html
