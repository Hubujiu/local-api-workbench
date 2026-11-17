# Ordinary HTTP extraction-list atomicity

This change applies only to the ordinary HTTP `request.extract` list. All rows
must resolve and pass the existing name checks and destination-scope checks before
any list value is published to runtime, hidden names, local variables, environment,
global variables, or the step's `extracted` result. Successful rows are applied in
declaration order; repeated destinations retain the last value. Existing JSON,
header, text, duration and cookie parsing is unchanged.

This is not a transaction for the entire post-response phase. HTTP 500 and failed
response assertions can still extract values, as before. A complete successful
list is available to later post operations and scripts. A later independent post
operation or scope persistence callback failure retains the previous runtime and
receipt semantics; environment/global rollback remains governed by the existing
phase contract. No network effect is rolled back or automatically replayed.
Native pick tasks and protocol-plan extraction have their own contracts and are
not modified here. Parsers, script engine, budgets and permissions are unchanged.

## Evidence

Base: fresh remote develop `88f70bb515c48b93536b28b7fe3ec780f2e150f3`, tree
`107767d4d92f69fc0b5a048d41371267fea5a568` (not the old local develop branch).
On this base, a real loopback HTTP response supplied token `fresh`; the second
extraction used a missing path. The step failed, but the following real HTTP
request sent `x-token: fresh` instead of the old value. The step also retained
partial `extracted` entries. This was reproduced before the production change;
the existing successful status/assertion extraction control passed on that base.

The focused tests cover missing/invalid later rows, hidden runtime names,
missing-first control, repeated targets, all four scopes, literal null/false/zero,
post-phase visibility, HTTP 500 and assertion-failure compatibility, and unchanged
later post-operation / scope-callback failure semantics. A real HTTP chain also
checks prior committed environment/global values through frozen-plan execution,
independent disk reads, stored failed history, backup/restore, restart and project
isolation. Stored JSON is compared to the serialized result, not to in-memory
optional fields whose value is undefined. No regex/XML or engine stress tests are
introduced. Independent CI remains pending until the exact published tree is
verified; local checks do not constitute complete product delivery.
