// Data-only validation: imports no application, VM, transport or I/O module.
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProtocolScripts,
  wireScriptContext,
  normalizeWireScriptContext,
  validateWireScriptBinding,
  validatePlanProtocolScripts,
  rejectHTTPProtocolScripts,
  WIRE_SCRIPT_CONTEXT_BYTES,
} from "../src/wire-script-context.mjs";

const tcp = () => ({
  definition: { type: "tcp", url: "localhost", port: 5000 },
  duration: 1000,
  message: "{{input}}",
});
const nativeTCP = (text = "reply") => ({
  status: "completed",
  durationMs: 1,
  result: {
    body: text,
    base64: Buffer.from(text).toString("base64"),
    size: Buffer.byteLength(text),
    timedOut: false,
    partial: false,
  },
});
test("wire script v1 fields normalize exactly and reject non-JSON source descriptors", () => {
  assert.equal(normalizeProtocolScripts(undefined), undefined);
  assert.deepEqual(normalizeProtocolScripts({ version: 1 }), {
    version: 1,
    before: "",
    after: "",
  });
  assert.equal(
    normalizeProtocolScripts({ version: 1, before: "x".repeat(100000) }).before
      .length,
    100000,
  );
  for (const bad of [
    null,
    [],
    {},
    { version: 2 },
    { version: 1, before: null },
    { version: 1, after: [] },
    { version: 1, before: "x".repeat(100001) },
    { version: 1, unknown: "" },
    { version: 1, [Symbol("hidden")]: "" },
    Object.defineProperty({ version: 1 }, "after", {
      value: "",
      enumerable: false,
    }),
  ])
    assert.throws(() => normalizeProtocolScripts(bad));
  let reads = 0;
  assert.throws(() =>
    normalizeProtocolScripts({
      version: 1,
      get before() {
        reads++;
        return "";
      },
    }),
  );
  assert.equal(reads, 0);
});
test("wire context whitelists native request and result fields without carrying credentials", () => {
  const input = tcp();
  Object.assign(input.definition, {
    headers: { auth: "secret" },
    tls: { key: "secret" },
    handshake: { requiredHeaders: ["secret"] },
    source: "secret",
  });
  Object.assign(input, { headers: { auth: "secret" }, tls: { key: "secret" } });
  const before = wireScriptContext(input, "before");
  assert.deepEqual(before.request, {
    host: "localhost",
    port: 5000,
    duration: 1000,
    completion: "end",
    message: "{{input}}",
  });
  assert.equal(Object.hasOwn(before, "result"), false);
  const native = nativeTCP();
  Object.assign(native, { headers: { auth: "secret" } });
  Object.assign(native.result, { headers: { auth: "secret" } });
  const after = wireScriptContext(input, "after", native);
  assert.equal(after.result.status, "completed");
  assert.equal(after.result.result.body, "reply");
  assert.doesNotMatch(
    JSON.stringify(after),
    /secret|headers|tls|handshake|source/,
  );
  native.result.body = "changed";
  input.message = "changed";
  assert.equal(after.result.result.body, "reply");
  assert.equal(after.request.message, "{{input}}");
});
test("wire context preserves WS binary encoding and only actual optional terminal fields", () => {
  const protocol = {
    definition: {
      type: "websocket",
      url: "ws://localhost/",
      templateMode: "literal",
      sendEmptyMessage: true,
    },
    message: "",
    duration: 1000,
    maxMessages: 5,
  };
  const native = {
    status: "partial",
    durationMs: 1,
    result: {
      messages: [
        {
          data: "/wA=",
          encoding: "base64",
          receivedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
      protocol: "",
      timedOut: false,
      limited: true,
    },
  };
  const context = wireScriptContext(protocol, "after", native);
  assert.deepEqual(context.result, native);
  assert.equal(context.request.sendEmptyMessage, true);
  assert.equal(Object.hasOwn(context.result.result, "closeCode"), false);
  native.result.closeCode = 1000;
  native.result.closeReason = "done";
  assert.equal(
    wireScriptContext(protocol, "after", native).result.result.closeReason,
    "done",
  );
});
test("wire context distinguishes SSE handshake status from bounded native completion", () => {
  const protocol = {
    definition: { type: "sse", url: "http://localhost/" },
    duration: 1000,
    maxEvents: 2,
  };
  assert.equal(wireScriptContext(protocol, "before").request.method, "GET");
  const native = {
    status: "partial",
    durationMs: 1,
    result: {
      status: 200,
      events: [
        {
          event: "message",
          id: "a",
          data: "ok",
          receivedAt: "2026-11-01T00:00:00.000Z",
          retry: 100,
        },
      ],
      limited: true,
    },
  };
  const context = wireScriptContext(protocol, "after", native);
  assert.equal(context.result.status, "partial");
  assert.equal(context.result.result.status, 200);
  assert.deepEqual(context.result.result.events, native.result.events);
  assert.equal(Object.hasOwn(context.result.result, "timedOut"), false);
  protocol.definition = {
    ...protocol.definition,
    method: "POST",
    body: "{{input}}",
    templateMode: "variables",
  };
  assert.equal(wireScriptContext(protocol, "before").request.body, "{{input}}");
});
test("wire context preserves error-only failure and cancellation without synthetic captures", () => {
  for (const type of ["tcp", "websocket", "sse"]) {
    const protocol =
      type === "tcp"
        ? tcp()
        : {
            definition: {
              type,
              url: type === "sse" ? "http://localhost/" : "ws://localhost/",
            },
            duration: 1000,
            ...(type === "sse"
              ? { maxEvents: 2 }
              : { maxMessages: 2, message: "" }),
          };
    for (const status of ["failed", "cancelled"])
      assert.deepEqual(
        wireScriptContext(protocol, "after", {
          status,
          durationMs: 1,
          result: { error: "interrupted" },
        }).result,
        { status, durationMs: 1, result: { error: "interrupted" } },
      );
  }
});
test("wire delimiter view validates exact bytes frame tails and partial evidence", () => {
  const protocol = tcp();
  Object.assign(protocol.definition, {
    completion: "delimiter",
    delimiterHex: "0d0a",
  });
  const native = nativeTCP("a\r\n");
  native.result.framing = {
    matched: true,
    trailingBase64: "AP8=",
    trailingSize: 2,
  };
  assert.deepEqual(
    wireScriptContext(protocol, "after", native).result.result,
    native.result,
  );
  native.result.partial = true;
  assert.throws(() => wireScriptContext(protocol, "after", native), /证据/);
});
test("wire context rejects altered bytes malformed shapes and forbidden native fields", () => {
  const valid = wireScriptContext(tcp(), "after", nativeTCP());
  for (const change of [
    { protocol: "grpc" },
    { phase: "other" },
    { request: { ...valid.request, headers: {} } },
    { result: { ...valid.result, status: 200 } },
    {
      result: { ...valid.result, result: { ...valid.result.result, size: 2 } },
    },
    {
      result: {
        ...valid.result,
        result: { ...valid.result.result, body: "forged" },
      },
    },
    {
      result: {
        ...valid.result,
        result: { ...valid.result.result, base64: "cmVwbHk==" },
      },
    },
    { result: { ...valid.result, result: { error: "not completed" } } },
    { request: { ...valid.request, message: "\ud800" } },
  ])
    assert.throws(() => normalizeWireScriptContext({ ...valid, ...change }));
});
test("wire context independently caps the complete JSON at 2 MiB without truncation", () => {
  assert.equal(WIRE_SCRIPT_CONTEXT_BYTES, 2097152);
  const native = nativeTCP("x".repeat(1048576));
  const unchanged = structuredClone(native);
  assert.throws(() => wireScriptContext(tcp(), "after", native), /2MiB/);
  assert.deepEqual(native, unchanged);
  const context = wireScriptContext(
    tcp(),
    "after",
    nativeTCP("x".repeat(1000)),
  );
  assert.equal(context.result.result.body.length, 1000);
});
test("wire context graph limits reject cycles depth nodes getters and array subclasses before serialization", () => {
  const context = wireScriptContext(tcp(), "before");
  const cycle = {};
  cycle.self = cycle;
  let nested = {};
  for (let i = 0; i < 65; i++) nested = { nested };
  let reads = 0;
  class ArraySubclass extends Array {
    toJSON() {
      reads++;
      return [];
    }
  }
  for (const message of [
    cycle,
    nested,
    { items: Array(20001).fill(1) },
    { items: new ArraySubclass(1) },
    {
      get key() {
        reads++;
        return 1;
      },
    },
    { items: Array(1) },
    JSON.parse('{"__proto__":{}}'),
  ])
    assert.throws(() =>
      normalizeWireScriptContext({
        ...context,
        request: { ...context.request, message },
      }),
    );
  assert.equal(reads, 0);
});
test("wire host and worker binding guard denies HTTP dialect network and task capabilities", () => {
  const input = {
    allowNetwork: false,
    request: { id: "a", name: "b" },
    variables: {},
    scopes: {},
    localVariables: {},
    functions: [],
  };
  assert.doesNotThrow(() => validateWireScriptBinding(input, 0));
  assert.doesNotThrow(() =>
    validateWireScriptBinding({ ...input, responseOriginals: undefined }, 0),
  );
  for (const extra of [
    { allowNetwork: true },
    { wireContext: {} },
    { grpcContext: {} },
    { cookieSession: {} },
    { nativeTasks: [] },
    { databaseQuery: {} },
    { response: {} },
    { request: { scriptDialect: "apipost8" } },
    { request: { scriptURLMode: "sdk" } },
    { request: { url: "http://localhost" } },
    { responseOriginals: {} },
  ])
    assert.throws(() => validateWireScriptBinding({ ...input, ...extra }, 0));
  assert.throws(() => validateWireScriptBinding(input, 1));
});
test("wire script marker admission visits disabled repeat descendants but not application data", () => {
  const script = { version: 1 };
  assert.doesNotThrow(() =>
    validatePlanProtocolScripts([
      {
        type: "repeat",
        enabled: false,
        steps: [{ type: "protocol", protocolScripts: script }],
      },
    ]),
  );
  assert.doesNotThrow(() =>
    validatePlanProtocolScripts([
      { type: "http", request: { body: { protocolScripts: "business" } } },
    ]),
  );
  for (const step of [
    { type: "http", protocolScripts: undefined },
    { type: "grpc", protocolScripts: script },
    { type: "repeat", protocolScripts: script, steps: [] },
    {
      type: "repeat",
      enabled: false,
      steps: [{ type: "http", enabled: false, protocolScripts: script }],
    },
  ])
    assert.throws(() => validatePlanProtocolScripts([step]));
  let reads = 0;
  assert.throws(() =>
    validatePlanProtocolScripts([
      {
        type: "protocol",
        get protocolScripts() {
          reads++;
          return script;
        },
      },
    ]),
  );
  assert.equal(reads, 0);
});
test("HTTP projection rejects executable marker presence without scanning business JSON", () => {
  assert.throws(() =>
    rejectHTTPProtocolScripts({ protocolScripts: undefined }),
  );
  assert.doesNotThrow(() =>
    rejectHTTPProtocolScripts({
      body: { protocolScripts: { version: 1 } },
      examples: [{ protocolScripts: "data" }],
    }),
  );
});
