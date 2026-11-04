# Postman raw media: root integration checkpoint

This is an independent WIP integration of the bounded PR96 feature, not a new claim of full Postman compatibility. The pinned upstream source observations and explicitly excluded cases remain in ADR-POSTMAN-RAW-MEDIA.md and POSTMAN-RAW-BODY-STATE-MATRIX.md. No proprietary application, bytecode, or original VM was run.

## Exact inputs and conflict resolution

- Root base: `8f42653300e25cad795c51dcb4d7f755e5148f34`, tree `d42d96193a697f16d26f8756032a4aaf10ddb4d7`.
- Feature: local `9e8db0ae37942c8182e9c74bf69ac05461dae462`, tree `b0547c13aa74d650e68847dbe948a6ed550d52f9`, matching PR96 remote `d036a8d7afd92d4961a47625e78c21219b45fbec`.
- Feature diff base: PR51 `0118e16c1f0b2f949d7801d9590a8f878581d480`.
- The final feature change from tree `b4f7b44689d79b28b40220282d7c5a6c0bb111de` is documentation only. Feature CI evidence is not root acceptance.
- Local root history is a shallow snapshot with no common ancestor. Applied the exact feature diff with three-way blob resolution, rather than an unrelated-history merge. The resulting checkpoint has the root base as its single parent.

Nine conflicting regions across core, runtime, and server were resolved additively. The root request deadline wrapper, cancellation checks, authentication replay budget, path/query/body checks, OAuth policies, noauth opt-out, Postman collection identity, event inheritance, and OpenAPI header/body validation remain in place. No database driver, session controller, grant, MCP, IF/repeat, failure-policy, commit journal, dependency, or CI workflow implementation was changed.

## Root-only boundaries

1. Marked static cURL/OpenAPI conversion rejects active `nativeTasks.before` (enabled 1), in addition to effective regular/shared before scripts. Native tasks execute through a separate ordered phase and cannot be inferred by the static exporter. Empty and disabled-only tasks remain admissible to this marker-specific check; ordinary unmarked behavior is unchanged.
2. The owner cURL preflight checks effective shared parameters before dynamic providers execute. Template media/header identities cannot silently become a different type during conversion.
3. Native Apipost API/directory conversion explicitly refuses a Postman raw marker, even if an explicit Content-Type is present. Directory frozen HTTP definitions are checked independently of the live API. Project backup/restore remains the lossless option. No new native wire representation is invented.
4. Runtime media validation occurs after the root cancellation/deadline check and before authentication/cookie awaits. Final raw media insertion occurs after body construction or replay and before signing. Existing replay and cancellation semantics are preserved, not replaced with the older feature runtime.

## Verification and pending acceptance

- The pure active-native-before assertion was observed failing on the initial integration (`Missing expected exception`) before the narrow guard, then passing after it.
- The combined pure helper file executed 26 assertions successfully. Its additional OpenAPI roundtrip test could not load the root-only `content-type` dependency. A filtered local run records that test as excluded for this missing dependency; it remains enabled in the repository and normal CI.
- Syntax and existing Prettier checks are local authoring checks only. No dependency was installed or changed.
- Local owner/app/VM executions: **0**. Full root imports also require unavailable dependencies, including `node-oauth1`.
- Added owner contracts in `postman-raw-media-native-exports.test.mjs` for explicit marker refusal, an unmarked positive control, frozen-only directory state, unchanged project bytes, backup/restore, fresh Store reads, and zero loopback traffic. These are authored, not locally executed.
- The separate root transition test file covers the three feature evidence gaps and native-task/shared-script export intersections. Its exact assertions and CI execution must be checked on the final root tree before acceptance.
- Root base CI itself was not wholly green: its previous Windows shard 6 collection cURL child timed out. That old result is neither a PR96 feature failure nor a substitute for exact new-head CI.

Required normal CI acceptance includes all three operating systems, actual checkout of the final root tree, the new owner/wire contracts, and retained OAuth, native-write, MCP grant/revocation, IF/repeat, persistence, CLI, and database contracts. Static inspection or feature green checks do not establish those results.
