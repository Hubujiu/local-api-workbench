# Bounded native responseCookie extraction

## Scope and provenance

The existing draft PR25 gains AFTER-only `pickVars.data.source=responseCookie`.
This is not complete vendor parity, a Cookie jar change, a new parser, or authority
to execute the original application. PRE sources remain requestHeader/requestBody.

Lawful original static input: `index.js`, SHA256
`5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`.
Offsets below are LF-normalized Unicode text character offsets, not bytes.
Original Cookie initialization around 33572150 reads Set-Cookie and its first
semicolon-delimited pair, splits at the first equals (helper around 33562972),
keeps subsequent equals, skips empty names/values, decodes percent escapes with
raw fallback and uses Lodash path assignment. Cookie task dispatch around
33595178 captures `response.cookies` once as an object reference; the row branch
around 33598711 trims expression, does not trim target name, selects with Lodash
get, and passes the raw value to the destination setter without a row-level catch.
Scope mapping around 33593575 is temporary/environment/global. No proprietary
implementation is copied. Static source does not establish original execution.

## Shared dependency, not feature ancestry

`deps/native-cookie-evidence` starts at exact GitHub develop 88f70bb / tree
107767d4d92f69fc0b5a048d41371267fea5a568, not the stale local develop tree.
It contains only the existing `native-cookie-name.mjs`, complete
`response-header-evidence.mjs`, and standalone evidence tests. Production module
blobs are identical to the existing integrated implementation:
`e25fed1491262d73ab88adf57874e10fa789d085` and
`c7a0398901035bb4b30e05ec4768805cda4b0fd5`.
The common branch does not itself hook transport or execute pick/assertion logic.

PR25's isolated base joins PR9, the common dependency, and existing verified
PR3/35/38 runtime dependencies, with no PR25/26 business ancestors. Existing H1/H2
capture hooks now provide the same Cookie WeakMap evidence already used by the
assertion feature. PR26 is not rebased or modified solely for ancestry. No new
parser or public compatibility-parser behavior is introduced.

## Exact bounded contract

- Preserve original declaration, including expression whitespace and raw target
  name. Compile expression.trim() as one case-sensitive ordinary Cookie name.
  No template, Lodash paths, case folding, prototype lookup or getter execution.
- Reuse unchanged full Header/raw-pair completeness checks, independent Cookie
  evidence, 256 pairs and cumulative 64 KiB raw Cookie Unicode bytes. Names must
  satisfy the existing ordinary-name grammar and reserved-name exclusions.
- Any duplicate name, unsupported name, empty raw value or raw value with edge
  whitespace makes Cookie evidence globally incomplete; Header evidence remains
  separate and usable. Valid distinct names and extra equals are preserved.
  Percent decode errors preserve raw values; encoded whitespace is supported.
- Bootstrap captures the compatibility map identity and checks its exact own-key
  projection against the private transport values once. User/history/cloned
  responses cannot manufacture WeakMap evidence. Whole public map replacement or
  replacing public getter/setter functions cannot supply a different source.
- Each task takes the captured map reference once, not a deep copy. Each row reads
  its current own enumerable data descriptor; safe current string edits become
  visible to later picks. Empty current strings are allowed. Current additions
  without original evidence, deletion/missing, accessors, nonstrings, invalid
  Unicode or values above 64 KiB UTF-8 fail explicitly.
- Prepare every row before any captured setter. Existing phase completion checks,
  strict plan stop, scope rollback, 250 ms/2 s/16 MiB execution budgets remain.
  Successful earlier phase commits and completed network work are not undone.
- Cookie-only does not read body, initialize XML or call public Cookie readers.
  Disabled and historical inert declarations do not activate Cookie reads.

Deliberate stricter differences: original allows Lodash paths, duplicate overwrite,
undefined selection and incremental row assignment. Workbench rejects those,
requires trustworthy complete transport evidence and all-row preparation. Original
can replace the public source object before a task; Workbench fixes bootstrap map
identity for safety while retaining current-field reads. This is neither arbitrary
Cookie semantics nor full original-runtime equivalence.

## Validation scope

Standalone evidence tests cover parser-equivalence boundaries and Header isolation;
feature tests cover own descriptors, public replacement, current edits, exact
projection and all-row preparation. Real HTTP/1.1 and HTTP/2 workflows cover import,
three scopes, same-phase edit/later pick, next wire request, frozen plan, backup,
restore/restart, project isolation, failed later row and failed post stage rollback.
Original format export, official MCP and CLI combined workflows are independently
verified in the integration branch, not implied by standalone backup tests.

The previously interrupted XML specialist and engine/schema investigations remain
outside this increment. Existing tests do not substitute for those audits.
