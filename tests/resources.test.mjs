import test from "node:test";
import assert from "node:assert/strict";
import { validateResources } from "../src/resources.mjs";
import { runScript } from "../src/scripts.mjs";
test("project public resources validate IDs, typed attributes and status-code uniqueness", () => {
  assert.doesNotThrow(() =>
    validateResources({
      statuses: [{ id: "draft", name: "开发中", color: "#2166aa" }],
      attributes: [{ key: "owner", label: "负责人", type: "string" }],
      statusCodes: [{ code: 200, label: "成功" }],
    }),
  );
  assert.throws(
    () =>
      validateResources({
        statusCodes: [
          { code: 200, label: "A" },
          { code: 200, label: "B" },
        ],
      }),
    /状态码/,
  );
  assert.throws(
    () =>
      validateResources({
        functions: [{ name: "x;process.exit()", body: "return 1" }],
      }),
    /函数/,
  );
});
test("shared functions execute only within isolated QuickJS and can be snapshotted", async () => {
  const functions = [{ name: "double", body: "return args[0] * 2;" }];
  const result = await runScript('apt.setVar("answer", utils.double(21));', {
    variables: {},
    functions,
  });
  assert.equal(result.variables.answer, 42);
  await assert.rejects(
    runScript("utils.bad();", {
      variables: {},
      functions: [{ name: "bad", body: "return process.env;" }],
    }),
    /process/,
  );
});
