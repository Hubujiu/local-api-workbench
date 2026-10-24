# Modern Apipost error-code dictionary import

The original offline 2.0.0 settings editor stores `code_number` and `code_msg`,
with optional record/project identifiers. Its modern export places these rows in
`global.codes`. The importer previously rejected every nonempty dictionary.

Import now maps the code and description into the existing project error-code
dictionary. String codes retain their spelling, including leading zeros; numeric
codes must meet the existing safe-integer rule. Original identifiers, when
present on new entries, are retained as inert `apipostSource` metadata. These
identifiers do not grant access or determine dictionary identity.

Dictionary identity is the canonical string form of the code. Duplicate codes
within the source are rejected. An existing code with a different description
causes the whole import to fail before changing the project. An identical local
definition is retained unchanged, including its existing options and provenance.
This means merging an identical definition does not replace its origin with the
new import's origin. New entries never automatically enable HTTP-status hints:
a business error numbered 409 is not assumed to describe HTTP 409.

Only the observed fields are accepted. Unknown fields, accessors, mismatched
project identifiers, duplicate source IDs, sparse arrays and invalid definitions
are rejected. The existing limit of 2000 dictionary entries applies after merging.
Blank descriptions remain unsupported under the current local dictionary rule;
they are rejected rather than replaced with invented text.

Tests cover spelling, merge conflicts and atomicity, inert metadata, accessor
rejection, HTTP import, persistence across restart and native export. The browser
fixture imports the dictionary and verifies the code and description in generated
project documentation. This does not establish full native-project reimport or
all original metadata compatibility.

Static reference: official offline 2.0.0 Linux package SHA-256
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`;
settings chunk `8028.3338ba9a5ad8.js`, SHA-256
`99c2ecdb2209acb4033623b64a582e698738c58df5714e5a09a515968d1a1a0f`.
Original source was inspected without executing its application.
