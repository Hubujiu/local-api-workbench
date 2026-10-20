import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";
test("script errors retain execution stage without replacing semantic error messages", async () => {
  await assert.rejects(
    runScript('require("node:fs")', { variables: {} }),
    (error) => {
      assert.match(error.message, /不允许/);
      assert.equal(error.scriptStage, "script");
      return true;
    },
  );
  const run = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            url: "https://example.test",
            beforeScript: 'throw Error("diagnostic-fixture")',
          },
        },
      ],
    }),
    {},
    async () => {
      throw Error("must not send");
    },
  );
  assert.equal(run.status, "failed");
  assert.match(run.results[0].error, /diagnostic-fixture/);
  assert.equal(run.results[0].scriptStage, "script");
});
