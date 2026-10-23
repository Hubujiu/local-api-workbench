# Expanded script drafts

The request script panel can be crowded by compatibility and operation controls.
The expanded editor is a native modal dialog with a large, labelled, monospace
textarea and a temporary draft. Opening or cancelling it does not change the
script. Apply changes only the selected before/after script in the current
in-memory request, marks the project dirty, and does not execute or save it.
Esc, Cancel and Close discard the draft and restore focus to the opener.

A draft captures its project, request, stage and original source. Applying after
any of those changes fails rather than overwriting a newer script or another
request. The other script stage is untouched. Script contents are escaped when
rendered and never evaluated by the editor.

While any modal dialog is open, global Ctrl/Cmd+S and Ctrl/Cmd+Enter shortcuts
are suppressed so they cannot unexpectedly save the underlying project or send
its request. The explicit dialog controls remain authoritative; Escape keeps
native dialog behaviour. Normal shortcuts outside dialogs remain unchanged.

Pure draft tests cover no-op, empty source, stale identity/source and invalid
input. Browser coverage includes all three dismissal routes, focus restoration,
repeat opening, stage isolation, shortcut side-effect absence, applying a real
form script and subsequent explicit save/send. Browser results require the
exact-commit CI; this is not a full IDE or a new scripting permission.


Inline editor visibility: CI screenshot review at 4279434 showed that long
compatibility/help text pushed the entire inline textarea below the request
panel at the exercised 1000px viewport. Place the existing mode selector,
actions and source editor before the explanatory content. Keep all warnings,
shared-script inheritance controls, sandbox limitations and operations present;
mode changes retain their confirmation. Browser regression requires at least
100px of the textarea visible at scrollTop=0 in both script stages. Expanded
editing remains optional, with unchanged apply/cancel and no-send semantics.
