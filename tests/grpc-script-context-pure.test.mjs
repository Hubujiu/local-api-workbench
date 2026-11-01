import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGrpcScripts,
  normalizeGrpcScriptContext,
  grpcScriptContext,
} from "../src/grpc-script-context.mjs";
const step = {
  grpc: {
    definition: {
      target: "grpc://localhost:5000",
      service: "fixture.Echo",
      method: "Unary",
      timeoutMs: 1000,
      proto: "not exposed",
      metadata: "not exposed",
      tls: "not exposed",
    },
  },
};
const context = () => grpcScriptContext(step, "before", [{ text: "{{name}}" }]);
test("gRPC script v1 configuration is bounded, exact and independently copied", () => {
  assert.equal(normalizeGrpcScripts(undefined), undefined);
  assert.deepEqual(normalizeGrpcScripts({ version: 1 }), {
    version: 1,
    before: "",
    after: "",
  });
  const value = {
    version: 1,
    before: "x".repeat(100000),
    after: "y".repeat(100000),
  };
  assert.deepEqual(normalizeGrpcScripts(value), value);
  assert.notEqual(normalizeGrpcScripts(value), value);
  for (const invalid of [
    null,
    [],
    {},
    { version: 2 },
    { version: "1" },
    { version: 1, extra: true },
    { version: 1, before: null },
    { version: 1, after: [] },
    { version: 1, before: "x".repeat(100001) },
  ])
    assert.throws(() => normalizeGrpcScripts(invalid), /gRPC脚本/);
});
test("native context projects only explicit non-secret fields without HTTP status", () => {
  const before = context();
  assert.equal(Object.hasOwn(before, "result"), false);
  assert.equal(before.request.messages[0].text, "{{name}}");
  assert.doesNotMatch(
    JSON.stringify(before),
    /not exposed|metadata|tls|proto"|code/,
  );
  const result = {
    status: { code: 7, details: "denied" },
    messages: [{ text: "body", big: "9223372036854775807", blob: "AQID" }],
    durationMs: 2,
    metadata: [{ value: "secret" }],
    trailers: [{ value: "secret" }],
    tls: { key: "secret" },
  };
  const after = grpcScriptContext(step, "after", [{ text: "input" }], result);
  assert.deepEqual(after.result, {
    status: result.status,
    messages: result.messages,
    durationMs: 2,
  });
  result.messages[0].text = "mutated";
  assert.equal(after.result.messages[0].text, "body");
  assert.doesNotMatch(JSON.stringify(after), /secret|metadata|trailers|tls/);
});
test("native context rejects forged capabilities, HTTP status and malformed message graphs", () => {
  for (const change of [
    { protocol: "http" },
    { phase: "other" },
    { metadata: [] },
    { result: {} },
    { request: { ...context().request, tls: {} } },
    { request: { ...context().request, timeoutMs: 30001 } },
    { request: { ...context().request, messages: [{ n: Infinity }] } },
    {
      request: {
        ...context().request,
        messages: [JSON.parse('{"__proto__":{}}')],
      },
    },
    { request: { ...context().request, messages: [{ text: "\ud800" }] } },
    {
      request: {
        ...context().request,
        messages: [{ text: "x".repeat(1024 * 1024) }],
      },
    },
  ])
    assert.throws(
      () => normalizeGrpcScriptContext({ ...context(), ...change }),
      /上下文/,
    );
  const after = grpcScriptContext(step, "after", [], {
    status: { code: 0, details: "" },
    messages: [],
    durationMs: 0,
  });
  assert.throws(
    () =>
      normalizeGrpcScriptContext({
        ...after,
        result: { ...after.result, status: { code: 200, details: "OK" } },
      }),
    /上下文/,
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () =>
      normalizeGrpcScriptContext({
        ...context(),
        request: { ...context().request, messages: [cyclic] },
      }),
    /上下文/,
  );
});

test("direct callers cannot execute accessors or hide fields in versioned JSON", () => {
  let reads = 0;
  const accessor = {
    version: 1,
    get before() {
      reads++;
      return "";
    },
  };
  assert.throws(() => normalizeGrpcScripts(accessor));
  assert.equal(reads, 0);
  for (const value of [
    Object.defineProperty({ version: 1 }, "after", {
      value: "",
      enumerable: false,
    }),
    { version: 1, [Symbol("extra")]: true },
  ])
    assert.throws(() => normalizeGrpcScripts(value));
  for (const messages of [
    [
      {
        get text() {
          reads++;
          return "unsafe";
        },
      },
    ],
    Array(1),
    Object.assign([{}], {
      toJSON() {
        reads++;
        return [];
      },
    }),
  ])
    assert.throws(() =>
      normalizeGrpcScriptContext({
        ...context(),
        request: { ...context().request, messages },
      }),
    );
  assert.equal(reads, 0);
});

test("array subclasses cannot smuggle inherited serialization callbacks", () => {
  let calls = 0;
  class CustomArray extends Array {
    toJSON() {
      calls++;
      return [];
    }
  }
  const messages = new CustomArray({ text: "hidden" });
  assert.throws(
    () =>
      normalizeGrpcScriptContext({
        ...context(),
        request: { ...context().request, messages },
      }),
    /上下文/,
  );
  assert.equal(calls, 0);
});
