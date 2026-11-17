# Independent variable definitions and current values

## Evidence and compatibility

Static inspection of Offline 2.0.0 identifies `value`, `current_value`, and
`description`, with separate project-definition and local-history read/write
calls. This implementation provides independent values in Workbench's own format;
it is not native fileDB serialization or original MCP wire-format compatibility.

Current values remain in `globalVariables` and each environment's `variables`.
Optional `globalVariableDefinitions` and environment `variableDefinitions` hold
`initialValue` and `description` per key. Legacy variables without a definition
are not silently rewritten on read: their displayed initial value is derived
from the current value and marked `initialExplicit: false`. Confirming the new
editor makes its displayed initial values explicit. Old JSON editors still edit
only current values and do not discard existing definitions.

## Behavior

- Explicit initial values, current values and descriptions can be changed
  independently. Values preserve JSON types; descriptions are at most 4000 UTF-16
  code units. Existing variable-name and 10,000-variable limits remain in force.
- Runtime environment/global writes change only current values. Clearing a
  current value does not fall back to the initial value or remove its definition.
  Restoring an initial value is an explicit deep copy. Deleting a variable through
  MCP or removing its editor row deletes both parts; MCP still requires its
  explicit deletion intent and write grant.
- MCP upsert accepts `initialValue`, `currentValue`, and `description`. Existing
  `value` remains a current-value alias and cannot be combined with `currentValue`.
  An initial-only update preserves an existing current value. A newly created key
  without a supplied current value starts with the empty string.
- MCP reads retain the existing current-value maps and additionally expose
  definitions and entries. `currentSet` distinguishes an unset value from JSON
  null or the empty string. `initialExplicit` is informational, not permission.
- The UI uses JSON value cells, 50-row pages, and draft-only edits until confirmation.
  Invalid JSON, duplicate names and invalid definitions do not partially update
  the project. Paging preserves unsaved cells. Cancel discards the draft. Existing
  optimistic-concurrency checks are unchanged; an observed project revision
  change also prevents applying a stale editor draft.
- Modern Apipost JSON import preserves initial values and descriptions alongside
  its existing current-value conversion. Conflicting explicit global definitions
  fail atomically. An otherwise identical legacy imported environment can gain
  its definitions without replacing changed configuration.

Both kinds of value still use the existing plaintext local project storage and
may be included in project exports. This is not secret redaction or a reproduction
of the original project's local-history storage separation. Run evidence's
`initialVariables` continues to mean the effective values at execution start,
not the configured initial definitions.

## Verification contract

Model tests cover independent updates, legacy aliases, invalid-update atomicity,
typed values, unset values and copied object isolation. The official MCP SDK HTTP
scenario verifies real requests use current values and subsequent script writes
preserve initial definitions on disk. Import tests retain distinct values and
reject conflicts. Browser acceptance covers invalid input, cancellation,
confirmation, reset controls, paging, persistence and reload; it must actually
pass for a revision before that UI revision is called verified.
