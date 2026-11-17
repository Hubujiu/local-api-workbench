# Modern interchange model folders

Independent mapping based on pinned public EchoAPI source, not an original Offline2 native-directory export:
- https://github.com/EchoAPI-Team/echoapi-for-vscode/blob/bc8ecb58271ac7a8b0289fad2f0455745b4562f1/src/types/schemas/index.ts : model and folder node types.
- https://github.com/EchoAPI-Team/echoapi-for-vscode/blob/bc8ecb58271ac7a8b0289fad2f0455745b4562f1/src/components/business/JsonSchema/JsonSchemaTable/utils/list2tree.ts : model_id/parent_id hierarchy.
- https://github.com/EchoAPI-Team/echoapi-for-vscode/blob/bc8ecb58271ac7a8b0289fad2f0455745b4562f1/src/utils/exportutils/apiToSelf.ts : model export metadata and default folder schema.

The modern adapter now preserves folder IDs in a separate namespace, parent links, names, descriptions, numeric sort values and empty groups. Models retain their own schema component IDs and gain folderId only when nested. A folder can never become a schema reference target. Duplicate/reserved IDs, missing or non-folder parents, cycles and depth beyond twenty fail before modifying the project. Total source model/folder count remains at most 100. Nonempty folder schemas are rejected rather than discarded.

Local modelFolders metadata persists with the project and backup. Save/restore validate at most 1000 folders, bounded names/descriptions, parent existence and cycles, and every model's folder reference. The model library displays nested collapsible groups, including empty folders, while keeping the original model edit/apply indexes. Names and descriptions are escaped; no source code or URL is executed. Folder-only imports are preserved rather than silently removed.

This increment supports imported hierarchy and its display/persistence. It does not yet add full model-folder CRUD or prove original native-directory migration. The legacy flat-model display and editing remain usable; full proprietary schema composition stays explicitly unsupported.

Validation: failing import regression before implementation, malformed graph and unsupported data rejection, actual project save/reload and backup, merge failure atomicity, and browser import/collapse/expand/reload evidence. Exact-commit CI is the verification record.

## Explicit local folder management

The follow-on editor adds create, rename, reparent and empty-folder removal. Models can be moved using the model editor's full-path selector. Changes are validated before replacing the directory list; moving a parent leaves descendants/model IDs unchanged, while cycles/missing parents/invalid names reject atomically. Only empty folders may be removed, with explicit UI confirmation; no recursive data deletion is implemented. Cancelled dialogs/confirmations do not mutate the project. Existing description/sort metadata is preserved unless the user edits the description.

Browser coverage creates a nested directory after a validation error, cancels an edit, moves an existing imported model, confirms nonempty deletion is disabled, renames/reparents its directory, cancels then confirms deletion of a different empty folder, saves and reloads. This closes basic local folder CRUD, not native Offline2 format equivalence or every original visual detail.
