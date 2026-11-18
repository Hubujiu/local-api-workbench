import assert from "node:assert/strict";
import test from "node:test";
import {
  runDamengProcess,
  superviseDamengProcess,
} from "../src/dameng-process.mjs";

const entry = new URL("./fixtures/dameng-process-fixture.mjs", import.meta.url);
const input = (scenario) => ({
  connection: {
    host: "synthetic.test",
    serverName: "synthetic.test",
    ssl: true,
    user: "user",
    password: "synthetic-only",
    ca: "unit-test-ca",
  },
  sql: "SELECT V FROM APP.T WHERE K=:p0",
  parameters: [scenario],
});
const run = (scenario, options) =>
  superviseDamengProcess(entry, input(scenario), options);

test("fixed production child remains closed without a verified Dameng driver", async () => {
  await assert.rejects(runDamengProcess(input("unused")), {
    message: "DAMENG_VERIFIED_TRANSPORT_UNAVAILABLE",
  });
});

test("supervisor accepts a clean exact decimal result only after child closure", async () => {
  const result = await run("success");
  assert.deepEqual(result.rows, [
    { V: "99999999999999999999999999999999999999" },
  ]);
});

test("supervisor discards wrong, duplicate and unclean-exit receipts", async () => {
  for (const mode of ["bad-result", "second", "dirty-exit"]) {
    await assert.rejects(run(mode), {
      message: "DAMENG_READ_FAILED_NO_RESULT",
    });
  }
});

test("supervisor kills a real child that sent a result but never closes", async () => {
  await assert.rejects(run("late-exit"), { message: "DAMENG_READ_TIMEOUT" });
});

test("supervisor cancels despite a child blocking its entire event loop", async () => {
  const signal = AbortSignal.timeout(150);
  await assert.rejects(run("hang", { signal }), {
    message: "DAMENG_READ_CANCELLED",
  });
});

test("request cannot provide an executable option", () => {
  const body = { ...input("success"), driver: "file:///user/injected.mjs" };
  assert.throws(() => runDamengProcess(body), {
    message: "DAMENG_READ_INPUT_INVALID",
  });
});
