# Bounded native response metadata extraction

This PR25 increment independently implements `pickVars` sources `responseCode`,
`responseTime`, and `responseSize`. It has no PR26 dependency and does not enable
request or Cookie extraction. Existing JSON/Header/XML/Text behavior and budgets
are unchanged. It does not complete the separate XML intrinsic-guard audit.

## Static evidence and compatibility boundary

Lawfully inspected sender `index.js`, SHA256
`5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`,
uses `pm.response.code`, `.responseTime`, `.responseSize` at LF-normalized
**character**, not byte, offsets 33595333 / 33595486 / 33595647. The shared
Text/Code/Time/Size assignment branch starts at 33599199: the expression is
ignored, the destination name is trimmed, and the raw source value is assigned
without String conversion. The source is read once per task before rows. No
original executable was run or proprietary implementation copied.

Workbench captures the original `pm.response` facade at bootstrap, then reads its
current own enumerable data field once per task, not once per row. Safe field
edits are visible; replacing the public facade, getter, or public setter does not
redirect trusted extraction. Metadata-only tasks do not parse/read the body or
consult header evidence and do not load the XML bundle.

Accept null, boolean, finite number, or valid-Unicode primitive string up to
64 KiB UTF-8. Reject missing/undefined, accessors, inherited/nonenumerable fields,
objects, arrays, functions, and nonfinite numbers before any row is assigned.
This is deliberately stricter than the original untyped setter behavior.
Code/Time/Size remain current processing-view fields, not authority to rewrite
stored original wire metrics. No complete original-runtime duration, compression,
protocol-overhead or size parity is claimed.

## Definitions and failure policy

An expression is optional, but if present must remain a bounded valid-Unicode
literal string. It is preserved verbatim through import/storage/restore and is
never a selector, template, regex, or evaluation hook. Raw destination names are
preserved; compilation trims and validates them exactly as for Text. Duplicate
trimmed names retain ordered assignment, rather than inventing deduplication.
Disabled descriptors remain inert. Enabled response extraction remains post-only.

Existing limits remain 16 tasks, 100 rows/task, 64 KiB/task definitions,
256 KiB/phase definitions, 250 ms active/2 s wall/16 MiB memory. Rows are prepared
before captured setters run; trusted completion and existing strict extraction
failure policy prevent failed phases committing scopes or continuing a plan with
stale extracted values. Already completed HTTP, successful pre-stage commits,
or published persistence effects are not rolled back by this guarantee.

## Verification scope

`native-pick-metadata.test.mjs` checks data grammar, scopes and scalar types,
current captured facade/public replacement, no body getter calls, invalid data,
Unicode/size bounds, task snapshot timing and trimmed-name collisions.
`native-pick-metadata-workflow.test.mjs` exercises real HTTP/1.1 and HTTP/2 native
import, three sources by three scopes, subsequent wire use, frozen snapshots,
backup/restore/restart, original wire metrics, failed-phase scope rollback and
independent project isolation. Test and CI results are commit-specific; this ADR
alone is not an acceptance claim.
