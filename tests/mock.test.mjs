import test from "node:test";
import assert from "node:assert/strict";
import { validateMockRules, selectMockResponse } from "../src/mock.mjs";
test("Mock matches ordered enabled AND rules and falls back to stored examples", () => {
  const request = {
    examples: [{ status: 200, body: "default" }],
    mockRules: [
      {
        name: "skip",
        enabled: false,
        conditions: [],
        response: { status: 500, body: "skip" },
      },
      {
        name: "admin",
        conditions: [
          { target: "query.role", op: "eq", value: "admin" },
          { target: "body.active", op: "eq", value: true },
        ],
        response: { status: 201, body: "admin", headers: { "x-rule": "yes" } },
      },
    ],
  };
  assert.equal(
    selectMockResponse(request, {
      query: { role: "admin" },
      body: { active: true },
    }).status,
    201,
  );
  assert.equal(
    selectMockResponse(request, {
      query: { role: "admin" },
      body: { active: false },
    }).body,
    "default",
  );
  assert.throws(
    () =>
      validateMockRules([
        {
          conditions: [],
          response: {
            status: 200,
            body: "ok",
            headers: { "content-length": "999" },
          },
        },
      ]),
    /传输/,
  );
  assert.throws(
    () =>
      validateMockRules([
        {
          conditions: [],
          response: { status: 200, body: "ok", delayMs: 6000 },
        },
      ]),
    /延迟/,
  );
});

test("Mock HTTP route matches body/header/query and honors project service disable", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os"),
    path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "mock-rules-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("Smart Mock");
  p.requests = [
    {
      id: "mock",
      name: "Mock",
      url: "http://localhost",
      examples: [{ status: 200, body: "fallback" }],
      mockRules: [
        {
          conditions: [
            { target: "method", op: "eq", value: "POST" },
            { target: "query.role", op: "eq", value: "admin" },
            { target: "body.active", op: "eq", value: true },
          ],
          response: {
            status: 201,
            body: "matched",
            headers: { "x-fixture": "rule" },
            delayMs: 1,
          },
        },
      ],
    },
  ];
  await app.store.save(p);
  let response = await fetch(app.url + "/mock/" + p.id + "/mock?role=admin", {
    method: "POST",
    body: '{"active":true}',
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-fixture"), "rule");
  assert.equal(await response.text(), "matched");
  p.settings.mockEnabled = false;
  await app.store.save(p);
  response = await fetch(app.url + "/mock/" + p.id + "/mock");
  assert.equal(response.status, 503);
});
