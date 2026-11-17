# Standalone Postman environment import: ordinary strings only

## Scope

A collection and its environment are separate exported files. Previously a
collection imported successfully while the environment failed with an unknown
format error. This adapter creates one new local environment and does not alter
existing environments, requests, global variables or current-environment choice.
It does not execute anything or resolve remote data.

Public references:
- https://learning.postman.com/docs/getting-started/importing-and-exporting/exporting-data
- https://github.com/postmanlabs/newman/blob/develop/test/integration/globals-env-data-files/globals-env-data-files.postman_environment.json
- https://github.com/postmanlabs/newman/blob/develop/test/integration/slashed-variable-names/slashed-variable-names.postman_environment.json

The public fixture establishes the ordinary `name`/`values`/`key`/`value`/
`enabled`/`text` structure; this first slice deliberately requires an explicit
`_postman_variable_scope: "environment"` marker and does not claim to recognize
all older unmarked exports. The slashed-variable fixture also confirms the
explicit scope marker and enabled text rows; its legacy `timestamp` field is
not included in this strict first slice and is rejected, not silently discarded.
Tests use synthetic inputs, not proprietary clients
or private exports.

## Strict contract

- Required: scope marker, nonblank name (at most 200 characters), values array.
- Each row has key, string value and `enabled: true`. Optional type is `default`
  or `text`. Other row fields reject, including secret/source/description fields
  whose semantics are not represented here. Empty values are valid strings.
- Duplicate names, disabled or missing-enabled rows, secret types, Vault
  references, nonstring values, reserved prototype keys, malformed Unicode,
  accessors/proxies and unknown envelope fields reject the whole document.
- Optional string id and export timestamp/client metadata are inert provenance,
  not authority. Source id is never reused as local identity; metadata is not
  copied into local runtime settings. Existing names may recur with fresh IDs.
- Ordinary-data validation uses existing bounded import hashing, lowered to
  4 MiB; at most 10,000 rows, 200-character keys and 65,536-character values.
  The existing total-node limit can reject a document before the row ceiling.
- Text JSON rejects duplicate members throughout the original environment
  document, including Unicode-escaped names and overwritten subtrees. YAML
  is not accepted for environment documents; unrelated JSON formats retain
  their prior compatibility behavior.
- No initial/current-value inference, disabled-variable conversion, secret
  masking, encryption, Vault access, global-variable import or source sync.
  Ordinary strings are local plaintext project data and remain part of backups.

## Entry points and atomicity

External owner and MCP imports require `document` to be original JSON text.
Already parsed environment objects are refused because upstream JSON parsing
can erase duplicate members; YAML environments are also refused. Internal
trusted object conversion remains available but is not an external bypass.
Other formats retain their existing object/text/YAML entry points.

Owner `/import` validates the complete envelope and all rows before appending
one environment, then uses the existing Store save. Direct API-only conversion
and MCP sync remain unsupported. Import mode options are rejected for this
standalone format rather than reinterpreted.

Owner and authorized MCP manual preview/apply use `format: auto`. The existing
source graph produces an environment node, whose existing planner creates a new
identity and refuses target bindings. Preview uses existing value-free item
projection and keyed commitments, not variables or plaintext content digests.
Apply remains bound to source/options/config revision/session and live write
permission. Clear-scope, API-clear, folder mapping and explicit resource binding
are refused for this environment-only operation. No new tool or grant is added.

Plans freeze request definitions and retain the selected environment ID, not
its variable values. Later environment edits remain visible when running the
plan, including after backup/restore and restart. This feature does not change
that existing behavior or introduce environment-value snapshots. No network
side effects occur until a separately authorized execution.

## Verification

Unit tests cover strict rows/envelopes, unsupported options, exact strings,
fresh IDs, unchanged selection and descriptor-safe rejection. Synthetic owner
and MCP workflows cover preview/apply, two environments, actual loopback request
resolution, repeated import, old/default selection, frozen plan execution after
live edits, backup restoration/restart and invalid-input zero-write/zero-network
checks. No GUI or full Postman compatibility claim is made.
