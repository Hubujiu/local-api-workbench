import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../src/server.mjs";
import {
  importIntoProject,
  restoreProject,
  normalizeRequest,
} from "../src/core.mjs";
import { nativeMockFixture } from "./fixtures/apipost-native-mock.mjs";
import { nativeMockResponse } from "../src/native-mock-runtime.mjs";
import { normalizeNativeMock } from "../src/native-mock.mjs";
const plain = (op, value) => ({
  version: 1,
  enabled: true,
  sourceTargetId: "fixture",
  rules: [
    {
      id: "r",
      name: "rule",
      enabled: true,
      conditions: [{ path: "$.body.value", op, value }],
      response: { status: 200, sourceStatus: 404, body: "hit" },
    },
  ],
  fallback: { status: 200, sourceStatus: 200, body: "miss" },
});
test("native directory Mock import -> actual HTTP -> save/reload/restore preserves conditional headers, schema priority and fixed200", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mock-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const source = nativeMockFixture().directory,
    before = JSON.stringify(source),
    p = await app.store.create("source");
  importIntoProject(p, source);
  await app.store.save(p);
  assert.equal(JSON.stringify(source), before);
  const saved = await app.store.get(p.id),
    restored = restoreProject(JSON.stringify(saved));
  await app.store.save(restored);
  const check = async (project, query, expected) => {
    const r = await fetch(
      app.url + "/mock/" + project.id + "/" + project.requests[0].id + query,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-native-rule"), expected);
    assert.match(r.headers.get("content-security-policy"), /sandbox/);
    assert.deepEqual(await r.json(), { kind: expected });
  };
  for (const project of [saved, restored])
    for (const [query, expected] of [
      ["", "fallback"],
      ["?mode=fail", "matched"],
      ["?mode=FAIL", "fallback"],
      ["?mode=pass", "fallback"],
      ["?mode=fail&mode=pass", "fallback"],
      ["?mode=pass&mode=fail", "matched"],
    ])
      await check(project, query, expected);
  const namedExample = await app.store.get(restored.id);
  namedExample.requests[0].nativeMock.rules[0].conditions[0].path =
    "$.query.example";
  await app.store.save(namedExample);
  await check(namedExample, "?example=pass&example=fail", "matched");
  await check(namedExample, "?example=fail&example=pass", "fallback");
  const changed = await app.store.get(restored.id);
  changed.requests[0].nativeMock.rules[0].enabled = false;
  await app.store.save(changed);
  await Promise.all([
    check(saved, "?mode=fail", "matched"),
    check(changed, "?mode=fail", "fallback"),
  ]);
  assert.deepEqual(
    (await app.store.get(saved.id)).requests[0].nativeMock,
    saved.requests[0].nativeMock,
  );
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  app = await createApp({ root, port: 0 });
  await check(saved, "?mode=fail", "matched");
  const disabled = await app.store.get(restored.id);
  disabled.requests[0].nativeMock.enabled = false;
  await app.store.save(disabled);
  assert.equal(
    (
      await fetch(
        app.url + "/mock/" + disabled.id + "/" + disabled.requests[0].id,
      )
    ).status,
    404,
  );
});
test("native conditional comparisons preserve explicit coercion, existence and collection semantics", async () => {
  const cases = [
    ["eq", "1", 1, true],
    ["eq", "1", "01", false],
    ["uneq", "1", 2, true],
    ["gt", "2", 3, true],
    ["gte", "3", 3, true],
    ["lt", "3", 2, true],
    ["lte", "2", 2, true],
    ["includes", "01", "1", true],
    ["includes", "2", [1, 2], true],
    ["unincludes", "x", "abc", true],
    ["null", "", 0, true],
    ["null", "", {}, true],
    ["notnull", "", [1], true],
    ["exist", "", null, true],
    ["notexist", "", undefined, true],
    ["belongscollection", "a,b", "b", true],
    ["notbelongscollection", "a, b", "b", true],
    ["eq", "x", { toString: "not-a-function" }, false],
  ];
  for (const [op, value, actual, expected] of cases) {
    const response = await nativeMockResponse(
      { settings: {} },
      { nativeMock: plain(op, value) },
      { body: { value: actual } },
    );
    assert.equal(
      response.body,
      expected ? "hit" : "miss",
      op + JSON.stringify(actual),
    );
  }
  const regex = await nativeMockResponse(
    { settings: {} },
    { nativeMock: plain("regularmatch", "/^yes$/i") },
    { body: { value: "YES" } },
  );
  assert.equal(regex.body, "hit");
  assert.equal(
    (
      await nativeMockResponse(
        { settings: {} },
        { nativeMock: plain("regularmatch", "/yes/") },
        { body: { value: { toString: "not-callable" } } },
      )
    ).body,
    "miss",
  );
});
test("native Mock invalid dependencies fail atomically and persistence rejects protected headers and ambiguous rules", async () => {
  const changes = [
    (x) => (x.config.target_id = "other"),
    (x) => (x.config.project_id = "other"),
    (x) => (x.config.ai_expect.list[0].expect_id = "missing"),
    (x) => (x.config.mock_ip_white_list_enable = 1),
    (x) => (x.config.ai_expect.list[0].conditions[0].compareType = "execute"),
    (x) =>
      (x.config.ai_expect.list[0].conditions[0].name = "__proto__.polluted"),
    (x) => (x.config.ai_expect.list[0].conditions[1].value = "partial"),
  ];
  for (const change of changes) {
    const x = nativeMockFixture();
    change(x);
    x.directory.files.find((f) => f.path === "settings/mock_api.json").text =
      JSON.stringify(x.config);
    const p = {
      requests: [],
      folders: [],
      environments: [],
      servers: [],
      globalVariables: {},
      settings: {},
    };
    const before = structuredClone(p);
    assert.throws(() => importIntoProject(p, x.directory));
    assert.deepEqual(p, before);
  }
  const model = plain("eq", "x");
  model.rules[0].response.headers = { "set-cookie": "should-not-set" };
  assert.throws(() => normalizeNativeMock(model), /隔离头/);
  assert.throws(
    () =>
      normalizeRequest({
        nativeMock: plain("eq", "x"),
        mockRules: [{ conditions: [], response: { status: 200, body: "x" } }],
      }),
    /混用/,
  );
  assert.throws(
    () => normalizeNativeMock(plain("regularmatch", "/a/v")),
    /flags/,
  );
});
test("native Mock regex stays in bounded isolated workers and concurrency is capped without poisoning later requests", async () => {
  const input = { body: { value: "yes" } },
    request = { nativeMock: plain("regularmatch", "/^yes$/") };
  const pending = Array.from({ length: 4 }, () =>
    nativeMockResponse({ settings: {} }, request, input),
  );
  await assert.rejects(
    nativeMockResponse({ settings: {} }, request, input),
    /并发/,
  );
  assert.deepEqual(
    (await Promise.all(pending)).map((r) => r.body),
    ["hit", "hit", "hit", "hit"],
  );
  await assert.rejects(
    nativeMockResponse(
      { settings: {} },
      { nativeMock: plain("regularmatch", "/(a+)+$/") },
      { body: { value: "a".repeat(30000) + "!" } },
    ),
    /超时|interrupt/,
  );
  assert.equal(
    (await nativeMockResponse({ settings: {} }, request, input)).body,
    "hit",
  );
  const early = plain("regularmatch", "/(a+)+$/");
  early.rules.unshift({
    id: "first",
    name: "first",
    enabled: true,
    conditions: [],
    response: { status: 200, sourceStatus: 200, body: "early" },
  });
  assert.equal(
    (
      await nativeMockResponse(
        { settings: {} },
        { nativeMock: early },
        { body: { value: "a".repeat(30000) + "!" } },
      )
    ).body,
    "early",
  );
});
