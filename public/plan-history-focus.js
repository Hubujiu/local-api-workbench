// Capture at replacement time, not request start: never steal focus from an
// editor or navigation control the user moved to while the GET was pending.
export function capturePlanHistoryFocus(target, active) {
  if (!active || !target.contains(active)) return null;
  const record = active.closest("[data-plan-run-id]");
  if (!record || !target.contains(record)) return { kind: "fallback" };
  if (active.matches("[data-export-run]"))
    return { kind: "export", id: record.dataset.planRunId };
  return { kind: "summary", id: record.dataset.planRunId };
}
export function restorePlanHistoryFocus(target, button, captured) {
  if (!captured || !target.isConnected || !button.isConnected) return;
  // Match data values directly; record IDs are not CSS selector fragments.
  const record = [...target.querySelectorAll("[data-plan-run-id]")].find(
    (item) => item.dataset.planRunId === captured.id,
  );
  const control =
    captured.kind === "export"
      ? record?.querySelector("[data-export-run]")
      : captured.kind === "summary"
        ? record?.querySelector(":scope > summary")
        : null;
  if (control) {
    if (captured.kind === "export") record.open = true;
    control.focus({ preventScroll: true });
  } else button.focus({ preventScroll: true });
}
