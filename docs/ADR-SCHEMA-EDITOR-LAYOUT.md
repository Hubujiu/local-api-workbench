# Schema editor browsing and editing layout

Verified browser evidence showed that the empty field editor reserved almost half
the dialog width. The schema tree consequently wrapped short field names and
hid its column headings when scrolled.

When no field editor is active, use the full dialog content width for the tree.
Opening an editor restores the existing side-by-side layout; the narrow-screen
single-column layout remains unchanged. Keep the table header visible within the
existing bounded scroll area. Do not change Schema data, draft/save/cancel behavior,
modal dismissal or editor limits.

Browser geometry assertions verify full-width browsing, visible nonoverlapping
editing panels and sticky headings after actual scrolling. Existing field editing,
cancel, reference and identifier-guard flows remain in the same smoke scenario.
