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
get/has/toObject now follow the bounded collection reader contract below;
getHeaders(options) remains the separate detached request-level reader.

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
values reject. Runtime HTTP header validation still applies. Existing add and shortcut behaviour is not redefined; upsert is corrected below, and this is not complete PropertyList
compatibility. VM/network/time budgets remain unchanged.

Red regressions establish missing methods; tests verify identity, duplicate
lookup, live edits, metadata preservation, atomic rejection, stale references and
real HTTP. Browser and packaged runtime fixtures exercise the live mutation while
retaining prior shortcut/null-header and disabled-header checks. Exact-head CI is
required before marking the change verified.


## Collection reader semantics

Static PropertyList/Header reference also establishes that get returns the last
matching member value even when disabled, has can match any duplicate value or
a member's actual identity, and Header.valueOf returns its value. The previous
facade incorrectly skipped disabled entries and ignored the optional has value.
Correct these readers; wire transmission still excludes disabled rows.

HeaderList.toObject defaults to lowercase keys and includes disabled members.
Boolean excludeDisabled/caseSensitive/multiValue/sanitizeKeys positional options
are accepted. Header permits multiple values intrinsically, so repeated keys
remain arrays even when multiValue is false. Returned objects/arrays are detached
and prototype-like names remain own data properties. Existing nonempty-name and
size validation still applies; permissive truthy option coercions and all generic
PropertyList behaviours are not claimed. This intentionally replaces the old
filtered/case-preserving last-value snapshot. Use getHeaders({enabled:true}) when
an enabled-only request-level read is wanted.

Regression first shows disabled reads, value membership and toObject differing;
then verifies corrected semantics, live-member identity, detached output and
unchanged on-wire disabled filtering.


## Bounded collection iteration

Function-only each/map/filter/find/reduce run within the same VM and existing
budget. Explicit callback context is supported. each defaults to the request
facade and stops on exactly false; map/reduce default to the Header collection.
filter/find use the supplied context. Callbacks receive live entries, index and a
new snapshot array; reduce additionally receives an explicit initial accumulator.
Additions during traversal do not extend that snapshot. Selected entries remain
live, but modifying the returned array does not change membership. Exceptions
propagate rather than turning into successful results.

Static PropertyList reference establishes callback context, early termination
through its forEach, and collection iterator methods. This implementation does
not accept Lodash predicate shorthands, claim mutation-during-iteration equivalence,
or implement omitted-initial reduce inference. Existing header validation and
stale-entry protection remain unchanged. Regression first reproduces ignored
context and missing methods; browser and packaged fixtures exercise traversal
and a selected entry's actual mutation without replacing existing wire assertions.


## Last-member upsert

Static PropertyList.upsert selects one(key), updates that member in place and
returns false; insertion returns true. The old facade removed every matching
header, re-appended one replacement, lost member identity and re-enabled disabled
members. The bounded replacement edits only the last case-insensitive match,
preserving other duplicates, order, metadata, identity and an omitted disabled
state. Explicit state remains validated. Missing value becomes empty text and
existing scalar/string coercion is retained. New rows validate the entire
candidate before publication. Unknown own keys (including hidden/Symbol keys)
reject atomically, reserved-name restrictions stay unchanged, and this does not
introduce Header.system or arbitrary upstream properties.

Fixed verification covers return values, duplicate identity/order, disabled state,
invalid patches and actual repeated-header HTTP. Browser fixture upserts the last
duplicate then checks both wire values; packaged fixture checks stable identity.
