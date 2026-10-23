import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
test("getHeaders preserves duplicates and disabled rows with explicit case and enabled options", async () => {
  const headers = [
    { key: "X-Test", value: "one" },
    { key: "X-Test", value: "two", enabled: false },
    { key: "x-test", value: "three" },
    { key: "", value: "empty" },
    { key: "__proto__", value: "literal" },
  ];
  const result = await runScript(
    `apt.setVar('all',pm.request.getHeaders());apt.setVar('enabled',apt.request.getHeaders({enabled:true,ignoreCase:true,sanitizeKeys:true}));apt.setVar('multi',pm.request.getHeaders({multiValue:false}));const copy=pm.request.getHeaders();copy['X-Test'].push('changed');apt.setVar('again',pm.request.getHeaders());`,
    { variables: {}, request: { headers } },
  );
  assert.deepEqual(result.variables.all["X-Test"], ["one", "two"]);
  assert.equal(result.variables.all["x-test"], "three");
  assert.equal(result.variables.all[""], "empty");
  assert.equal(
    Object.getOwnPropertyDescriptor(result.variables.all, "__proto__").value,
    "literal",
  );
  assert.deepEqual(result.variables.enabled["x-test"], ["one", "three"]);
  assert.equal(Object.hasOwn(result.variables.enabled, ""), false);
  assert.deepEqual(result.variables.multi, result.variables.all);
  assert.deepEqual(result.variables.again, result.variables.all);
  assert.deepEqual(result.request.headers, headers);
});
test("getHeaders rejects unknown/nonboolean options and unbounded output without mutating input", async () => {
  for (const options of [{ enabled: "true" }, { unsupported: true }])
    await assert.rejects(
      runScript(`pm.request.getHeaders(${JSON.stringify(options)})`, {
        variables: {},
        request: { headers: [] },
      }),
      /Header选项/,
    );
  await assert.rejects(
    runScript("pm.request.getHeaders()", {
      variables: {},
      request: { headers: [{ key: "x", value: "中".repeat(30000) }] },
    }),
    /Header.*限制|Header.*64KiB/,
  );
});
