# Bounded callback HTTP in request scripts

Scope: implement the documented callback form of pm.sendRequest(config, callback), not full Postman SDK/Promise compatibility. Primary reference: https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-send-request

- The parent owns all HTTP execution. QuickJS has no Node/network module or filesystem binding. A structured message bridge accepts only URL, method, explicit headers, raw/urlencoded body and a bounded timeout. No file paths, certificates, proxies or ambient credentials are inherited.
- Only runPlan's actual before/after request scripts receive the network capability. Shared pure-function previews, dynamic-value transforms and regex extraction do not. The parent verifies capability separately from the mutable VM input.
- At most 10 calls and 4 outstanding calls; request JSON is at most64KiB, response JSON256KiB. Each HTTP timeout is at most1500ms. The original2second worker deadline remains unchanged and aborts outstanding requests on failure/cancellation. Slow remote workflows may exceed these intentionally strict limits.
- Script execution across the initial invocation and callbacks shares250ms of active wall-clock time, excluding network waits. Memory remains16MiB. Synchronous infinite loops in a callback are interrupted.
- Responses expose code/status/responseTime, json()/text(), and header readers. Callback exceptions fail the script. Promise-returning callbacks and missing callbacks are rejected explicitly. pm.test still rejects async assertions; no arbitrary microtask, timer, promise or full SDK scheduling is claimed.
- Callback writes are incorporated before subsequent plan execution/persistence. Failed callbacks preserve child request/response evidence without half-committing variable writes. Network errors passed to a callback may be handled intentionally; authors should assert the expected result.
- TLS verification and existing HTTP transport limits remain enabled. HTTP calls cannot undo external side effects on script failure; the evidence records what actually occurred.

Fixed acceptance: real token subrequest → environment variable → main HTTP Authorization, unsupported capabilities without sending, callback failure evidence, cancellation, count/concurrency/response limits, callback infinite-loop interruption, and real browser persistence.
