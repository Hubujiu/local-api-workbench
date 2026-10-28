// Deliberately unreachable from production provider registries. Only the owned
// supervisor starts this fixed entrypoint. No Thick init/plugins/global options.
import { startOracleReadWorker } from "./oracle-read-worker-runtime.mjs";

startOracleReadWorker(async () => (await import("oracledb")).default);
