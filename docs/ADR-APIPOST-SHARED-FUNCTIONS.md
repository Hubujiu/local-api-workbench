# Bounded direct calls to imported Apipost shared functions

Modern interchange and the experimental directory JSON subset can preserve source shared functions with explicit fn_ names, text bodies, source project/ID and description. Names are bounded identifiers and case-insensitive collisions reject rather than select an arbitrary winner. Existing native functions keep their previous semantics.

Static inspection of the original send adapter shows named functions taking text and returning that input after a synchronous exception. Imported functions receive that wrapper inside the existing isolated QuickJS library and a bounded direct fn_ alias, as well as the existing utils entry. No original code/module is executed during import; source user bodies execute only when requested in the unchanged VM, with the same activity, memory, wall-time and host-access limits. A synchronous fallback is intentional source behavior, not evidence that every function operation was supported. Promise rejections and VM budget termination do not become successful fallback results.

This is direct script-call interoperability, not the full original expression engine. Literal source $function. templates and |fn_ processing chains are rejected before any project mutation. Original dynamic function generation, built-in transform parity, host modules and all global/reflection details are not claimed. Native typed dynamic function selection remains its separately documented API.

Imported sample snapshots retain the library present at import, so later project function edits cannot change their queued definition. Editing an imported function preserves its source-mode metadata; the editor explicitly explains synchronous error fallback. Case/source IDs remain provenance, not a guarantee that the body has never been edited.

Tests cover direct invocation, fallback, host-access absence, bounded runaway execution, name/source validation, unsupported expression rejection, unchanged targets, real HTTP header effects and sample-library snapshot isolation. Browser fixtures import through actual directory selection and execute a named function against the owned loopback endpoint. Original application GUI execution and arbitrary real-world user functions remain unverified.

Import-time sample function snapshots have an aggregate 4 MiB expansion guard checked before cloning them into cases. This avoids multiplying a large shared library across up to 1000 cases. Existing function count/body and VM budgets remain unchanged.
