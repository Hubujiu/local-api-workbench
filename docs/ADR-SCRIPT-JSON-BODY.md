# Bounded JSON response assertions

References: Apipost's dedicated API page at
https://v7-wiki.apipost.cn/docs/1314/ and Postman's assertion interface at
https://github.com/postmanlabs/postman-sandbox/blob/develop/types/sandbox/test.d.ts .
The published chai-postman 2.0.1 implementation was inspected as a secondary
behavior reference, not installed or copied into the runtime.

Both apt and pm response chains expose `jsonBody()` for JSON validity,
`jsonBody(path[, value])` for an own-property path and optional deep equality,
and `jsonBody(objectOrArray)` for whole-document deep equality. Object key order
is irrelevant. A string argument is always a path, not a JSON document; an empty
string denotes an actual empty property name, not the root. Literal keys take
precedence over dot/bracket traversal, consistent with the existing Lodash helper.
Paths are limited to 1024 characters and 32 segments. Unsupported overloads fail
instead of silently doing nothing.

Negation applies to the complete predicate: a path/value assertion is true only
when the own path exists and the value matches. A missing response always fails.
Malformed JSON can satisfy a negated validity check, but never a path or whole-value
check. These explicit rules do not reproduce all legacy plugin quirks: in
particular object arguments cannot become no-op successes, and negated path/value
checks do not separately negate path presence and equality.

All parsing, traversal and comparison run inside the existing isolated VM and
its unchanged time, memory, response-size and assertion budgets. No host API,
remote schema lookup or new dependency is introduced. JSON Schema assertions
remain outside this change.
