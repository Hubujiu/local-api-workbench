# Bounded scalar lookup paths

The old dot-splitting implementation could not address member names containing
dots, spaces or quotes, and silently treated recursive descent as ordinary dots.
Use a dedicated bounded tokenizer for legacy dotted fields, nonnegative indexes
and single/double-quoted bracket names. Quoted names decode escapes and valid
Unicode surrogate pairs without normalization. Empty quoted names and falsy values
are preserved. Missing own properties still return undefined; inherited properties
are never traversed. Validate the whole path before lookup so a missing early
member cannot hide a later forbidden prototype-related name.

This remains a single-value convenience API, not a complete RFC9535 engine or
nodelist API. Legacy numeric property lookup is retained. Wildcards, recursive
descent, filters, slices, selector lists and negative indexes fail explicitly.
Limit paths to4096 UTF-16 code units and64 segments. No expressions are evaluated,
no new dependencies or host capabilities are introduced, and malformed quoting or
Unicode escapes fail rather than being partially interpreted.

Tests first reproduced quoted-name extraction failure and misleading unsupported
path handling. A real two-step HTTP plan checks extraction into the next request.
The browser database-operation workflow uses a real SQLite column alias containing
a dot, preserves its quoted path through editing, and carries the result into the
outgoing HTTP header. Existing authorization and revocation checks remain intact.

Name-string syntax reference: https://www.rfc-editor.org/rfc/rfc9535.html#section-2.3.1
