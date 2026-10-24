# Description-only parameter library

The modern export's `global.describe_library` contains key/description entries,
with optional id/project_id metadata. The original parameter-description selector
uses a distinct description list and an enable setting. The export does not
establish that this setting should be enabled in the destination project.

The workbench therefore imports these entries into a separate bounded
`settings.parameterDescriptions` library, rather than guessing types or examples
in the existing typed parameter dictionary. A settings page supports create,
edit, delete and advanced JSON editing. The parameter-definition dialog offers
explicit selection; adopting a library entry fills only the description input.
Canceling the dialog leaves the request unchanged. Saving the dialog uses the
existing definition-edit workflow. Names, values, types and required flags are
not taken from the description library. There is no automatic matching, live
back-propagation, script execution or network access.

Keys are exact and case-sensitive. Duplicate source keys and conflicting existing
descriptions fail the whole modern import before mutation; identical entries keep
the local entry and its provenance. Optional source IDs are inert metadata.
Unknown fields, accessors and sparse arrays are rejected. The library is limited
to 2000 entries, 200 characters per key, 8000 per description and 1 MiB of serialized
entry data. An absent source description becomes empty text; null or other
non-string descriptions are rejected instead of coerced.

All display paths escape text. Descriptions and provenance survive project save,
restart, native export and restoration as a new local copy. Browser regression
covers import, explicit adoption, cancellation, unchanged parameter data, settings
create/edit/delete and the existing restored-project metadata check. This does
not claim every original description suggestion or automatic-fill behavior.

Static source: official offline 2.0.0 Linux package SHA-256
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`;
work UI index `index-0d1d8198fa5a.js`, SHA-256
`20bb6e21fd678ead16bd91807dc9623b8cd3e7019d44ac874a167c31a37f39fb`.
The modern export mapper and description-list selectors were read statically.
