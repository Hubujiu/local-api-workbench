# Native OAuth2 definition roundtrip

Work in progress; requires the separately verified runtime in PR74. Existing
OAuth2 acquisition and refresh PR31 is not reimplemented or auto-enabled.

Native selected auth.oauth2 maps to auth.nativeOAuth2 under type=oauth2. Reuse
the strict runtime data model directly, retaining every known field's value and
optional presence. The 17 string fields and three arbitrary bounded JSON arrays
are described in ADR-NATIVE-OAUTH2-TOKEN-POLICY.md with legal static provenance.
Preserve param_id, array order, nested data and templates. Do not synthesize or
clear access_token, grant_type, state, code_verifier or endpoint settings.

Export requires this explicit native definition model. Legacy Workbench OAuth2
{token,refreshToken,...} cannot faithfully reconstruct native acquisition data;
reject it with a fixed redacted error and offer full backup. Unknown native
metadata, malformed data/controls, accessors, cycles and over-limit definitions
also reject. Only the selected section is mapped; inactive outer auth sections
are not an identity guarantee. Ordinary JSON object prototype differences are
not preserved. Conversion never obtains tokens, resolves templates or performs
network I/O. Valid stored definitions may still fail token readiness at runtime.

This is definition and existing-token interoperability, not native grant-flow
execution, automatic refresh, provider/account compatibility, GUI compatibility
or original arbitrary mock/template evaluation. Missing/empty controls retain
the explicit bounded runtime semantics; unsupported placement rejects rather
than being silently changed to Bearer.

Acceptance must cover native JSON and directory two-generation export/import,
full inert metadata equality, zero conversion traffic, actual header/query and
no-injection requests, frozen/live isolation, backup/reopen, SDK aliases and CLI,
wrong credentials, invalid atomicity and persisted cancellation. Root separately
checks project/folder/own/noauth preserve/flatten graphs and unchanged lossy
OpenAPI/frozen-native-export guards. Require current feature/root CI and actual
three-platform package evidence; earlier runtime/dependency green is not adapter
acceptance. No frontend, new dependency, signing engine, budget change or original
proprietary implementation is included in this adapter.
