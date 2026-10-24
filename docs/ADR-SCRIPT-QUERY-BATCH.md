# Bounded request query batch methods

Static primary reference: official Offline2 2.0.0 send.asar/index.js, decoded
Request.addQueryParams/removeQueryParams at 26281023, URL delegates at 26312604,
and QueryParam parse/unparse around 26253378. The original SDK supports duplicate
query entries and treats a removal string as a literal key, not a query string.
No original code was executed or copied for this implementation.

pm.request and apt.request now expose addQueryParams and removeQueryParams without
changing the existing request.url string interface into a different object type.
This does not claim a complete URL SDK or raw query byte-for-byte preservation.

- Add accepts a key/value object, an array of them, or an encoded key=value query
  string without a leading question mark. Objects require text keys/values and
  may carry disabled and description metadata. Existing entries and duplicates
  retain their order; new entries append. Disabled entries remain stored but are
  not sent. Strings decode percent escapes and plus once before the existing
  request sender encodes structured query values. Balanced {{...}} interpolation
  names remain opaque while splitting rows/key-value boundaries and decoding;
  &, =, + and % inside such names are not delimiters or escape sequences.
  Literal spans still use strict percent decoding. Expansion happens later in
  the normal execution pipeline, not inside the batch helper.
- Flag-only strings, empty names, malformed UTF-8 escapes, unsupported object
  fields and nontext values fail explicitly rather than silently converting a
  flag to an equals pair or changing arbitrary values. The full vendor null/flag
  representation is outside this bounded contract.
- Remove accepts one literal key or an array of keys/key objects. All matches
  are removed from structured rows and matching decoded literal URL query keys;
  unrelated raw query text and the fragment remain intact. It does not resolve
  dynamic/template query names. Existing malformed encoded names are retained.
- Combined literal URL and structured query row count is at most 1000. Names are
  at most 1KiB, descriptions 8KiB, and URL plus structured query text totals at
  most 64KiB. UTF-8 validation and candidate validation happen before mutation.
  Invalid later entries/selectors cannot partially update earlier ones.

Both dialects use the same methods. Existing shortcut set/remove semantics,
request.url type, saved definitions, VM budgets and network authority are
unchanged. Tests cover duplicate/order/encoding semantics, strict rejection,
atomic bounds, literal-name removal and real HTTP with disabled rows excluded.
Browser and three packaged-runtime integrations require exact-head CI results.
