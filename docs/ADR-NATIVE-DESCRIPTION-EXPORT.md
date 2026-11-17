# Bounded native parameter-description catalogue export

This independently written adapter completes the existing description-only
library's definition interchange. It does not add automatic parameter matching,
adoption, a typed dictionary, scripts or native automated tests.

## Evidence and identity

Legal static inspection of the previously acquired Offline2 2.0.0 renderer
establishes project `settings/desc_list.json` read/write, export as
`global.describe_library`, and native import as fresh record IDs and the
receiving project ID plus `key`/`description`. The existing three original JSON
fixtures have empty catalogues. Nonempty regression inputs are independently
authored synthetic data, not original-app exports. Original GUI nonempty
catalogue roundtrip has not been executed or verified.

The cached renderer SHA-256 is
`20bb6e21fd678ead16bd91807dc9623b8cd3e7019d44ac874a167c31a37f39fb`.
Reproducible zero-based Unicode-character offsets: module 38091 generic settings
read/write 2628945/2629298 and list wrappers 2640625/2640934; module 161822
catalogue read/save 3389339/3389707; module 258928 export read/output
2717173/2717555; module 526737 fresh-identity import 3499445. These are source
facts, not copied implementation or a runtime-equivalence claim.

## Supported contract

- Validate the complete stored `settings.parameterDescriptions` with the existing
  validator before projecting anything. Preserve current key/description strings
  and array order, including case distinctions, Unicode, lone surrogates and
  empty descriptions. An omitted source description has already become empty
  text through the existing importer. Do not reconstruct edited text from origin.
- Emit only `id`, `project_id`, `key`, `description`. IDs derive deterministically
  from a JSON tuple of destination project ID and key before hashing. This keeps
  distinct lone surrogates distinct. Historical `apipostSource` remains unchanged
  in the original project and full backup; it is not exported as an unknown
  extension or treated as the destination identity.
- Reuse the existing directory settings map: the catalogue occupies exactly
  `settings/desc_list.json`. Keys never become file paths. Both exporters perform
  forward-import semantic verification; the directory exporter also verifies
  its fully assembled public input.
- Keep existing 2000-entry, 200-character key, 8000-character description and
  aggregate 1 MiB library limits. Both original and reimported canonical libraries
  must fit, so destination provenance overhead can make an otherwise near-limit
  input unrepresentable. Overall native 4 MiB and 5000-file limits remain.
- Unknown fields (including origin fields), invalid values, sparse arrays,
  accessors, duplicate keys and invalid origin shapes reject. The importer still
  rejects conflicting descriptions, duplicate incoming source IDs and foreign
  project IDs atomically. Identical definitions keep the target's existing
  provenance. No unknown field is silently dropped to make validation succeed.
- Do not synthesize `is_describe_library` or enable automatic adoption. Existing
  unsupported settings, catalogues, permissions, formats and dependencies remain
  rejected. This slice does not implement status-code or shared-function export.

## Verification boundary

The new owner contracts specify synthetic input → actual import/save → reopen →
both native formats with two export/import generations → full backup/restore →
owner reopen and fresh-process Store readback. They check semantic order,
remapped unique IDs, unchanged source and unrelated projects, no upstream request,
missing-owner-token rejection, and whole-project disk/grant immutability after
invalid imports. Pure tests cover full validation, zero getter invocation,
UTF-8 aggregate boundaries and forward-readback negative controls.

At the initial implementation checkpoint only the independent pure module and
syntax/format checks ran locally. The locked `node-oauth1@1.3.0` package is absent,
so the real app cannot load locally; no stub, replacement dependency or original
runtime was used. The first saved owner contract is expected to fail against the
old exporter, but is not a locally observed HTTP RED. Normal exact-head CI must
establish the real workflows. Feature results do not certify a later root merge.


The follow-up local batch runs the two public pure exporters and importer against
exactly the same shared fixture as the owner contracts, twice per format. It also
checks whole-project immutability on unsupported fields and zero accessor calls
at both public export entrypoints. These pure conversion checks passed alongside
the helper tests; they do not execute HTTP, Store, server restart or the fresh
process readback contract. Those app workflows still require exact-head CI.
