# Explicit bounded SDK URL mode

The existing default remains a primitive URL string. Selecting SDK mode is an
explicit per-request compatibility change, also applying to its shared scripts.
The UI explains the change and requires confirmation; cancellation leaves the
previous mode intact. The mode persists through request/plan/project JSON.

SDK mode uses the reviewed URL-only adapter rather than URLSearchParams as its
script facade. Query members and path-variable members remain live within a
phase. Request query shortcuts delegate to that same object. Replacing the URL
detaches old references; assigning a previously held URL restores its associated
metadata. State is captured with the strict descriptor-based codec between fresh
VMs, without copying methods, invoking user serializers or retaining VM globals.

## Stored table data versus raw URL data

Literal URL query members preserve their raw escaping. Existing Query table
members retain their form-encoding policy, including the empty-value equals
option. The policy and dynamic definition follow member identity, not array
index or duplicate name. Newly added SDK members use SDK raw-query semantics.
Serialization therefore does not double-encode existing raw percent escapes or
turn a table's literal plus into a space.

Path segments that are exactly `{name}` become SDK `:name` segments, matching the
statically inspected original adapter. Embedded brace text is not broadened into
a new replacement language. Enabled Path rows become SDK variables; disabled
Path definitions remain separate metadata and never enter SDK lookup or invoke
a provider. Native SDK variables created by a script retain SDK truthy-string
substitution and suffix behavior, including its existing disabled-field behavior.

## Resolve once using existing request budgets

Before resolving, active SDK query/path jobs are mapped into the existing dynamic
request resolver. They share the same request-wide 100-value, 20-transform and
5-second limits with headers, body and other fields. This is one resolver call,
not a second independent allowance. Script source and inactive metadata are not
interpolated. Resolved field values are copied back and serialized only once;
generated text containing template-looking braces is not interpolated again.
Disabled/deleted members never invoke their providers. The post phase sees the
resolved SDK state without repeating generation. Saved source requests are not
mutated by execution.

The existing 16 MiB VM, 512 KiB stack, 250 ms activity and 2-second worker limits
remain unchanged. The closed facade bundle contains only the reviewed URL asset
and local state/runtime/facade modules. Its source/output hashes are recorded,
rebuilt in CI and protected from checkout line-ending conversion.

## Explicit limits and verification

This remains a bounded SDK subset, not full Postman or Apipost compatibility.
Function-valued variables, arbitrary SDK extensions, external secret resolvers
and state exceeding 64 KiB are rejected. cURL and OpenAPI exports currently reject
SDK URL mode rather than silently emit a request with different semantics. Native
project JSON preserves the mode and source data; HTML/Markdown describe the mode
and distinguish definitions from executed requests.

Fixed tests cover real HTTP pre/post execution, shared-stage state, member
identity, dynamic aggregate limits, raw/form escaping, inactive metadata, default
string compatibility, export rejection and exact-byte build inputs. Browser and
packaged desktop fixtures exercise the actual opt-in control and network path;
their results must be verified on the matching commit before delivery claims.
