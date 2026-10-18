import test from "node:test";
import assert from "node:assert/strict";
import { extractResponseValue, runPlan, snapshotPlan } from "../src/core.mjs";
test("response extraction supports typed JSON, case-insensitive headers, cookies, duration and whole text", () => {
  const response = {
    body: '{"zero":0}',
    duration: 0,
    headers: {
      "X-Token": "abc",
      "Set-Cookie": ["session=a=b; Path=/; HttpOnly", "empty=; Path=/"],
    },
  };
  const value = (source, path) =>
    extractResponseValue(response, { name: "result", source, path });
  assert.equal(value("json", "$.zero"), 0);
  assert.equal(value("header", "x-token"), "abc");
  assert.equal(value("cookie", "session"), "a=b");
  assert.equal(value("cookie", "empty"), "");
  assert.equal(value("duration"), 0);
  assert.equal(value("text"), response.body);
  assert.throws(() => value("xml", "/root"), /不支持/);
  assert.throws(() => value("cookie", "missing"), /无法提取/);
  assert.throws(
    () => extractResponseValue(response, { name: "__proto__", source: "text" }),
    /名称无效/,
  );
});
test("non-JSON extraction passes values to the next request and missing headers fail with evidence", async () => {
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: "http://fixture.test",
          extract: [{ name: "token", source: "header", path: "X-Token" }],
        },
      },
      {
        request: {
          url: "http://fixture.test/{{token}}",
          extract: [{ name: "missing", source: "header", path: "absent" }],
        },
      },
    ],
  });
  const seen = [];
  const result = await runPlan(plan, {}, async (request) => {
    seen.push(request.url);
    return {
      status: 200,
      body: "not JSON",
      headers: { "x-token": "abc" },
      duration: 1,
    };
  });
  assert.equal(seen[1], "http://fixture.test/abc");
  assert.equal(result.results[0].extracted.token, "abc");
  assert.equal(result.results[1].response.body, "not JSON");
  assert.equal(result.results[1].status, "failed");
});
