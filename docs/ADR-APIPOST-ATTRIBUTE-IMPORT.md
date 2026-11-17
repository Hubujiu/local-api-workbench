# Modern project attribute import

Static original settings and export code identifies seven attribute types: text,
number, single choice, multiple choice, date, URL and email. Definitions use
`attribute_id`, `field_name`, `field_type`, `enable`, `tooltip`, `sort`, `extra`
and `open_api_field`; selection options are key/value pairs. Request values are
stored separately in `attribute_info`, keyed by the original attribute ID.

Modern import now maps these definitions to stable project-namespaced local keys
and translates request references. String option identities, labels, zero values,
arrays and disabled values are retained. Definitions are stably sorted by their
explicit integer sort order, with source order for ties. Missing sort values use
source position. Inert original project/attribute/sort metadata is preserved.

The local definition model now supports an explicit enabled flag and a bounded
help description. Disabled fields retain their values but are omitted from
request/document editors, share selection and generated selected-attribute output.
They can be reenabled in the definition editor. Help text is escaped and exposed
as a title and accessible description. Existing definitions without an enabled
flag remain enabled. All existing typed-value checks remain in effect.

Limitations are explicit: folder attribute values and custom OpenAPI field
mappings are rejected, not discarded. Date import accepts the local canonical
YYYY-MM-DD form only. An original serialized date-time cannot safely be reduced
to a calendar date without its original timezone, so it is rejected. Unknown
attributes, fields, states, option metadata and incompatible existing definitions
fail the whole import before mutation. Malformed URL/email and other values are
not coerced. This is not a full native-project format roundtrip.

Tests cover all mapped types, enabled/disabled state, descriptions, choices,
zero values, atomic conflicts and unknown references, escaping, real HTTP import,
restart and native export. Browser evidence imports enabled/disabled definitions,
edits an enabled value, saves it and verifies the disabled value remains intact.

Static reference: official offline 2.0.0 Linux package SHA-256
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`;
work UI index `index-0d1d8198fa5a.js`, SHA-256
`20bb6e21fd678ead16bd91807dc9623b8cd3e7019d44ac874a167c31a37f39fb`.
UI module 424624 and the modern export attribute mapper were inspected statically;
no original application execution is claimed.
