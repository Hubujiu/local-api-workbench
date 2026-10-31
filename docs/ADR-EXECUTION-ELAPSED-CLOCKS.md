# Monotonic dynamic-value and load-execution clocks

The dynamic request resolver's five-second aggregate budget and the load runner's
duration admission previously compared `Date.now()` values. A civil-clock rollback
could extend the dynamic budget, and a forward jump could reject a valid transform
or stop a duration load before its requested elapsed duration. Load elapsed fields
could also become negative or reflect the clock adjustment rather than execution.
The load runner already had an independent relative cancellation timer; this fix
does not claim that a rollback removed that existing defense.

Both modules now capture host `performance.now()` for elapsed starts and deadline
comparisons. Dynamic guards stay before and after each resolved dynamic value.
Load deadlines, admission and remaining timer delays stay unrounded. Only emitted
load per-iteration and total elapsed observations are rounded to nonnegative integer
milliseconds, retaining the previous API/display shape (`public/app.js` displays
total elapsed in milliseconds). No consumer requires integer internal deadlines.

The five-second aggregate budget, 100 dynamic values, 20 dynamic transforms,
100 load iterations, concurrency 10 and one-to-60-second duration validation remain
unchanged. The existing duration `setTimeout`, cancellation signal, abort handling,
cleanup and script/transport limits are retained. No retry, clock injection or
budget override is exposed in production. Civil timestamps, guest clocks, auth
signatures, cookie/token expirations and unrelated scheduling code are untouched.

The new runtime regression file is serial and isolated by the existing Node test
runner. Every `Date.now` replacement is restored in an asynchronous `finally`.
A real dynamic transform must succeed across forward and backward civil jumps;
a bounded 5.1-second host interpolation wait under rollback must still fail the
original five-second guard, not be accepted as successful transformation. Loopback
HTTP verifies that a forward jump does not truncate count-limited duration admission
and rollback does not defeat the existing one-second in-flight cancellation timer
or produce negative elapsed evidence. Servers close their connections in `finally`.
Existing dynamic, load, CSV, cancellation and script tests are unchanged.

Local verification is restricted to syntax, formatting and a source-only wiring
test importing no runtime. No local application, VM or HTTP workload was executed.
Runtime regressions await exact-commit ordinary CI; static checks are not proof of
complete runtime acceptance. These clock defects do not establish the cause or
resolution of the separate XML/script CI timeout.
