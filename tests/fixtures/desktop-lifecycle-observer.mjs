// Test-only observations. No timers, process control, event cancellation or payloads.
export function observeDesktopProcess(
  child,
  report = (entry) =>
    console.error("DESKTOP_PROCESS_LIFECYCLE", JSON.stringify(entry)),
) {
  const seen = new Set();
  const record = (event, sent) => {
    if (
      ![
        "exit",
        "close",
        "cleanup-signal",
        "electron-observer-unavailable",
      ].includes(event) ||
      seen.has(event)
    )
      return;
    seen.add(event);
    try {
      report({
        event,
        ...(event === "cleanup-signal" ? { sent: sent === true } : {}),
      });
    } catch {}
  };
  child.once("exit", () => record("exit"));
  child.once("close", () => record("close"));
  return record;
}

// Self-contained because Playwright serializes this function into Electron.
// stderr remains observable after Playwright disconnects its Node inspector.
// Observe before the existing synchronous native dialog handler blocks.
export function observeDesktopElectron({ app, BrowserWindow }) {
  const seen = new Set();
  const record = (event) => {
    if (seen.has(event)) return;
    seen.add(event);
    try {
      console.error("DESKTOP_ELECTRON_LIFECYCLE", JSON.stringify({ event }));
    } catch {}
  };
  for (const event of ["before-quit", "will-quit", "quit"])
    app.once(event, () => record(event));
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.prependOnceListener("will-prevent-unload", () =>
      record("will-prevent-unload"),
    );
}
