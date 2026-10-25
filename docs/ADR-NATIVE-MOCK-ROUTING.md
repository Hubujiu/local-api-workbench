# Native Mock method/path routing

Backend-only addition to the conditional Mock feature. No source application
implementation is reused and no new dependency is added.

## Contract

- Imported HTTP APIs retain bounded `nativeMockRoute` source identity/path
  provenance. Actual matching follows the current saved request URL and method,
  not a stale imported URL; restoring changes the Workbench project namespace.
- `/mock/<workbench-project-id>/<path>` supports native paths when no exact
  existing request-ID route applies. Legacy ID routes keep priority and retain
  their ordinary query semantics. `/app/mock/project/<workbench-project-id>/<path>`
  is an unambiguous path-only alias matching the original's alternate layout.
- Literal segments are case-sensitive. Entire `{name}` segments match one
  segment, including the original double-brace spelling. Percent decoding is
  performed once; redundant/trailing slashes are ignored. No caller regex is
  compiled and no filesystem path is resolved. Bounds are 8KiB/100 segments,
  1000 characters per segment, and at most5000 candidate interfaces.
- Nonempty `apipost_id`, `echoapi_id` or `target_id` selects the imported source
  target inside the selected Workbench project, independently of method/path as
  observed in the original. Conflicting selectors reject. Ambiguous matches
  return409 instead of choosing whichever resource happened to be first.
- Unknown paths, wrong methods and absent selectors return404 instead of the
  original's generic200 fallback; malformed encoding/control/dot/backslash/query
  delimiter paths reject. A deleted interface cannot match. Global503 and native
  per-interface404 disabling continue to work. Source-ID collisions need legacy
  Workbench ID addressing or separate projects, never cross-project lookup.
- Routing reuses the existing bounded response pipeline, body cap, native
  conditions, schema/fixed200 rules, delay, CSP/no-cache/nosniff and Host/Origin
  checks. It does not execute request scripts or grant database/network access.

## Evidence

REA static analysis of the official Mock backend and original loopback probes
confirm method/case matching, slash normalization, percent-encoded spelling and
explicit selector behavior. Ten original probes distinguish real rule matches
using the saved marker header from the original generic200 unknown-route body.
Committed fixtures are independently authored. Synthetic complete HTTP flows
cover selectors, collision409, method/path rejection, disabled/deleted resources,
source/restored project isolation, URL edits, save/reload/restart, oldID-route
compatibility and retained response isolation headers. Original parameterized
path runtime comparison and exact-commit CI are still pending at this checkpoint.

This is not arbitrary route regex, automatic path-variable extraction into Mock
expressions, relaxed CORS or a claim of complete original routing/configuration.
