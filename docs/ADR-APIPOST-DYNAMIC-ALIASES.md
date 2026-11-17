# Apipost dynamic timestamp and floating-point aliases

## Decision

Add `{{$microTimestamp}}` and `{{$randomFloat}}` to the existing bounded builtin
variable catalogue, shared by request interpolation and isolated script
`replaceIn`. User-defined variables keep priority, including zero and false.
The browser suggestion catalogue is generated from the same runtime names.

Despite its spelling, `$microTimestamp` returns Unix milliseconds, not
microseconds. `$timestamp` continues returning whole Unix seconds.
`$randomFloat` returns a number in the half-open interval [0, 1000), generated
from the existing bounded random-byte provider; it may return zero.
No seed compatibility with another product's random generator is promised.
No host object, filesystem access, network privilege, or worker budget is added.

## Evidence and limits

The official offline 2.0.0 execution bundle's module 842216 contains literal
assignments for these names: milliseconds from the current date and a random
fraction multiplied by 1000. The source was inspected as inert text; the
original application was not executed. These observations establish a narrow
compatibility target, not full SDK or free-feature parity.

Existing `$randomInt` behavior remains inclusive 0–1000 for compatibility with
this application's established contract. The inspected original expression
instead produces 0–999. That difference is not silently changed or claimed
resolved by adding these two names. Other Mock/Faker aliases and generation
reuse/timing remain outside this decision.

## Verification

Regression tests reproduce both undefined names before implementation.
Injected time and byte providers verify exact milliseconds, zero, and the
maximum possible generated fraction below 1000. Isolated scripts exercise both
`pm` and `apt` replacements. A real loopback HTTP request verifies numeric JSON
values and timestamp bounds. Existing catalogue equality tests verify the
browser/runtime suggestion names stay aligned.
