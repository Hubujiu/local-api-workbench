import { runScript } from "../../src/scripts.mjs";
const ports = () =>
  process.getActiveResourcesInfo().filter((x) => x === "MessagePort").length;
const baseline = ports();
for (let round = 0; round < 5; round++) {
  await Promise.all(
    Array.from({ length: 4 }, () =>
      runScript('apt.setVar("value",1)', { variables: {} }),
    ),
  );
  if (ports() !== baseline)
    throw Error("worker ports remain after success: " + ports());
  await Promise.all(
    Array.from({ length: 4 }, () =>
      runScript('throw Error("fixture")', { variables: {} }).then(
        () => {
          throw Error("expected rejection");
        },
        (e) => {
          if (!e.message.includes("fixture")) throw e;
        },
      ),
    ),
  );
  if (ports() !== baseline)
    throw Error("worker ports remain after failure: " + ports());
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      const controller = new AbortController();
      const pending = runScript(
        "while(true){}",
        { variables: {} },
        { signal: controller.signal },
      );
      controller.abort();
      await pending.then(
        () => {
          throw Error("expected cancellation");
        },
        (error) => {
          if (!error.message.includes("取消")) throw error;
        },
      );
    }),
  );
  if (ports() !== baseline)
    throw Error("worker ports remain after cancellation: " + ports());
}
console.log("CLEAN_SCRIPT_WORKER_EXIT");
