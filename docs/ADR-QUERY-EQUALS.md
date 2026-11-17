# Explicit empty Query equals preference

Original static evidence: Offline2 work.asar 3201.883b408594fa.js writes 1/-1
for its request_query_add_equal toggle. Modern interchange carries
request.query.query_add_equal. The earlier -1 data-loss rejection is replaced by
a boolean queryAddEqual request setting, default true. Modern 1/absent maps to
true, -1/previously recognized 0 maps to false; unknown source values reject.

When false, an enabled structured Query row whose resolved String(value ?? "")
is empty is sent as key instead of key=. Nonempty 0/false values still include
an equals sign. Disabled rows remain excluded. The debug Query panel exposes
this preference, and snapshots, split-file persistence and project backups keep
it. The preference applies to the parameter table, not to literal query text
already present in the URL.

A shared serializer appends only new encoded pairs, preserving unrelated literal
URL query spelling/flag fields instead of asking URLSearchParams to rewrite
all of them. Query API-key/JWT insertion replaces matching decoded names while
preserving other raw fields. New names/values still use URLSearchParams encoding;
URL parsing, TLS, signing order and network restrictions are unchanged. This is
not arbitrary raw HTTP or a complete vendor URL SDK.

cURL export uses the same serializer; fixed local native-cURL integration checks
the actual request target. Project backup/restore preserves the setting. OpenAPI
has no exact representation for this preference, so export of such a configured
request rejects clearly rather than silently discard it. OpenAPI remains available
for default-equals requests; no unsupported extension is invented. HTML/Markdown
documentation and the shared preview disclose the nondefault empty-value rule.

Fixed verification: typed setting and snapshots; real HTTP1/2, query-auth insertion,
0/false/empty/disabled values, raw-query spelling and exported/imported cURL;
modern import to actual HTTP; on-disk save/restore; browser change/save/reload and
both wire forms. No existing script or transport budget is raised. Exact-head CI
is required before this feature is reported as verified.
