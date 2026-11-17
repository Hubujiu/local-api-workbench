# Explicit Cookie parameter encoding

Static Offline2 2.0.0 evidence: work.asar 3201.883b408594fa.js offers
request_cookie_encode 1/-1, labelled enabled/disabled. send.asar/index.js around
33639226 always encodes the cookie name with its encodeURIComponentUnique helper;
values use that helper when cookie_encode is absent or positive. The helper
around 33587538 preserves a whole template token and already escaped text, and
otherwise applies component encoding. No original program is executed or source
copied into the repository.

Introduce an explicit cookieEncoding request policy:
- raw: existing/default Workbench behavior, unchanged name/value text.
- apipost: names and values use the observed avoid-double-encoding behavior.
- apipost-name: names use it, values remain raw.

Modern imports map absent/1 to apipost and -1/0 to apipost-name; other values
reject rather than guessing. In particular disabled -1 is not an unsupported
truthy enabled flag. Encoding names remains distinct from the value toggle.
Existing Workbench requests default to raw so their wire bytes do not silently
change. Snapshots and project persistence retain the policy. The Cookie parameter
panel exposes all three choices and explains its scope.

Compatibility encoding preserves the entire component if percent decoding would
change it, even if other characters in that string are unescaped. It is not a
strict canonicalizer or sanitization guarantee. Malformed escapes are encoded;
invalid Unicode still fails. Existing HTTP header validation remains active.
Only enabled/nonempty-name parameter-table rows participate, with duplicate
order retained. Explicit Cookie headers and Cookie-manager contents are not
re-encoded; existing manager precedence and authorization stay unchanged.

Runtime and cURL export share one serializer. OpenAPI export rejects active
nondefault encoded Cookie parameters because it cannot preserve this wire policy;
project backup/cURL are alternatives. HTML/Markdown docs disclose the policy.

Fixed checks include typed policy/snapshots, original flag mapping to real HTTP,
Unicode/plus/percent escapes, duplicates/disabled values, HTTP1 and HTTP2,
exported/imported cURL and actual native cURL. Browser checks select/save/reload
and actual encoded Cookie wire text. No dependency or execution budget changes.
