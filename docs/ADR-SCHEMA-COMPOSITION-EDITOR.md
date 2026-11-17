# Bounded visual Schema composition editing

Expose existing `allOf`, `anyOf` and `oneOf` branches in the Schema tree, including
nested branches and boolean leaves. Add a typed branch through an explicit form;
edit its fields, constraints and local references through the existing editor.
Append without replacing parent constraints or flattening compositions. New array
branches start with string items, matching the existing array editor convention.

Deletion is a draft operation with the existing outer save/cancel behavior.
Keep at least one branch rather than silently removing the entire composition.
Reject deletion when any actual local reference targets that composition's array,
because removing a branch could shift sibling indices. Reject removal of real
nested identifiers/anchors using the existing typed guard. Literal annotation
payloads do not trigger either guard. Also refuse branch deletion when actual
non-local-Pointer, dynamic or recursive references are present: their resource
scope cannot safely be inferred by this editor. Explicit JSON editing remains the path for
whole-composition removal, reference rewrites and unsupported advanced operations.

Preserve the existing 500-row, 16-level and 32-path-part limits; allow at most 100
branches per composition. Invalid or sparse branch arrays fail explicitly. All
edits clone and validate before replacing the draft, so errors do not partially
change it. Do not silently collapse overlapping `oneOf` branches: exact-one
semantics remain meaningful, including intentionally unsatisfiable combinations.

Regression tests cover traversal, atomic edits, bounds, reference-index shifts,
identifier protection and independent Ajv validation of preserved semantics.
Browser scenarios cover add/edit/remove, outer cancellation, persistence and the
visible refusal to shift a referenced sibling. This is a bounded visual editor,
not a universal example solver or full URI/remote-reference implementation.
