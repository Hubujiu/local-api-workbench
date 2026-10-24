# Selected interface-case organization

Static source inspection of offline 2.0.0 work chunks `3964.46227745a095.js` (module 263964) and `5509.478a5be6cfa8.js` (module 65509) identifies sample checkboxes, select-all, move and delete actions. This establishes a missing organizational workflow, not original GUI execution or pixel-parity evidence.

Selection is ephemeral and scoped to the current project and source API. Select-all applies only to that API's cases; individual selection supports a mixed-state checkbox and a visible count. Bulk movement accepts an existing group of the same API or the root. It changes only folder membership, never the request, function snapshot or source link. Empty groups remain present.

Deletion requires confirmation and removes only the explicitly selected cases. Groups, other APIs and historical execution evidence are retained. Pure actions validate every selected ID and the resulting folder graph before applying any change. Missing, duplicate or cross-API selections cannot partially modify the project. Saved-project revision checks remain in force; no new execution, network or filesystem permission is introduced. Batch running and source-group checkbox expansion are not included in this increment.

Fixed coverage includes invalid-action atomicity, request identity/snapshot preservation, unrelated API and history preservation, plus browser select-all, bulk move, reload, mixed selection, cancelled deletion and confirmed deletion. The feature remains on the existing project/PR workflow and does not alter migration formats.
