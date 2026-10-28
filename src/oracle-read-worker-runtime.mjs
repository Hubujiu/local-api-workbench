// Internal worker lifecycle, separated only so no-network fixtures can inject a
// driver without installing/importing Oracle. Production entrypoint is fixed.
import {
  runOracleReadWithDriver,
  oracleReadFailure,
} from "./oracle-read-wip.mjs";

export function startOracleReadWorker(loadDriver) {
  let cleanupReported = false,
    connectReported = false;
  const reportPhase = (phase) => {
    if (phase === "connect") {
      if (connectReported) return;
      connectReported = true;
    }
    if (phase === "cleanup") cleanupReported = true;
    process.send?.({ kind: "oracle-phase", phase });
  };
  // This secondary watchdog never extends the supervisor's earlier deadline.
  // Unref prevents it keeping a cleanly closed worker alive.
  const watchdog = setTimeout(() => process.exit(1), 8000);
  watchdog.unref();
  process.once("disconnect", () => process.exit(1));
  process.once("message", async (input) => {
    let message;
    try {
      reportPhase("connect");
      let driver;
      try {
        driver = await loadDriver();
      } catch {
        throw oracleReadFailure("ORACLE_WIP_DRIVER_UNAVAILABLE");
      }
      const result = await runOracleReadWithDriver(input, {
        driver,
        onPhase: reportPhase,
      });
      message = { kind: "oracle-result", result };
    } catch (error) {
      message = {
        kind: "oracle-error",
        code: oracleReadFailure(error?.code).code,
      };
    }
    if (!cleanupReported) reportPhase("cleanup");
    process.send?.(message, (error) => {
      if (error) {
        process.exit(1);
        return;
      }
      // Keep parent-loss detection while any driver handles linger. Unlike
      // disconnect(), unref() leaves IPC open but permits a clean natural exit.
      process.channel?.unref();
    });
    // Never force successful exit: the parent must see actual closure, and must
    // withhold a result if leftover handles survive the cleanup deadline.
  });
}
