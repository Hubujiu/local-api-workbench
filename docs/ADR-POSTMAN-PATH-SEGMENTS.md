# Postman path-variable segment identity

## Defect and scope

On PR174 base `3b7025c397300ec3b1822a72d0bb6e79287455ba`, the importer
rewrote `/:user-id` as `/{user}-id`. With `user-id=alice` and `user=wrong`,
the existing transport sent `/wrong-id`, not `/alice`, without an error.
Both raw and structured Postman URLs used the same prefix-only regex.

The fix treats each slash-delimited path segment independently. Only a leading
colon starts a variable. The complete name ends at the first dot or the end of
the segment. The remaining suffix is unchanged. Raw URLs retain the existing
authority/query/hash boundaries; structured URLs use the same helper.

## Public source and implementation choice

The boundary rule follows `parsePathVariable` and `Url#getPath` in the official
Postman Collection SDK v5.2.0, commit
`1c32d038724699fa7d2483e0a3bb45405e46bbb8`:
https://github.com/postmanlabs/postman-collection/blob/1c32d038724699fa7d2483e0a3bb45405e46bbb8/lib/collection/url.js

This is a small equivalent boundary adapter, not a copied SDK or new dependency.
The already pinned URL encoder does not expose this collection-variable parser;
adding the complete SDK solely for this lexical rule is unnecessary. We read
public source, not run the proprietary application or use private user samples.

## Compatibility and limits

- Supported names are ASCII letters, digits, underscores and hyphens. Existing
  simple names and `.json`/multi-dot suffixes remain valid. The dot belongs to
  the suffix, not the variable key.
- Unsupported complete names reject explicitly instead of substituting a valid
  prefix. This intentionally changes formerly accepted-but-misbound names such
  as `:id:action` into an import error.
- A colon not at a segment start and percent-encoded colon remain literal.
  Empty variable names remain literal, matching the SDK boundary rule.
- Repeated references such as `/:id/:id.json` keep existing replace-all behavior.
  Identical enabled string definitions with the same key remain accepted.
  Conflicting duplicate definitions reject: the SDK selects the last enabled
  definition while the existing Workbench binder uses the first. This is an
  explicit restriction, not a claim of SDK duplicate-resolution parity.
- Value encoding remains the existing Workbench `encodeURIComponent` behavior,
  including encoding slash, percent, spaces and Unicode. No decoding or second
  interpolation is added. This fix does not claim full SDK encoding, empty-value
  or disabled-variable semantics, and does not rewrite already saved requests.
- No new persisted marker, runtime budget, execution scope or script-state
  mechanism is introduced. Backup/freeze retain corrected `{user-id}` text and
  path rows. Native export/reimport and resolved cURL use existing representations.

## Verification

Synthetic loopback tests cover raw/structured forms, full-name/prefix collisions,
repeated references, suffixes and encoded values. Owner/MCP execution, cURL,
native export/reimport, frozen plans, backup restoration and restart are covered
by `postman-path-segments-workflow.test.mjs`. Local reproduction of the old
binder confirmed both repeated references and identical duplicate definitions
already worked, so those behaviors are retained. These are synthetic fixtures,
not proprietary application conformance runs.
