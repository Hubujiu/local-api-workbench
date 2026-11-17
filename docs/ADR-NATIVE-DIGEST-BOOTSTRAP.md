# Native Digest credential/challenge bootstrap

Status: approved domain; implementation and ordinary CI acceptance pending.
Runtime prerequisite: PR20 `53444789c950a2c914f442d764308d7df09b1345`.
Dependency-only base joins original PR14 base
`03b3e52bd5e3e26b389611939e862e67b1c80b52` with that runtime head. Existing PR14
feature `dc4f69fe42e08a89c1efd40c93ad7fd0657cc2bf` stays above the dependency base,
not inside it. No broad integration-root ancestry is used.

## Static evidence and deliberately limited semantics

The legally acquired Apipost 2.0.0 package SHA256 is
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`;
decoded send-index.js SHA256 is
`5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`.
Native defaults occur near character offset 9946631. The actual native-to-sender
mapping at 33608200–33608950 includes nc→nonceCount, cnonce→clientNonce and
explicit disableRetryRequest. Original handler near 27819980 checks preexisting
nonce+realm and processes 401 or 403; near 27826300 it skips signing without a
truthy username or realm. These are decoded character offsets, not byte offsets.
No proprietary source is copied and no original application is run.

This adapter is an explicit Workbench **401-only challenge bootstrap**. It is not
original execution/wire equivalence, preemptive authentication, cached challenge
state, original 403 replay or general Digest state migration. The existing PR20
parser, first-supported-offer policy constraint, exact entity retry and original
deadline/cancellation/cookie gates remain unchanged. In particular, a fixed MD5
policy cannot skip a supported stronger first offer to find a later MD5 offer.

## Accepted native definition and canonical Workbench form

Selected native digest section has exactly these possible own fields:
username, password, realm, nonce, algorithm, qop, nc, cnonce, opaque,
disableRetryRequest. Unknown fields are rejected even when empty. Plain or
null-prototype objects with enumerable own data properties only; reject symbols,
hidden fields, accessors and custom prototypes without invoking getters/toJSON.
The native auth envelope may retain unrelated inactive sections; only its type
and selected digest data descriptors are read. Known present fields with undefined values are
rejected; omitted fields follow only the defaults explicitly listed below.
This is a helper boundary, not
an arbitrary-JavaScript whole-project safety guarantee; owner inputs are JSON.

- username: a nonempty string. password: string, omitted becomes empty string.
  Credentials are copied without evaluation; ordinary credential templates
  remain literal during import/export. A nonempty template can resolve empty at
  execution, which follows Workbench semantics, not the original empty-username
  behavior. Ordinary Workbench Digest empty usernames are not changed.
- realm, nonce, qop, nc, cnonce, opaque: omitted or empty string only. Reject
  nonempty state, null and nonstring values instead of silently losing them.
- algorithm: omitted/empty becomes explicit MD5. Otherwise accept only MD5,
  MD5-sess, SHA-256, SHA-256-sess, SHA-512-256, SHA-512-256-sess. No templates,
  coercion, case guessing or automatic-algorithm alias.
- disableRetryRequest: omitted becomes false; present must be boolean. Reject
  numeric and string flags, including the ambiguous string "false".

Import produces exactly:

```
{ type: "digest", username, password,
  challengePolicy: { algorithm, retry: !disableRetryRequest } }
```

Export accepts only the four possible own Workbench fields above, with a valid
explicit complete policy. Workbench password omission canonicalizes to an empty
string, matching its existing signer; a present nonstring/undefined password is
rejected. It rejects legacy automatic-negotiation definitions without a
policy: a fixed native algorithm cannot express unrestricted server negotiation.
It also rejects old ignored top-level algorithm/disableRetryRequest and any other
extra field, even empty, rather than silently dropping saved data. Full project
backup remains available for unsupported definitions.

Export emits the six empty state fields and explicit algorithm/switch. Both
input and canonical output selected sections are bounded to 64 KiB **UTF-8 JSON
serialized bytes**, measured only after safe descriptor and primitive-type
validation. No supplied toJSON or credential interpolation is invoked. The
canonical output is also checked during import (defaults and six empty state
fields can add bytes), so every accepted import remains exportable and export
cannot create a section import would reject. Import of exported native data must deep-equal the canonical Workbench
definition. This is inverse canonical stability, not original omission presence.

## Safety, persistence and errors

Conversion performs no signing, challenge acquisition, key parsing, file access,
template evaluation or network call. Unsupported imports/exports fail atomically
without partial artifacts or project mutation. Errors use fixed redacted field
categories/paths, never supplied field names, values, passwords or parser causes.

Definitions persist in the existing project/backup/frozen snapshot model; no
realm/nonce/opaque/cnonce/nc learned from a response is written into credentials.
Existing owner/CLI/MCP project permissions and request authority remain intact.
No runtime/parser change, original 403 retry, challenge cache, stale loop,
redirect support, VM/transport/job budget increase or new licensing belongs to
this native adapter. Public OpenAPI mechanism projection must not expose the
same credential values used in the private native roundtrip fixtures.

## Complete acceptance

- Pure full field/default/type/descriptor/unknown/byte-bound matrix; both source
  and output caps, templates preserved only in credentials, explicit-policy
  required, prestate never discarded, canonical inverse in both directions.
- Native JSON and directory formats through actual owner import/export/reimport,
  save/reopen, backup/restore and frozen plans, then explicit real HTTP Digest
  challenge-response with independent verification for all six algorithms.
  Include auth-int exact entity bytes and session variants, fresh per-execution
  challenges, credentials templates and project isolation.
- Retry-disabled malformed 401 is retained with one request; mismatch cannot
  downgrade; failed credentials stop after one authenticated retry. Policy and
  imported definitions survive persistence without response-learned state.
- Actual official SDK and CLI execute reimported definitions, not hand-built
  replacements. Invalid private native definitions reject atomically/redacted;
  public mechanism projection uses identical real fixture auth values.
- Root-only project/folder/own/noauth inheritance, preserve/flatten import,
  frozen/restored plans and nested/redirect combinations are integrated and
  validated separately without widening PR14's dependency base.
- All runtime evidence comes from ordinary CI; local checks are static/syntax/
  formatting. Feature and root green results require complete job/artifact
  evidence and actual portable-package byte verification at root integration.

## Integrated OpenAPI boundary

The integration's existing OpenAPI definition projector deliberately rejects
Digest with HTTP 400 rather than silently exporting an unauthenticated operation.
Its root-only owner workflow therefore requires the exact redacted rejection,
no partial document, unchanged persisted project and zero peer requests for that
export. The feature baseline's older public exporter is a different contract.
Both retain all native-format roundtrip, frozen/restart and SDK/CLI assertions;
no production OpenAPI behavior is changed to satisfy this test.
