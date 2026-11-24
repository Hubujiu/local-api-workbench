// Let Chromium emit the input event and record a native undo unit. Direct
// value/selection writes do not join the history of typing and pasting.
export function insertTextareaText(input, { start, end, replacement }) {
  const selection = [
    input.selectionStart,
    input.selectionEnd,
    input.selectionDirection,
  ];
  input.focus({ preventScroll: true });
  input.setSelectionRange(start, end);
  if (input.ownerDocument.execCommand("insertText", false, replacement))
    return true;
  input.setSelectionRange(...selection);
  return false;
}
