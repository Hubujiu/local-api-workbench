# Deferred Postman raw-body media defaults

Status: implementation checkpoint; real owner/VM/wire contracts await exact CI, not delivered. Fixed dependency PR51 at 0118e16c1f0b2f949d7801d9590a8f878581d480 remains unmerged. No new library, frontend, file upload or original runtime execution.

## Proven gap and reference

Official Apache-2.0 postman-runtime 994227833937323480ceda4682609ae3a5c41284 `lib/requester/core-body-builder.js` blob 68ea0b25dd93301d1834be6fff131fcfbb484986 generates a system Content-Type for nonempty raw bodies: lowercase html→text/html, xml→application/xml, javascript→application/javascript, text/absent/unknown→text/plain (json→application/json has additional existing constraints below). This is not merely an editor hint. `core.js` blob a1936bbc8df2e5dd7bc7f576bfb15185051c6ed7 invokes the builder then extracts enabled headers; `requester.js` blob 3bd8a9e30290c4503c7ffb47b0cd93516e782642 passes these options to the postman-request wrapper. `item.command.js` blob 9d45c331eefb7f652b428506ca939647c6f4499a executes pre-scripts and applies header/body changes first.

The existing importer keeps only json-versus-raw and loses non-JSON language; the raw sender has no generated Content-Type. Thus the ordinary nonempty POST XML input without an explicit header changes its media contract. PRs1–95 were checked: PR51 owns GraphQL/body-mode support and leaves this conditional unchanged; PR66 response examples and PR69 multipart part media do not implement it.

## Intended bounded model

Add source-specific `postmanRawBody:{version:1,language}` only to imported non-JSON raw bodies. Language is xml/html/javascript/text or default (absent/empty source language); unknown nonempty literal labels map to text. Scripted JSON switching may retain the lineage with language json. Preserve it in normalization, frozen plans, store and backup/restore. Do not append an explicit header at import time: scripts must see their authored headers, and the default is selected after pre-scripts. For an active, nonempty raw body, derive media from the marker only if no enabled case-insensitive Content-Type exists. Enabled empty Content-Type is an explicit override; disabled-only headers permit fallback. Existing duplicate Content-Type refusal stays unchanged. Because upstream absent-language presend has special JSONC/header-reference behavior, default-language raw requests with ANY Content-Type row (including disabled or empty rows) explicitly reject before wire. This deliberate stricter subset avoids inventing JSONC behavior; explicit text/xml/html/javascript retain the preceding header rules. Ordinary canonical raw requests without the marker stay unchanged.

Empty raw bodies generate no default; whitespace is nonempty. Methods GET/HEAD with nonempty marked bodies reject before network instead of silently adopting the upstream method-pruning behavior or changing native raw semantics. COPY/PURGE/UNLOCK are already refused by the existing canonical method allowlist. Unsupported outer protocolProfileBehavior is explicitly outside this slice and must reject for selected marked requests rather than guessing disableBodyPruning/disabledSystemHeaders.

SDK5.3.1 RequestBody (`e2453a5c1eb23f92f09df68712b30a87f775bb6d`, blob e920ca66ff79a0c0cdc3fefcc8f314fcf7360fd4) successful update replaces options; string update resets language to default (whose ordinary wire fallback is text/plain). Marked script updates must follow that rule without changing old unmarked shortcut semantics. Explicit raw language changes and header changes affect the late default. Existing form switches remain form semantics, preserving lineage for later raw updates; no file capability is added. getFinalRequestRawBody preserves the prior media marker around its internal setter, so reading/resolving final bytes does not itself switch XML to text.

JSON is not generalized here. Existing imported JSON remains the existing canonical JSON path. Official presend strips comments (`request-helpers-presend.js`, blob 4dcfb0364c1f5508dc82159819a760c9edee6e56), and empty JSON differs from the canonical fallback object. A marked request that scripts switch to JSON must remain within a validated nonempty JSON subset, not silently claim JSONC or empty-body parity.

Static cURL/OpenAPI exports materialize the known media default on a copy without changing explicit headers. They reject own/effective shared before-scripts, before-operations, unresolved body templates and dynamic body metadata rather than predicting output. OpenAPI additionally rejects empty raw bodies and explicit empty Content-Type because its existing representation cannot faithfully preserve these. cURL retains its explicit-empty-header representation. Root integration separately checks native exporters unavailable in this minimal base.

## Planned validation

Dependency-free RED tests exercise the extracted original conversion and fail on all four lost identities. True owner import→freeze→loopback bytes/media→scripts/results→backup/restart/isolation contracts will be authored for normal exact CI; local owner executions are zero while node-oauth1 is unavailable, with no dependency-resolution workaround. Cover explicit mixed-case/empty/disabled headers, empty/whitespace bodies, raw script changes, bounded JSON/form transitions, GET/HEAD and unsupported-config zero-wire failures, atomic invalid mixed imports and static export roundtrips. No VM/XML parser or original execution is part of local validation.

## Current local evidence

The extracted original projection produced four real RED assertions and one unchanged JSON control. The implemented pure helper suite currently passes 22/22. The authored owner/script workflows have only syntax/format verification locally (0 runtime executions); normal exact CI is required. No dependency bypass or original/VM/XML-parser execution occurred.

OpenAPI resolves only effective inherited Content-Type for marked requests (not unrelated global query/cookie/auth values). It represents that header once as requestBody media, excluding the redundant Content-Type header parameter so export→import cannot create a duplicate control header. Marker preflight runs before authentication/cookie/connection preparation, with a final body check retained; it does not weaken cancellation or existing duplicate-header rejection.

Marked static exports also reject active template Header names and dynamic Content-Type providers, before owner cURL attempts resolution. A static header placeholder cannot be mistaken for a non-media header and a fixed/variable/mock provider cannot be treated as its stale displayed value. Negative owner tests verify unchanged project/disk and no wire traffic.

For marked raw object script updates, disabled is accepted only when absent or strictly false. true and truthy/coerced non-booleans explicitly reject instead of silently sending a body upstream would suppress; old unmarked script behavior is unchanged.

Final-body resolution validates marked JSON after variable substitution, before its internal setter can downgrade invalid JSON to raw text. JSON lineage paired with raw mode is rejected; this prevents finalization from bypassing the bounded JSON contract. Valid JSON→string script updates explicitly reset the lineage to default and remain supported.
