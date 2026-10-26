# Native conditional Mock (bounded implementation)

This independent feature starts from develop. It adds backend migration/execution
and a shared directory-path validator, not new frontend controls or visual work.
No original implementation, builtin rule catalog or raw project archive is copied.

## Evidence

Official Offline2 2.0.0 UI saved a separate settings/mock_<target-id>.json file.
REA statically analyzed two renderer modules and the official mock.asar server and
utility modules as inert text. The analysis is partial, not a complete call graph.
The original backend uses the existing lodash / JSON-schema-faker family; this
implementation reuses Workbench's bounded schema generator and QuickJS isolation
rather than importing proprietary code or adding a dependency.

Real original loopback requests established: fixed HTTP 200 is the default even
when the selected expectation declares 404; a distinguishing response header
verified query equality, missing/mismatched values, case sensitivity, and the last
value winning for repeated query keys. Equal status/body alone did not establish
branch selection and was not treated as acceptance. Blank UI condition rows are
placeholders, not false predicates. The source header carries lowercase string
metadata, not-null=1 and a simple string schema.

## Contract

- Accept target-owned native Mock files only for indexed APIs. Reject missing,
  foreign, duplicate or conflicting identities and unknown fields. Retain ordinary
  unknown-file refusal and aggregate directory limits. Reserved builtin/global
  catalog paths are not mistaken for per-API files.
- Snapshot ordered enabled/disabled AND rules and the explicit fallback response.
  References/custom responses must resolve. Preserve the original declared status
  as metadata while executing the observed fixed-200, JSON-schema-first policy.
  JSON object/array schema roots or explicit raw fallback are supported. The
  response-media extension below adds explicit scalar/text and raw XML policies.
  Unknown policies, root references without explicit type, active IP lists,
  response scripts and unsupported header metadata reject rather than vanish.
- Native comparisons have an explicit dialect: coercing equality/numeric ordering,
  collection/string inclusion, empty/existence checks and comma-separated membership.
  Ordinary Workbench strict Mock comparisons do not change. Own-property paths
  reject prototype access. Regex literals run only in a fresh bounded QuickJS VM,
  not in the server event loop; no network/Node capability is provided.
- At most 100 rules / 50 conditions each, 1 MiB native definition, 256 KiB matching
  input, 1 MiB aggregate comparison work, 16 regex conditions and 128 KiB regex
  input. At most four concurrent regex requests; existing 250ms active / 2s wall
  budgets remain. Response/header/delay and isolation-header limits remain intact.
- Native rules cannot silently mix with ordinary editable Mock rules. Project Mock
  disable still takes precedence. Per-API native disable returns 404. URLs remain
  Workbench's interface-ID routes, not original path-based routing. No import starts
  outbound network activity, runs source scripts, opens ports or grants authority.

## Acceptance and remaining boundaries

Synthetic full-flow tests cover directory import -> actual HTTP -> source immutability
-> save/reload/backup -> concurrent project isolation -> restart; response headers,
schema priority and fixed200; malformed references/paths/policies; every supported
comparison; bounded regex failure/recovery and concurrency. The integrated current 23-file original directory passed same-input original
comparison across six cases and 18 real HTTP requests, including concurrent
original/restored projects and restart. Original bytes stayed unchanged; Mock
serving did not acquire a database grant or execute request scripts. Exact-head
CI remains commit-specific. Native global routing,
alternate status policies, Schema-to-XML generation and the full vendor Schema/Faker
surface remain outside this bounded slice. This is not full project delivery.

Native matching treats a query parameter named `example` as ordinary input,
including last-value handling for duplicates. The legacy Workbench example-index
selector and its duplicate-input guard remain unchanged for ordinary Mock rules.
Uncoercible JSON values fail a condition rather than invoking code or poisoning
subsequent requests.

## Explicit response media and scalar roots

Native responses may now persist `serialization: "scalar-text"` with one explicit
`string`, `number`, `integer`, `boolean` or `null` schema root, or
`serialization: "raw-xml"` with a literal body and no schema. The field is optional:
old object/array JSON and raw-text definitions are not rewritten or given a new
default field. No dependency or frontend control is added.

Scalar generation reuses the bounded project sampler exactly once. Strings stay
unquoted, finite numeric/boolean values use their text form, and null becomes an
empty body; the default MIME is `text/plain`. Literal selection follows the
existing const/example/default/enum priority and is type-checked during import;
all generated scalar values are checked again before sending. A mismatched object,
array, non-finite number or malformed string fails instead of stringifying or
silently choosing fallback. This is not a general JSON Schema validator.

Raw XML accepts absent/empty schema only, preserves exact Unicode/escaping and
template-looking text, and defaults to `application/xml;charset=utf-8`. It is not
parsed, interpolated, expanded or converted from JSON. It may therefore contain
ill-formed XML: this feature serves explicit response bytes, not XML validation.
Schema-to-XML, ambiguous union/ref-only roots, source scripts and unsupported
media types remain rejected. JSON object/array serialization is unchanged.

Default Content-Type is added only when no case-insensitive explicit header exists.
Explicit headers remain authoritative, including on scalar responses. Case-folded
duplicates, isolation headers and transport-control headers still reject. Existing
definition, generated-body, delay, matching and sandbox limits are unchanged;
serving Mock does not execute API scripts, database tasks or outbound requests.

The original Offline2 server was inspected as inert text: its schema path includes
scalar text responses and its raw fallback can send XML. These are static interface
observations, not scalar/XML original-runtime or wire-equivalence evidence. In
particular this implementation preserves explicit Content-Type, does not regenerate
after failed JSON parsing, and does not reproduce ambiguous XML wrapper behavior.
Fixtures are independently authored, not original exports or proprietary code.

Local acceptance is recorded with the coherent commit: real HTTP checks generated
false/zero/empty/null, escaped strings, empty/nested arrays, exact raw XML, rule and
fallback selection, explicit mixed-case Content-Type, source immutability,
save/restore/restart and concurrent-project isolation. Invalid imports are atomic;
derived wrong-type generation returns an error, leaves other projects working and
recovers after correction. A loopback sink confirms API execution is not invoked.
Focused checks do not replace exact-head CI or establish full backend delivery.

Local verification on 2026-10-26: the following targeted command passed 95 tests;
`npm run check`, Prettier checks for the four changed JavaScript files and
`git diff --check` also passed. No original process or GUI was run.

```sh
node --test --test-concurrency=2 tests/{native-mock-media,native-mock,native-mock-route,mock-examples,mock-isolation,mock-response-schema,mock-fields,apipost-modern,apipost-directory,apipost-mock-rules,schema-sample}.test.mjs
```
