# Compact parameter row layout

A real browser artifact at 1000×760 showed each parameter's four action buttons
stacked vertically inside a 35-pixel table column. The form type selector and
value input also wrapped onto separate lines. This made a simple text row more
than 100 pixels high and hid most fields behind the panel's scroll area.

Use a scoped fixed-layout parameter table, an adequately sized action column,
and flex rows for actions and field values. Keep all existing controls, labels,
selectors and behaviors. File rows retain a separate ellipsized saved filename
with its full value in a title. Do not change unrelated tables or the theme.

The full browser regression checks text-row height, action alignment, type/value
alignment and table overflow at 1000- and 1440-pixel viewport widths. Existing
editing, dictionary, dynamic-value and asynchronous file-selection tests remain.
Local browser launch may be unavailable under the execution environment's
process restrictions; no launch/security flags are changed to work around it.
The existing CI browser job supplies the execution evidence and screenshot.
