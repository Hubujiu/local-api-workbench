// CI-only Node TLS proof, not an Oracle wire peer or real-driver test.
import tls from "node:tls";
import { loadOracleReadWorkerDriver } from "../../src/oracle-read-worker-runtime.mjs";

const watchdog = setTimeout(() => process.exit(1), 3000);
watchdog.unref();
process.once("disconnect", () => process.exit(1));
process.once("message", async (input) => {
  let proof;
  try {
    const { driver } = await loadOracleReadWorkerDriver(
      input,
      () =>
        new Promise((resolve) => {
          let outcome;
          // Match the published driver's undefined-wallet secure-context pattern,
          // using only public Node APIs. This is still not an Oracle handshake.
          const socket = tls.connect({
            host: "127.0.0.1",
            port: input.port,
            servername: input.host,
            rejectUnauthorized: true,
            secureContext: tls.createSecureContext({
              ca: undefined,
              cert: undefined,
              key: undefined,
            }),
          });
          socket.once("secureConnect", () => {
            outcome = { authorized: socket.authorized };
            socket.destroy();
          });
          socket.once("error", (error) => {
            outcome = { authorized: false, code: error.code };
            socket.destroy();
          });
          socket.once("close", () => resolve(outcome || { authorized: false }));
        }),
    );
    proof = driver;
  } catch (error) {
    proof = { authorized: false, code: error.code };
  }
  process.send?.(proof, (error) => {
    if (error) process.exit(1);
    else process.channel?.unref();
  });
});
