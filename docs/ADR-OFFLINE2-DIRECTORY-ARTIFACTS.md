# Original directory built-in catalog preservation

## Runtime finding

Normal Offline2 2.0.0 creates `settings/mock_inner_rules.json` in a newly created
project, even before adding any user Mock rules. The existing experimental
Workbench directory selection rejected that file, so selecting an actual whole
project directory could not reach the already implemented directory assembler.
This was not an absent directory importer: the existing bounded adapter is reused.

The genuine user-authored record snapshot under
`tests/fixtures/original-offline2/directory` was captured from the separate original
project after the verified UI JSON roundtrip and our own pre/post script edits.
The original application's built-in catalog is deliberately not redistributed in
the repository; the test supplies an explicitly synthetic inert catalog row.
A local acceptance also imported the actual nine-file original directory, including
its 8705-byte built-in catalog, and verified preservation after Store save/reload.

## Contract

Only this additional exact path is accepted. Its bounded JSON array is retained
verbatim as `settings.apipostDirectoryArtifacts`, keyed by source project ID.
It is not merged into executable Mock rules, evaluated, or rendered as active
content. Request import notes explicitly disclose retention without activation.
No file is silently dropped. Unknown files, stale indexes, identity conflicts,
traversal, duplicate paths, bad JSON and aggregate-size violations still fail.

The original 4MiB selected-directory limit and 5000-file limit remain. Retained
catalogs additionally share a 4MiB cumulative bound across at most 20 source
projects. Reimport replaces the matching source artifact rather than appending
unbounded duplicates. Store saves and backup restores validate this field too.
Failure preflight happens before destination requests/settings are mutated.

## Evidence and limitations

The real user-record fixture covers native project/API/environment indexes,
initial environment values, own pre/post script provenance and restore persistence.
Synthetic tests cover unknown paths, malformed catalogs, unsafe retained paths,
size limits and unchanged destination on failure. Existing native assembler
HTTP/script/model/sample tests remain enabled. No frontend layout or new UI was
added; the shared file-input whitelist only aligns with the backend contract.

This feature preserves source catalog data; it does not implement that catalog's
semantics. It does not add native file writing, original histories/recycle-bin/
execution-report migration, all resource types or full reverse migration. Source
files remain untouched and should be kept. It depends on the separately reviewed
PR #5 query-fidelity fix, so its PR is stacked on that branch to keep the diff
feature-only until that prerequisite reaches develop.
