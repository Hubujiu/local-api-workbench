# Model editing preserves identity and references

Code review while adding folder support found that the model editor replaced an existing dictionary entry with only name/schema. That discarded imported IDs, sort metadata and folder placement. After a project reload, editing the dictionary's schema also left the separately serialized OpenAPI component unchanged.

The editor now preserves existing metadata and ID, assigns an ID to new/legacy ID-less entries, and lets the user select a model folder by its full path. An explicitly linked component with the same existing model ID is updated atomically with the dictionary entry. Unrelated components remain untouched. The model editor warns that subsequent data generation through that reference uses the new schema. This is not a claim that already copied request/plan data is retroactively rewritten.

Empty/overlong names, non-object/non-boolean schemas, schemas beyond 1MiB UTF-8, invalid/duplicate IDs and missing folders reject before changing either dictionary or components. Parsing and validation errors keep the dialog open. This does not implement a complete JSON Schema validator or solver.

Tests cover independent serialized component/dictionary copies, preserved ID/folder/sort, actual sample generation through the edited reference, unrelated component preservation and failure atomicity. Browser coverage edits an imported nested model after reload, rejects an empty name, then saves and verifies retained folder/ID and the updated component before a second reload.
