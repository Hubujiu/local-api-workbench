// Host lifecycle only: the service owns transport shutdown and persistence.
// Never retry a request or reinterpret an unconfirmed write as a rollback.
export function createHostShutdown(
  service,
  report = (line) => console.error(line),
) {
  let pending;
  return () =>
    (pending ??= (async () => {
      let code = 2;
      try {
        const app = await service;
        const receipt = await app.close();
        code = receipt?.allRecordsSaved === true ? 0 : 2;
      } catch {
        // Do not expose filesystem paths, credentials or raw provider errors.
      }
      report(
        code === 0
          ? "LOCAL_API_SHUTDOWN_SAVED"
          : "LOCAL_API_SHUTDOWN_UNCONFIRMED: session history may be incomplete; no network replay attempted",
      );
      return code;
    })());
}

export function installNodeShutdown(service, host = process, report) {
  const close = createHostShutdown(service, report);
  const signal = () => {
    void close().then((code) => {
      // Preserve an already-failed host status; do not force-close active HTTP.
      host.exitCode = code || host.exitCode || 0;
    });
  };
  host.on("SIGINT", signal);
  host.on("SIGTERM", signal);
  return close;
}

export function installDesktopShutdown(app, service, report) {
  const close = createHostShutdown(service, report);
  let exiting = false;
  app.on("will-quit", (event) => {
    event.preventDefault();
    if (exiting) return;
    exiting = true;
    void close().then((code) => app.exit(code));
  });
  return close;
}
