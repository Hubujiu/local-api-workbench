# Script object compatibility

Additional supported surfaces:
- pm.variables.get/has/toObject resolve the existing supported scopes in precedence order, with request-local values first. set/unset/clear still affect request-local values only; no invented collection/data/vault scope is added.
- pm.request.headers supports get/has/all/toObject/add/upsert/remove/clear/each over explicit request headers. Upsert/removal are case-insensitive. pm.request method/URL and raw-body update operate on the current request before sending.
- Legacy response.raw(status/responseTime/type/responseText), response.json, response.headers and decoded response.cookies are available after a response. pm.response exposes header/cookie readers and responseTime. These are not a persistent cookie jar or a full Postman Collection SDK object.
- apt.assert evaluates its expression only inside the same bounded VM, records explicit true/false/error evidence and returns a boolean. pm.assert is the same helper.
- postman/apipost environment/global get/set/clear aliases use the same persistent scope implementation. No host capability is granted.

No actual wire response is rewritten by modifying a script view. Request methods are serialized only from the canonical data model, not from the helper objects. The legacy response.status field remains this application's numeric field; response.raw.status/code are the compatible numeric accessors.

Promise-returning or callback-style asynchronous pm.test callbacks are explicitly failed as unsupported rather than falsely marked passed. At most1000script assertions may be recorded. This does not implement async networking or promise scheduling.

Primary references:
- https://v7-wiki.apipost.cn/docs/21/
- https://www.npmjs.com/package/apipost-runtime
- https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-variables
