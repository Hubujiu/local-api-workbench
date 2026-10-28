// Deliberately unreachable from production provider registries. Only the owned
// supervisor may start this process. Local tests inject a driver elsewhere.
import {
  runOracleReadWithDriver,
  oracleReadFailure,
} from "./oracle-read-wip.mjs";

let cleanupReported = false;
const reportPhase = (phase) => {
  if (phase === "cleanup") cleanupReported = true;
  process.send?.({ kind: "oracle-phase", phase });
};
process.once("disconnect", () => {
  // Parent death must not leave a standalone authenticated Oracle process.
  process.exit(1);
});
process.once("message", async (input) => {
  let message;
  try {
    // No initOracleClient(), plugins, pool, global driver settings, or fallback.
    // Only ordinary CI may validate this import; it is not run in local tests.
    const driver = (await import("oracledb")).default;
    const result = await runOracleReadWithDriver(input, {
      driver,
      onPhase: reportPhase,
    });
    message = { kind: "oracle-result", result };
  } catch (error) {
    const safe = oracleReadFailure(error?.code);
    message = { kind: "oracle-error", code: safe.code };
  }
  if (!cleanupReported) reportPhase("cleanup");
  process.send?.(message, (error) => {
    if (error) process.exitCode = 1;
    // Remove the emergency parent-death handler on a deliberate disconnect.
    process.removeAllListeners("disconnect");
    if (process.connected) process.disconnect();
  });
  // Do not force successful exit: lingering driver handles must keep the worker
  // observable so the supervisor can terminate it and withhold the result.
});
