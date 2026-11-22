export function mirroredScrollTop(top, sourceRange, targetRange) {
  if (!Number.isFinite(top) || !(sourceRange > 0) || !(targetRange > 0))
    return 0;
  return (Math.max(0, Math.min(top, sourceRange)) / sourceRange) * targetRange;
}

export function bindWorkspaceDocumentScroll(
  editor,
  preview,
  { active, enabled },
) {
  const expected = new WeakMap();
  const range = (pane) => Math.max(0, pane.scrollHeight - pane.clientHeight);
  const move = (target, top) => {
    if (target.scrollTop === top) return;
    target.scrollTop = top;
    // Compare the browser's real, rounded position rather than our requested
    // value. A subsequent user movement past it can still take ownership.
    expected.set(target, target.scrollTop);
  };
  const mirror = (source, target) => {
    const top = mirroredScrollTop(
      source.scrollTop,
      range(source),
      range(target),
    );
    if (Math.abs(target.scrollTop - top) > 0.5) move(target, top);
  };
  for (const [source, target] of [
    [editor, preview],
    [preview, editor],
  ]) {
    source.addEventListener(
      "scroll",
      () => {
        const position = expected.get(source);
        expected.delete(source);
        if (!active() || !enabled() || position === source.scrollTop) return;
        mirror(source, target);
      },
      { passive: true },
    );
  }
  return {
    top() {
      if (!active()) return;
      for (const pane of [editor, preview]) {
        // A keyboard scroll can still be animating even when its current
        // position is zero. An explicit instant scroll supersedes it.
        pane.scrollTo({ top: 0, behavior: "instant" });
        expected.set(pane, pane.scrollTop);
      }
    },
    refreshPreview() {
      if (!active() || !enabled()) return;
      mirror(editor, preview);
      // Updating Markdown can clamp or anchor the scroll position even when
      // there was no explicit write. It must not move the editing caret pane.
      expected.set(preview, preview.scrollTop);
    },
  };
}
