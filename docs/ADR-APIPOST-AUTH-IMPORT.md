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
- awsv4 maps explicit access/secret/session keys, region and service. Explicit
  S3 Query presigning now follows the bounded runtime dependency below; unsupported
  services are rejected rather than silently turned into Header signing.
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

This feature now stacks on the separate Query runtime branch. Exact-head CI must be checked
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

## Representative original signing observations

Normal original UI requests with fictional credentials were sent only to a local
fixture. AWS SigV4 matched the existing provider when the probe used all original
SignedHeaders (including Accept/Accept-Encoding), body, timestamp and session
value. An initial probe omitted two signed headers and was invalid, not an engine
regression. EdgeGrid POST authorization also matched for the observed body and
captured timestamp/nonce. These are controlled vectors, not production-account
access or universal header/default equivalence.

Hawk sha256 matched with payload hashing disabled. With hashing enabled and
ext/app/delegation set, a native Text body without an explicit Content-Type signed
as an empty media type even though the wire later contained text/plain. Adding
Content-Type explicitly made its hash and MAC match. Workbench continues signing
the final wire media type/body, rather than copying this inconsistent signature.
The committed native POST regression is checked by Hawk.server.authenticate with
payload verification after save/reload and backup restore, both with inferred and
explicit Content-Type. Empty native Hawk algorithm also produced an empty original
Authorization header; our importer deliberately rejects it instead of silently
sending an unauthenticated request.

The live original directory (21 JSON files, two frozen plans plus the edited API)
was imported locally again, saved/reloaded, backup-restored and exercised through
eight real HTTP requests after the EdgeGrid edit. Frozen plan authentication did
not inherit the newly changed live API authentication; source bytes were unchanged.
Raw source archives remain local. These observations do not cover all optional
signing settings, services or resource kinds.

## Bounded S3 Query runtime dependency

This native import feature now stacks on the independent AWS Query runtime PR22
rather than duplicating its implementation. Native awsv4 explicitly retains the
boolean addAuthDataToQuery flag; true requires a literal s3 service. Unsupported
services/flags reject instead of changing to Header authentication. The runtime
further requires GET/HEAD and an empty serialized body, canonical paths and a
single bounded expiry parameter; it does not add native plan-step auth overrides.

The independently authored modern-source fixture uses project-level inherited
S3 Query authentication. Its actual HTTP frozen-plan and official MCP SDK API
requests are verified by the same independent node:crypto loopback verifier as
the runtime feature. Concurrent projects keep different identities; live API
auth changes cannot replace frozen auth, full HTTP backup/restore and app restart
preserve the definitions, and invalid flags/services leave the destination intact.
No source URL is populated with generated signature parameters. This is not a
new original GUI run or real AWS account verification. Definitions/history may
contain explicitly configured secrets and wire session tokens; follow the
sensitive-storage boundary in ADR-AWS-QUERY-PRESIGNING.md.

## Explicit no-auth and resolved-source isolation

A confirmed importer bug mapped native `noauth`/`none` to Workbench `none` but
left target inheritance enabled. Importing into an existing project with global
Bearer authentication could then add unrelated target credentials to a source
request explicitly requiring none. This was reproduced with fictional values;
no real credentials or accounts are used.

Legacy explicit `noauth` **and** `none` now set `inheritAuth:false`. Completely
absent legacy authentication retains its previous default; this fix does not
redefine ambiguous old-format omission, generic Workbench `none`, OpenAPI/Postman
imports or ordinary target-project requests' inheritance settings.

The modern JSON/directory adapter already resolves project → ancestor folder →
request native authentication before calling the legacy field mapper. All those
resolved requests now set `inheritAuth:false`, including explicit none/noauth,
source `inherit` resolved to none, and a fully absent modern source chain (whose
existing native default is noauth). Source Bearer/Basic/signing values and existing
source precedence stay unchanged. This prevents a second resolution against the
destination's unrelated global/folder credentials. It grants no DB access and does
not restore stripped credentials.

Independently authored fixtures verify actual localhost Authorization through the
owner HTTP import/plan/run APIs, not only stored models: both modern JSON and native
directory input, source scopes, explicit noauth/none, absent modern source,
Bearer/Basic, frozen plans, changed live models and target auth, backup/restore and
restart, and another project remaining unchanged. Legacy explicit spellings and
ordinary/absent-legacy inheritance are separate controls. Native export/reimport
and MCP/CLI historical-flow combined verification belongs to the integration
branch because this independent feature base does not contain those exporters.

## Explicit Postman / OpenAPI opt-out isolation

Postman effective source authentication is resolved through the existing collection,
folder and request hierarchy. Only effective `type: "noauth"` disables Workbench
shared-auth inheritance. Missing/null children can inherit a parent's explicit
noauth; explicit child credentials still override it. Missing/null without such a
parent retain the existing Workbench inheritance policy.

OpenAPI operation-owned `security` overrides the root for this decision. Only a
selected array of length zero sets `inheritAuth: false`. Absent declarations,
null, optional `[{}]`, and nonempty schemes are not reinterpreted as opt-outs.
Existing security metadata is retained unchanged. This does not implement credential
generation from OpenAPI security schemes or change generic shared-auth defaults.

Official contracts: [Postman No Auth](https://learning.postman.com/docs/use/send-requests/authorization/authorization-types/),
[Postman inheritance](https://learning.postman.com/docs/use/send-requests/authorization/specifying-authorization-details/),
[OpenAPI 3.0.3 Operation Object](https://spec.openapis.org/oas/v3.0.3#operation-object).

`interchange-noauth-import.test.mjs` records real loopback Authorization headers
for twelve source hierarchy / override / inheritance cases through authenticated
owner import, frozen execution, subsequent live/shared-auth edits, restore and
restart. Source inputs and an unrelated project remain unchanged. Before the fix,
the explicit Postman request opt-out sent `Bearer fictional-global` instead of no
Authorization header. The existing native opt-out and core whole-file regressions
remain part of the same focused batch; no real accounts or secrets are used.
