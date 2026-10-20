# Bounded Apipost response compatibility

Primary reference: https://v7-wiki.apipost.cn/docs/1314/ (official apt API documentation, read 2026-10-20). This is a bounded interoperability implementation, not a claim of full current Offline2 SDK parity.

The previous alias apt.response = pm.response incorrectly made apt.response.json a function and headers/cookies method-only collections. The Apipost facade now exposes parsed JSON as a value, keyed case-insensitive response headers, keyed decoded cookies, numeric code, status text, responseTime, raw and text(). Postman's pm.response.json() and header/cookie reader functions are unchanged. Invalid JSON yields undefined in the Apipost value view; Postman's parser still throws. These are VM-local views, not modifications of wire evidence or a persistent cookie store.

Both facades support response.to.have.status(number or exact status text), header(name[, exact value]), body(exact text), and negation. The documented status groups info/success/redirection/clientError/serverError/error and exact statuses ok/accepted/badRequest/unauthorized/forbidden/notFound/rateLimited are implemented. Missing responses always fail, even under negation. Unsupported assertion members throw, not silently return undefined. A response chain is deliberately not a thenable so returning it from a synchronous assertion does not schedule phantom work.

jsonBody, schema assertions, XML/CSV parsing helpers and the full Postman assertion plugin remain unsupported. No new host APIs, network access, imports or budget relaxation are introduced. Tests first failed against the prior implementation, then check real HTTP plan success/failure, keyed Apipost versus callable Postman semantics, absent/invalid responses and unsupported member failures. Browser shared-script regression checks actual response assertions as well.

## Conflicting vendor documentation

The dedicated apt API page above uses the JSON value form, while https://v7-wiki.apipost.cn/docs/41/ includes a callable apt.response.json() example. These are not interchangeable for all JSON values. This implementation intentionally follows the dedicated API page for apt and keeps callable parsing under pm.response.json(); it does not claim that both conflicting forms are supported or that the current Offline2 binary behavior has been verified.
