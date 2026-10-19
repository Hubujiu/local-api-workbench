# Bounded callback assertions

The Postman reference documents pm.test(name, function(done) {...}) as an asynchronous assertion form: https://learning.postman.com/latest-v-12/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-test-expect .

This implementation reserves the assertion record at registration, preserving ordering and the existing1000-assertion cap. Calling done() completes it; done(error), duplicate completion, a synchronous throw (even after done), or a missing completion produces failure. A later completion cannot erase a failure. Registered brokered HTTP callbacks finish before output is serialized.

No timer, Promise-job execution, Node module, filesystem, or additional network capability is enabled. Promise-returning assertions still explicitly fail. Existing2-second total deadline,250ms cumulative active execution,16MiB VM memory and10-request/4-outstanding limits remain. This is callback compatibility for the existing bounded HTTP broker, not full SDK parity.

Validation includes real loopback HTTP, synchronous completion/error/missing/duplicate/throw-after-completion and immutable failure states. Existing timeout, cancellation and unsupported-Promise regressions remain.

## Bounded timer extension (2026-10-19)

`setTimeout(callback, delay, ...args)` and `clearTimeout(id)` now share the HTTP
completion loop. Timers remain inside the QuickJS context and cannot expose
Node, filesystem, or network capabilities. Timer internals are captured in
closures and removed from the script global object.

- Finite delays from 0 to 1000ms; omitted delay defaults to zero. Out-of-range
  values fail rather than silently changing the requested wait.
- At most 100 scheduled timers per script and 32 outstanding timers. Clearing a
  timer does not refund the total scheduling limit.
- The existing 2-second parent deadline and 250ms cumulative VM execution budget
  remain unchanged. Waiting does not consume VM execution time, but does consume
  the total deadline. Nested waits cannot extend it.
- Callbacks can schedule HTTP requests and other timers; output waits for both
  queues. Cancellation terminates the worker and outstanding brokered requests.
- Callback throws fail the script. Promise-returning timer callbacks fail
  explicitly. String callbacks and intervals are unsupported.

The earlier “no timer” statement describes the initial callback-only revision;
this section supersedes that limitation only. Promise jobs and full SDK support
are still outside the implemented compatibility surface.
