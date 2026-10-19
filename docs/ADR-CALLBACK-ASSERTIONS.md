# Bounded callback assertions

The Postman reference documents pm.test(name, function(done) {...}) as an asynchronous assertion form: https://learning.postman.com/latest-v-12/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-test-expect .

This implementation reserves the assertion record at registration, preserving ordering and the existing1000-assertion cap. Calling done() completes it; done(error), duplicate completion, a synchronous throw (even after done), or a missing completion produces failure. A later completion cannot erase a failure. Registered brokered HTTP callbacks finish before output is serialized.

No timer, Promise-job execution, Node module, filesystem, or additional network capability is enabled. Promise-returning assertions still explicitly fail. Existing2-second total deadline,250ms cumulative active execution,16MiB VM memory and10-request/4-outstanding limits remain. This is callback compatibility for the existing bounded HTTP broker, not full SDK parity.

Validation includes real loopback HTTP, synchronous completion/error/missing/duplicate/throw-after-completion and immutable failure states. Existing timeout, cancellation and unsupported-Promise regressions remain.
