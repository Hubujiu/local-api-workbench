# Literal query edits must not split interpolation tokens

The existing shortcut and batch removal paths used ordinary indexOf/split on
URL question marks, hashes and ampersands. Those delimiters can occur inside
balanced {{variable names}}, so a script could fail to remove a literal query
field or damage a remaining placeholder before normal interpolation.

Primary reference: Postman's standalone postman-url-encoder 3.0.8 parser keeps
balanced interpolation tokens intact across URL components. It is the parser
used by the original Offline2 embedded URL SDK. A separate static/component
check confirmed this behaviour. The full collection SDK was not adopted and no
new production dependency or host capability is introduced by this fix.

A small shared scanner now identifies URL/query delimiters only outside balanced
{{...}} tokens. The existing single-name Header/Query shortcut's query removal
and the request batch removal share it. They still compare decoded literal key
names, do not resolve variables themselves, preserve unrelated raw text and the
fragment, and retain malformed encoded keys. Query-count validation uses the
same token-aware boundaries. Unbalanced braces are not invented into tokens.

The scanner does not normalize the URL, decode template values, contact hosts,
or implement a complete URL object SDK. Existing phase budgets and query-size
limits are unchanged. Encoded-string additions now reuse the scanner for
row/key-value boundaries
and preserve tokens during component decoding. Literal spans retain strict
percent/plus decoding and key=value requirements. This permits a value such as
{{value+&=%name}} without treating its name as query syntax or malformed escapes.
A red regression and actual HTTP verify expansion occurs later exactly as other
structured query values do; saved plans are not changed.

Tests first reproduce failed removals with ?/#/& inside variable names, then
verify exact retained URI text and real interpolation/HTTP with an unchanged
saved plan. Browser coverage uses request-local variables containing delimiters
and verifies the removed parameter is absent on the wire; packaged runtimes also
exercise the same token-aware operations. Exact-head CI remains required.

Removal now shares the token-aware component decoder used by query additions.
Previously it split around balanced interpolation tokens correctly but then
called decodeURIComponent over the entire key. A percent sign inside a valid
template name could throw, and a plus inside the token could become a space,
preventing an exact literal name from being removed. Only literal spans now use
percent/plus decoding; token text remains opaque. Invalid escapes outside tokens
still leave the original row untouched. Both compatibility dialects and removal
entry points have regressions; a real loopback request proves the removed token
is not subsequently resolved and untouched encoded fields retain their spelling.
