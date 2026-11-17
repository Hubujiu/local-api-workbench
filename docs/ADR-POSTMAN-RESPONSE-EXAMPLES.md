# Postman response examples: explicit safe media and header import

## Scope and defect

Independent functional branch `fix/postman-response-example-headers`, based on
`develop` `88f70bb515c48b93536b28b7fe3ec780f2e150f3`. This is not PR47's URL
normalization, PR51's request body modes, PR54's event scripts, or native export.

Previously `importDocument` retained only response name/code/body. A valid Postman
`Content-Type: text/plain` example such as `{raw:'雪😀'}` lost its media header:
Mock sent the JSON default and OpenAPI export tried `JSON.parse`, then failed.
The source header was discarded before the owner import saved the project.

Primary format basis: [Postman Collection v2.1 schema](https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json),
`definitions.response.header` and `definitions.header`. Response headers may be
object rows, strings, or null; header-object key/value are strings and disabled
is boolean. The [maintainer's Header implementation](https://github.com/postmanlabs/postman-collection/blob/develop/lib/collection/header.js)
uses case-insensitive lookup, permits multiple values, and excludes disabled
headers when serializing. We do not copy its implementation or claim support for
all valid Postman representations.

## Bounded admission contract

- Convert response examples before project mutation. Preserve original raw body
  text, name, status and active safe header values; normalize names to lowercase.
  `Object.fromEntries` preserves own-data keys such as `__proto__` safely.
- Disabled object rows are inactive, including a disabled duplicate or isolation
  header. Malformed key/value/disabled types reject; enabled duplicate names
  reject case-insensitively rather than silently merging or last-write-winning.
  Repeated headers can be valid Postman but are not representable by this map.
- Nonempty raw header strings and string array entries explicitly reject. No
  undocumented raw-header parser is introduced. Missing/null/empty-string/empty
  array or all-disabled headers retain the old no-header fallback. A body is
  never sniffed to invent `text/plain`. An explicitly absent Content-Type may
  still fail the existing JSON-default OpenAPI export for a non-JSON body.
- Every admitted example uses existing `validateMockResponse`, including its
  Unicode, status, body-size, header-size and HTTP-text checks. Transport and
  isolation headers, including Content-Length and Set-Cookie, **reject**; they
  are not silently stripped. False/numeric body values and code 0 now reject
  instead of being truthiness-coerced. Missing/null body still means empty text.
- For explicit Content-Type, reuse the current OpenAPI example converter's
  JSON/text media contract. JSON must parse; raw JSON text is not rewritten on
  import. Binary/unsupported media explicitly reject; XML media is inert text,
  without XML parsing or execution. Per-API 1000-example/8 MiB aggregate limits
  match the existing OpenAPI example interchange boundary; no budgets increase.

## Persistence and interchange boundaries

Full Workbench backup retains safe custom response headers and raw bodies.
OpenAPI interchange preserves supported media and JSON value/text semantics;
its existing example representation does **not** preserve arbitrary response
header maps or JSON whitespace. This change does not add response Header Objects,
cookie-jar import, originalRequest metadata, response-cookie metadata, raw binary
storage, Postman export, or full Postman project parity. Native export is a separate
root capability, not a dependency or standalone feature claim.

Postman import is an owner HTTP operation. MCP sync remains OpenAPI-only. Official
SDK HTTP and stdio consume the owner-imported APIs/frozen plans; they do not gain a
new Postman sync route. Rejected owner imports preserve project and project-file
bytes; global MCP activity bookkeeping is not claimed as an all-disk transaction.

## Verification

- Four inspected pure tests cover media/value conversion, exact raw text, absent
  versus disabled headers, active duplicate/unsafe/raw/binary rejection, and
  prototype-sensitive own properties without mutating source data.
- Two complete ordinary-CI workflows (HTTP/stdio SDK) cover owner mixed-import
  rejection/source/project/disk isolation, actual Mock selection and fallback,
  media OpenAPI export/reimport, SDK reading and frozen-plan consumption despite
  live URL edits, persisted results, full backup/restore, restart without replay,
  and explicit post-restart restored-plan execution with equal plan hash. Restored
  plans keep the original absolute source-Mock URL (no implicit project rebinding);
  the restored project's own Mock endpoint is checked separately.
- Locally only pure tests and static syntax/format checks are authorized. Actual
  workflow execution remains **pending the exact feature CI**; native root
  cross-format coverage must be verified separately after composition.

## Root composition acceptance

The integration root additionally has one full workflow for the already-supported
native JSON and native directory exporters. A legal Postman fixture uses one
`text/plain` and one `application/json` example with safe custom headers; owner
export/import, actual Mock bytes/headers, frozen consumers, durable results and
backup/restart are checked for both formats. Parameterized `text/plain; charset=utf-8`
remains a native-export refusal with unchanged project files and a usable full
backup. No native guards are removed: exact media names, unique status/media pairs,
metadata limits and other existing restrictions still apply. This root-only
workflow is pending root CI and is not evidence from the standalone feature CI.
