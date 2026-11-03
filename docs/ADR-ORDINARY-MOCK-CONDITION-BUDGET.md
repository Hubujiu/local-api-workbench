# Bound ordinary Mock condition comparisons

Ordinary Mock's admitted 100 rules × 50 conditions could repeatedly serialize a
single request field on the server event loop. A real 64 KiB field caused 5,000
serializations (327,690,000 bytes), despite the request being well below the
existing 8 MiB HTTP limit. This is separate from native conditional Mock and
native-library/script VM budgets. Wall-clock measurements exposed the effect but
are not the acceptance oracle.

Each selection now owns a 1 MiB UTF-8 logical comparison budget and 100,000
visited nodes, with a maximum conversion depth of 64. Paths, JSON keys, quotes,
escapes, separators and String-coercion output are charged before conversion.
Empty/undefined values and exists operations still consume work. Cache hits pay
the same logical byte cost as uncached comparisons. Only immutable primitives
are cached; object identity is never used to assume conversion stability.

JSON eq/neq still use actual JSON.stringify, preserving object key order and
scalar distinctions. Preflight counts exact UTF-8 JSON output for the supported
inert data domain before allowing that conversion. Contains retains
String(actual ?? '') versus String(expected), including arrays and default
ordinary-object text. Input proxies, accessors, custom conversion callbacks,
cycles and exotic objects are refused explicitly; this is not compatibility
with arbitrary executable JavaScript objects. HTTP and saved JSON definitions
cannot contain those callbacks. No user coercion code runs during preflight.

Rule counts, enabled/ordered AND short-circuiting, first match, explicit example
precedence and normal fallback remain unchanged. Exists does not serialize the
pointed-to value. Unvisited later rules do not consume comparison work. Exhausted
work returns an explicit error, never fallback success. Counters and caches are
local to one request, so failure cannot poison another project or later request.
Native regex handling is untouched and ordinary conditions gain no regex syntax.

The existing HTTP input and persisted-project limits remain necessary. Bounded
preflight is not an interruptible host runtime or a millisecond latency promise;
JavaScript property enumeration still has engine-internal work. This patch does
not claim to budget all project loading or response validation.

Regression coverage uses genuine owner HTTP project creation and rule save,
large-input rejection, bounded serialization counts, healthy follow-up and
other-project requests, unchanged persisted data and actual application restart.
Additional exact-byte fixtures cover Unicode, escaped control characters,
arrays, object key order, contains, request-local caches, depth/node limits and
short-circuit behavior. No larger rule count limits, external database, original
application execution or new dependency is required.
