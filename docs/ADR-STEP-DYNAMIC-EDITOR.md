# Step-local dynamic parameter editor

A plan step's Header/Query/Path/Cookie/text-form rows can configure fixed JSON, an existing variable, or a bounded Mock expression, plus up to10 ordered existing transform names. This edits only the frozen step request; source interfaces are untouched.

- Fixed false/zero/null/objects retain JSON types. Invalid/nonfinite JSON, oversized values, invalid source/type and invalid unsigned32-bit Mock seeds reject the draft before save. Disabled dynamic values are removed explicitly, revealing the ordinary parameter value.
- Existing unknown dynamic metadata is retained. File rows cannot also have dynamic text; users must disable the dynamic value before saving a file row.
- The editor does not execute a preview or claim referenced variables/functions currently exist. Resolution occurs through the existing run pipeline after pre-script variables are available, with its existing request limits. Missing variables/functions fail with normal step evidence.
- Raw Body definitions gained their own controls in the extension below; this does not claim every advanced step setting has a source-identical visual editor.
- Fixed UI regression: invalid JSON keeps the dialog open; corrected fixed multipart value persists; variable header resolves from the pre-script in an actual multipart request; reopening preserves configuration. Existing failed-save/cancel and independent snapshot checks remain.

## Raw Body extension

The step editor also manages independent Raw Body definitions, JSON/text output mode, cursor insertion and explicit removal of the definition plus matching tokens. Disabled definitions still referenced by the body reject save; cancellation leaves the previous stored snapshot intact. Up to100 definitions are editable. This uses the existing bounded execution pipeline and does not execute a preview.
