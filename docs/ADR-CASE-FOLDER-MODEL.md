# Interface case folders

Cases have independent request snapshots. A case folder is an organizational resource owned by one source request, not an execution scope.

The optional project `caseFolders` array contains stable `id`, `name`, `sourceRequestId`, optional `parentId` and optional finite `sort` fields. A case's optional `folderId` associates it with a folder belonging to the same source request. Missing or empty folder IDs retain the existing flat-root behavior. Empty folders are preserved. Limits are 1000 folders, 1000 cases and 20 folder levels. Cycles, missing ancestors, cross-request parents and cross-request case membership are rejected before saving. Deleted source requests remain valid references while retained in the project recycle bin.

The interface-case panel supports creating, renaming and moving folders, selecting a folder when editing a case, and deleting only empty folders. Moving a case or folder does not recalculate scripts, parameters, authentication or service bindings. Request snapshots and selected-environment resolution keep their existing semantics. Folder names, paths and action attributes are escaped in rendered HTML. The existing model-folder layout is reused.

Project save and native backup restoration validate the same graph. Case edits retain their membership, and invalid save/restore attempts must leave persisted state unchanged. This model is the prerequisite for preserving imported sample groups; it does not by itself enable modern Apipost sample-group import or claim the source application's live inheritance behavior.

Verification covers empty nested groups, stable ownership, graph failures, atomic edits/deletions, HTTP persistence and restart, backup restore, and a browser flow moving an existing imported root sample into a nested group without altering its request snapshot. Existing root sample import remains unchanged and continues to reject sample groups until a separately verified converter is available.
