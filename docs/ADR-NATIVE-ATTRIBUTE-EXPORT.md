# Bounded native custom-attribute export

This independently authored adapter uses observed native field shapes; no original application, bytecode or proprietary implementation is executed or copied. Nonempty original GUI roundtrip has not been verified.

## Supported boundary

Seven project definition types (text, finite number, select, multiselect, canonical date-only, HTTP(S) URL and email) and explicit values on current ordinary HTTP APIs roundtrip through native JSON and directory settings/custom_attrs.json. Definitions include disabled and unused fields. Options retain distinct keys, display labels and order; null, empty string, empty selection and absent value are distinct. Native attribute_info references the same exported definition IDs.

The destination-native identity is deterministically derived from a JSON tuple of destination project ID and local field key, with collision checking. This is Workbench's canonical identity policy, not a claim that the original regenerates attribute IDs. It keeps distinct imported sources separate and preserves lone-surrogate distinctions. Complete forward import verifies identities and values after JSON serialization. Current field order, enabled semantics and help text are preserved; historical numeric sort values and native disabled 0 versus -1 are not promised. Existing provenance is validated and left unchanged in the source and full backup, rather than replayed as destination identity.

## Explicit refusals

Boolean, required/default/unknown fields, nonempty custom OpenAPI mapping, invalid provenance, dangling value keys (including null/empty), accessors/proxies/non-JSON values, negative zero and unsupported date-time forms fail closed. Sample, plan, document and protocol values remain unsupported; the shared HTTP mapper must not silently drop them. Definitions and references are preflighted before normalization or cloning. No automatic defaults or inheritance are inferred.

Existing limits remain: 100 fields, 200 options, definition/value string bounds and total native 4 MiB (directory also 5000 files). No unrelated 1 MiB catalogue limit is introduced. Import/export does not execute requests, mutate history or grants, or write partial files. Full backups remain the path for unsupported metadata and historical state.

## Verification state

The initial two pure format contracts actually failed at the prior attributes rejection. Their implementation now passes both two-generation serialized roundtrips. Real owner HTTP save/edit, two formats/two generations, backup, server reopen, fresh-process Store readback, authorization and project-isolation contracts are included. Local owner execution is blocked before the test body by the absent locked node-oauth1 dependency; they require the exact PR CI and are not claimed locally passed. The final three whole-file focused batch passes 14 cases: twelve new pure contracts plus two existing attribute-model cases. Bounds, unsupported samples and valid-empty versus rejected-populated directory snapshots, exact identity readback mutations, accessors/proxies, inherited getter rejection and non-string identity rejection are covered. Independent review reproduced and then verified correction of the inherited-getter and destination-toJSON issues; no remaining limited-review blocker was found. Check, whole-repository formatting and diff checks pass. Three owner contracts remain pending exact CI; these focused results are not whole-suite or GUI acceptance. No original GUI acceptance is claimed.
