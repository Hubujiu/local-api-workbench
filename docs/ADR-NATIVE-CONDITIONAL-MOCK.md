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
  JSON object/array schema roots or explicit raw fallback are supported. Unknown
  policies, scalar roots, root references without explicit type, active IP lists,
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
comparison; bounded regex failure/recovery and concurrency. Original same-input
whole-directory comparison and exact-head CI must still be checked after this
feature is saved and integrated with the other feature PRs. Native global routing,
alternate response policies, scalar/XML generation and the full vendor Schema/Faker
surface remain outside this bounded slice. This is not full project delivery.
