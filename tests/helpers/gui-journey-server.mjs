import { fork } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
export async function startJourneyServer(root) {
  const child = fork(
    new URL("../fixtures/gui-journey-server.mjs", import.meta.url),
    [root],
    { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const exited = once(child, "exit");
  let timer, closing;
  async function terminate() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    let deadline;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(Error("Journey child cleanup did not settle")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }
  try {
    const ready = await Promise.race([
      once(child, "message").then(([message]) => message),
      exited.then(() => {
        throw Error("Journey server exited before ready");
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Journey server startup timeout")),
          15000,
        );
      }),
    ]);
    assert.equal(ready.ready, true);
    assert.equal(ready.pid, child.pid);
    return {
      ...ready,
      close() {
        return (closing ??= (async () => {
          let closeTimer;
          try {
            child.send("close");
            const [code, signal] = await Promise.race([
              exited,
              new Promise((_, reject) => {
                closeTimer = setTimeout(
                  () => reject(Error("Journey server close timeout")),
                  15000,
                );
              }),
            ]);
            assert.equal(code, 0);
            assert.equal(signal, null);
          } finally {
            clearTimeout(closeTimer);
            await terminate();
          }
        })());
      },
    };
  } catch (error) {
    await terminate().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
