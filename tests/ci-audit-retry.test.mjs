import test from "node:test";
import assert from "node:assert/strict";
import { auditDependencies } from "../scripts/audit-dependencies.mjs";
const clean = {
  code: 0,
  stdout: JSON.stringify({
    metadata: { vulnerabilities: { high: 0, critical: 0 } },
  }),
  stderr: "",
};
const network = {
  code: 1,
  stdout: JSON.stringify({ error: { code: "ETIMEDOUT" } }),
  stderr: "network timeout",
};

test("audit retries a transient network failure once but only a genuine clean report passes", async () => {
  let calls = 0,
    sleeps = 0;
  assert.equal(
    await auditDependencies(async () => (++calls === 1 ? network : clean), {
      sleep: async () => {
        sleeps++;
      },
    }),
    0,
  );
  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
});
test("audit rejects security findings and malformed success without retrying", async () => {
  for (const result of [
    {
      code: 1,
      stdout: JSON.stringify({
        metadata: { vulnerabilities: { high: 1, critical: 0 } },
      }),
      stderr: "",
    },
    { code: 0, stdout: "", stderr: "" },
    {
      code: 0,
      stdout: JSON.stringify({
        metadata: { vulnerabilities: { high: 1, critical: 0 } },
      }),
      stderr: "",
    },
    { code: 1, stdout: "", stderr: "permission denied" },
  ]) {
    let calls = 0;
    assert.equal(
      await auditDependencies(
        async () => {
          calls++;
          return result;
        },
        { sleep: async () => assert.fail("must not retry") },
      ),
      1,
    );
    assert.equal(calls, 1);
  }
});
test("audit keeps repeated network failure as failure and never retries indefinitely", async () => {
  let calls = 0;
  assert.equal(
    await auditDependencies(
      async () => {
        calls++;
        return network;
      },
      { sleep: async () => {} },
    ),
    1,
  );
  assert.equal(calls, 2);
});
