# Bounded live Header entries

Primary static reference: postman-collection 5.3.1 Header declares a
case-insensitive key index; PropertyList one/all/each expose member objects,
and count reports member count. The full third-party SDK is not executed or
adopted. No production dependency is added.

The existing request facade supplied detached all/each snapshots and lacked
one/idx/count. one now selects the last matching case-insensitive header,
including disabled rows; idx uses integer indexes and missing entries return
undefined. all returns a new array of live entries, and each traverses a snapshot
of those entries. Entries support key/value/description/disabled assignment and
update. An enabled boolean alias preserves access to the prior snapshot field.
get/has/toObject and detached getHeaders retain their existing contracts.

This deliberately corrects all/each mutation semantics: editing a returned entry
now changes the current request. Editing the returned array does not reorder or
remove collection members. Unknown properties, deletion, prototype changes and
freezing are rejected. Removed/replaced entries cannot modify their replacements;
updates validate a complete candidate before mutating. Unknown nonenumerable
and Symbol properties also reject rather than silently becoming no-ops. Unexposed request-row
metadata stays intact, and saved definitions are not changed by execution.

Bounds: 1000 rows, 1KiB nonempty key without NUL/CR/LF, 64KiB text value,
8KiB description and 256KiB total. Text must be well-formed Unicode. Updates
accept text values and explicit boolean states; conflicting enabled/disabled
values reject. Runtime HTTP header validation still applies. Existing add/upsert
and shortcut behaviour is not redefined, and this is not complete PropertyList
compatibility. VM/network/time budgets remain unchanged.

Red regressions establish missing methods; tests verify identity, duplicate
lookup, live edits, metadata preservation, atomic rejection, stale references and
real HTTP. Browser and packaged runtime fixtures exercise the live mutation while
retaining prior shortcut/null-header and disabled-header checks. Exact-head CI is
required before marking the change verified.
