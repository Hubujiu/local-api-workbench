# Extended Apipost authentication import

## Scope

Native/legacy API imports previously accepted Basic, Bearer and bounded JWT only,
even though the request engine already implements API keys, AWS SigV4, Hawk and
EdgeGrid. This adapter maps native kv/awsv4/hawk/edgegrid data to those existing
implementations. No proprietary signing code, new dependency, credential grant,
token acquisition, remote call or license bypass is introduced by import.

The native field names were inspected in locally obtained official Offline2
configuration data. All new committed fixtures are independently authored and
synthetic. Full original-runtime equivalence for these four modes is not yet
established; passing our contracts does not establish all original signing flags.

## Contract and explicit rejection

- Auth input is at most 64KiB. Only recognized active-section fields are accepted;
  values retain string types and templates rather than being coerced from objects.
- kv maps header/query only. Invalid locations and header names reject.
- awsv4 maps explicit access/secret/session keys, region and service. Query
  presigning is rejected rather than silently turned into header signing.
- hawk maps authId/authKey, app/delegation, extraData, nonce and timestamp. The
  payload-hash choice is explicit. Only sha1/sha256 are supported; the unknown
  native user extension is rejected when nonempty.
- edgegrid maps baseURi to baseURL and retains configured signing headers, nonce
  and timestamp. Existing runtime constraints and signing behavior remain.
- Other native authentication types remain unsupported by this extension. Basic,
  Bearer and JWT keep their existing import behavior. Native plan-step overrides
  retain the separate bounds in PR #7; this PR does not silently broaden them.

Authentication metadata is explicit project configuration and is persisted just
like existing imported Basic/Bearer settings. It is not an ephemeral database or
MCP execution grant. Never share real exported project secrets as test fixtures.

## Verification

Synthetic real-HTTP tests cover header/query credentials and exact wire signatures
using already-tested signing providers, global/folder/API precedence, source input
immutability, save/reload/backup restoration and untouched unrelated projects.
Malformed objects, unsupported flags, oversized data and unknown active fields
reject before destination mutation. Existing provider suites retain independently
published AWS/Hawk/EdgeGrid signature vectors and actual HTTP verification.

This is an isolated feature branch based on develop. Exact-head CI must be checked
before acceptance; no main/develop merge or deployment is included.

## Original-runtime correction: native Query API-key encoding

A controlled original loopback request with a fictional Query API-key value
containing a literal plus and a space sent `+` and `%20`. Its same-name collision
also replaced the old Query value. The first adapter used generic API-key encoding
(`%2B` and `+`) and was therefore NOT accepted despite green CI. A failing wire
regression captured the discrepancy before correction.

Native Query imports now explicitly carry `queryEncoding: apipost`. The shared
request/cURL helper preserves native plus/percent spelling, lets URL serialization
encode spaces and replaces matching names without reserializing unrelated fields.
Ordinary API keys keep their existing form-style encoding. Save/restore retains
the marker; unsupported marker/type/location combinations reject.

The compatibility path is deliberately bounded: resolved names must use ASCII
unreserved characters; raw ampersands, fragment delimiters and control characters
in values reject before network or cURL generation. It does not reproduce unsafe
parameter/fragment injection. Templates are resolved before this runtime check.
Real HTTP tests cover original-observed spelling and collision behavior, cURL
roundtrip, unchanged generic behavior and zero-network rejection. Original full
signing equivalence for AWS/Hawk/EdgeGrid remains unverified; their tests use
synthetic inputs and the existing independently tested signing implementations.
