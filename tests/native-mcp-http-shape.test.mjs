import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNativeHTTPPlan,
  assertNativeHTTPResult,
} from "../src/native-mcp-http-shape.mjs";
const request = {
  id: "http",
  method: "GET",
  url: "http://fixture.invalid",
  auth: { type: "bearer" },
  body: '{"protocol":"application-data"}',
};
test("native HTTP plans retain full HTTP/empty definitions without inspecting request data as step types", () => {
  for (const plan of [
    { steps: [] },
    { steps: [{ request }] },
    { steps: [{ type: "http", enabled: false, request }] },
  ]) {
    const before = structuredClone(plan);
    assertNativeHTTPPlan(plan);
    assert.deepEqual(plan, before);
  }
});
test("native plans reject explicit and marker-only nonHTTP including disabled and mixed steps", () => {
  for (const type of ["grpc", "socketio", "protocol", "repeat", "unknown"])
    for (const enabled of [true, false]) {
      const plan = {
        steps: [
          { request },
          { type, enabled, request, [type]: { secret: "private-sentinel" } },
        ],
      };
      const before = structuredClone(plan);
      assert.throws(
        () => assertNativeHTTPPlan(plan),
        (error) =>
          error.message ===
          "原版兼容流程仅支持HTTP步骤；请使用canonical计划工具",
      );
      assert.deepEqual(plan, before);
    }
  for (const field of [
    "grpc",
    "socketio",
    "protocol",
    "grpcResult",
    "socketioResult",
    "protocolResult",
    "steps",
  ])
    assert.throws(
      () => assertNativeHTTPPlan({ steps: [{ request, [field]: null }] }),
      /仅支持HTTP/,
    );
  for (const plan of [
    null,
    [],
    {},
    { steps: {} },
    { steps: [null] },
    { steps: [{}] },
    { steps: [{ request: [] }] },
  ])
    assert.throws(() => assertNativeHTTPPlan(plan), /仅支持HTTP/);
});
test("native results reject nonHTTP snapshots, result discriminants and legacy marker-only evidence", () => {
  for (const field of [
    "grpc",
    "socketio",
    "protocol",
    "grpcResult",
    "socketioResult",
    "protocolResult",
  ]) {
    for (const run of [
      { [field]: {} },
      { results: [{ [field]: {} }] },
      {
        snapshot: { steps: [{ request, [field]: {} }] },
        results: [{ request }],
      },
    ])
      assert.throws(() => assertNativeHTTPResult(run), /原版兼容结果/);
  }
  for (const type of ["grpc", "socketio", "protocol", "repeat", "unknown"]) {
    assert.throws(() => assertNativeHTTPResult({ type }), /原版兼容结果/);
    assert.throws(
      () => assertNativeHTTPResult({ results: [{ type }] }),
      /原版兼容结果/,
    );
  }
  for (const run of [
    { repeat: {} },
    { results: [{ repeat: {} }] },
    { results: {} },
    { results: [null] },
    { snapshot: { steps: null } },
  ])
    assert.throws(() => assertNativeHTTPResult(run), /原版兼容结果/);
});
test("native sparse legacy summaries remain sparse and HTTP response protocol stays ordinary data", () => {
  for (const run of [
    {},
    { results: [] },
    { status: "failed", results: [{ status: "failed" }] },
    { request: { body: "private" }, response: { protocol: "HTTP/1.1" } },
    {
      snapshot: { steps: [{ request }] },
      results: [
        {
          type: "http",
          request,
          response: { protocol: "HTTP/2", body: '{"grpc":true}' },
        },
      ],
    },
  ]) {
    const before = structuredClone(run);
    assertNativeHTTPResult(run);
    assert.deepEqual(run, before);
  }
});
