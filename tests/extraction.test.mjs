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

test("text regex extraction is isolated, bounded and distinguishes empty matches from missing groups", async () => {
  const { extractResponse } = await import("../src/core.mjs");
  const rule = {
    name: "token",
    source: "regex",
    path: "/TOKEN=([a-z]+)/i",
    group: 1,
  };
  assert.equal(await extractResponse({ body: "token=abc" }, rule), "abc");
  assert.equal(
    await extractResponse({ body: "" }, { ...rule, path: "/^$/", group: 0 }),
    "",
  );
  await assert.rejects(
    extractResponse({ body: "token=abc" }, { ...rule, group: 2 }),
    /捕获组不存在/,
  );
  await assert.rejects(
    extractResponse({ body: "x" }, { ...rule, path: "[" }),
    /正则需要/,
  );
  await assert.rejects(
    extractResponse({ body: "x".repeat(256 * 1024 + 1) }, rule),
    /256 KiB/,
  );
  await assert.rejects(
    extractResponse(
      { body: "a".repeat(50000) + "!" },
      { ...rule, path: "/(a+)+$/", group: 0 },
    ),
    /interrupt|超时|终止/i,
  );
});

test("regex extraction is awaited before subsequent plan variable interpolation", async () => {
  const seen = [];
  const result = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            url: "http://fixture.test",
            extract: [
              { name: "id", source: "regex", path: "/id=(\\d+)/", group: 1 },
            ],
          },
        },
        { request: { url: "http://fixture.test/{{id}}" } },
      ],
    }),
    {},
    async (request) => {
      seen.push(request.url);
      return { status: 200, body: "id=42", headers: {}, duration: 1 };
    },
  );
  assert.equal(result.status, "passed");
  assert.equal(seen[1], "http://fixture.test/42");
  assert.equal(result.results[0].extracted.id, "42");
});
