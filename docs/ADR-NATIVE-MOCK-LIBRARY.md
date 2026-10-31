# Reuse the licensed original Mock core behind a bounded VM adapter

Use the public MIT-licensed `apipost-mock@1.0.2` implementation rather than reimplementing the Chinese/English name, geographic, network-string and color catalogs. Its package has no runtime dependencies. Preserve its license with the generated bundle and pin the package and lockfile. The builder emits a SHA-256 manifest, checked before evaluation. This is reuse of the published open-source package, not redistribution of extracted proprietary application code.

The separate library VM has a fresh runtime and context per schema generation, 16 MiB memory, a 512 KiB stack, a 1 s library bootstrap ceiling, at most 1000 calls and 250 ms cumulative evaluation time. The only host bridge supplies one validated numeric random value from the existing seeded sampler. No file, network, process, module-loading or timer bridge is exposed. JSON arguments and results cross the boundary, with 1 KiB expressions, bounded primitive arguments and 64 KiB individual output. Cleanup occurs on both success and failure; unknown names, recursive placeholder arguments, unsupported overloads and wrong output types fail rather than falling back silently. Standalone low-level field sampling creates and disposes a scope per library call; project sampling shares one scope for the current schema only. No user VM state persists across project requests.

The admitted source-rule families are cfirst/clast/cname, first/last/name, region/province/city/county/zip, protocol/tld/ip/url/domain/email and color/hex/rgb/rgba/hsl. Default calls are supported, with boolean name/location flags and bounded domain/protocol/color strings where applicable. These base names are not among the observed original wrapper overrides. Existing imported string/character/UUID/date/numeric overrides and Local API's own generators retain their previous dispatch and behavior. Matching, schema precedence, source identity and final value validation remain unchanged. This does not expose the entire Mock template language or declare full Faker compatibility.

Do not install the complete legacy wrapper stack into production as a shortcut. The inspected exp-mock/mockjs5-pro dependency graph pulls old Faker and UUID versions with security advisories (GHSA-qxc2-j82w-r537 and GHSA-w5hq-g745-h8pq). A separate full-wrapper prototype also exceeded the existing bootstrap budget; its failed probe is not a production success. This change uses only the dependency-free core and does not increase existing script permissions or runtime budgets. Other wrapper integration requires its own reviewed dependency migration and behavioral evidence.

Verification covers seeded replay, all admitted families, invalid/oversized arguments, call quotas and disposal, unchanged Local API semantics, imported-directory source preservation, atomic refusal, actual HTTP Mock and sample endpoints, followed by a persisted two-step execution plan that extracts generated values, runs pre/post scripts, sends a second real HTTP request and persists success/failure evidence. No frontend change is required for this backend milestone. Generated values are fixture data, not verified real identities, routable destinations or cryptographically secure identifiers. Full original-application GUI and real-project roundtrip acceptance remain separate.

Cross-platform checkout must preserve the generated bundle's exact bytes. These assets are marked `-text` in `.gitattributes`; a real Git filter regression with `core.autocrlf=true` verifies the checked-out SHA-256 against the manifest. The runtime integrity check remains exact and still rejects changed bytes. This addresses the observed Windows checkout mismatch instead of weakening verification or rerunning a known-bad artifact.

## Monotonic and terminal activity enforcement (2026-10-31)

Static review identified two independent budget defects in the adapter. Interrupt
deadlines used the adjustable civil clock while evaluation debits already used
monotonic elapsed time. Also, a successful evaluation returned before the final
charge was checked; a last call could finish host string/JSON conversion after
250 ms and still publish a value. These are source-backed defects, not an
explanation of the separate XML/script CI timeout.

Bootstrap interrupts and evaluation deadlines/debits now use one captured host
`performance.now()` clock. Evaluation disposes its output handle before charging
the complete operation, debits even when cleanup throws, then rejects a negative
remaining budget before returning a successful value. Exactly zero remaining is
not treated as an overrun, but still refuses the next evaluation. Existing errors
continue through the cleanup path. The shared runtime remains available across
successful calls and is still disposed by its owner; guest timestamps and seeded
random values are unchanged.

The existing 1 s bootstrap, 250 ms cumulative activity, 1000 calls, 16 MiB heap,
512 KiB stack, 64 KiB output and argument limits remain unchanged. No clock or
budget injection is exposed in production, no quota is replenished and no host
operation is claimed to be preemptible. The completion guard rejects late values
rather than claiming it can interrupt host JSON parsing.

New CI runtime regressions synchronously wrap and restore host `JSON.parse` to
wait only on quoted-string output parsing, after VM execution has returned. A
single bounded 300 ms tail must be rejected; two 160 ms tails must share the same
250 ms allowance. Exact output-tail counts prevent an unrelated early timeout
from passing these tests. The first cumulative call must succeed, so a heavily
paused runner may legitimately fail that assertion rather than being accepted
as evidence of cumulative enforcement. No retries or increased budgets are used.
Existing real Mock, quota, seeded replay and owner workflow tests remain intact.

Local verification is limited to syntax, formatting and a source-only wiring
regression which never imports the runtime. The new VM regressions are authored
for ordinary exact-commit CI, not executed locally. Their runtime result remains
pending; static checks alone do not prove interruption or complete acceptance.
