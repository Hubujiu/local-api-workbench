import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  executionResultChunk,
  executionResultChunkArguments,
  EXECUTION_RESULT_MAX_BYTES,
  EXECUTION_RESULT_MAX_DEPTH,
  EXECUTION_RESULT_MAX_VALUES,
  EXECUTION_RESULT_CHUNK_MAX_BYTES,
} from "../src/execution-result-chunk.mjs";
import { createMCP } from "../src/mcp.mjs";

const args = { projectId: "project", runId: "record", offsetBytes: 0 };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (record, options = {}) =>
  executionResultChunk(record, { ...args, ...options });

test("chunk preflight matches JSON UTF-8 bytes for escapes, lone surrogates, Unicode, numbers, arrays and own prototype-like keys", () => {
  const controls = Array.from({ length: 32 }, (_, n) =>
    String.fromCharCode(n),
  ).join("");
  const record = JSON.parse(
    '{"id":"record","__proto__":{"constructor":"data"},"toJSON":"data"}',
  );
  record[controls + '"\\é中🧪\ud800\udfff'] = [
    controls,
    'quote" backslash\\ é中🧪\ud800\udfff\ud800x\udfff',
    null,
    true,
    false,
    -0,
    0.0000001,
    1e21,
    Number.MAX_VALUE,
    [],
    {},
  ];
  const expected = Buffer.from(JSON.stringify(record));
  const chunks = [];
  for (let offset = 0; offset < expected.length; offset++) {
    const result = read(record, {
      offsetBytes: offset,
      maxBytes: 1,
      ...(offset ? { expectedSha256: sha(expected) } : {}),
    });
    assert.equal(result.sha256, sha(expected));
    assert.equal(result.totalBytes, expected.length);
    assert.equal(result.chunkBytes, 1);
    assert.equal(result.nextOffsetBytes, offset + 1);
    assert.equal(result.eof, offset + 1 === expected.length);
    chunks.push(Buffer.from(result.data, "base64"));
  }
  assert.deepEqual(Buffer.concat(chunks), expected);
  assert.deepEqual(
    read(record, { maxBytes: expected.length }).data,
    expected.toString("base64"),
  );
  const eof = read(record, {
    offsetBytes: expected.length,
    expectedSha256: sha(expected),
  });
  assert.equal(eof.data, "");
  assert.equal(eof.chunkBytes, 0);
  assert.equal(eof.nextOffsetBytes, expected.length);
  assert.equal(eof.eof, true);
  assert.throws(
    () =>
      read(record, {
        offsetBytes: expected.length + 1,
        expectedSha256: sha(expected),
      }),
    /偏移超出范围/,
  );
  assert.throws(
    () => read(record, { expectedSha256: "0".repeat(64) }),
    /摘要不匹配或已变更/,
  );
});

test("chunk serializer rejects callbacks, traps, unsupported data and cycles without invoking them", () => {
  let invoked = 0;
  const callback = () => {
    invoked++;
    throw Error("PRIVATE-CALLBACK");
  };
  const accessor = Object.defineProperty({}, "secret", {
    enumerable: true,
    get: callback,
  });
  const hiddenAccessor = Object.defineProperty({}, "secret", { get: callback });
  const proxy = new Proxy(
    {},
    { ownKeys: callback, getPrototypeOf: callback, get: callback },
  );
  const inherited = Object.create({ toJSON: callback });
  const cycle = {};
  cycle.self = cycle;
  const arrayAccessor = Object.defineProperty([], "0", {
    enumerable: true,
    get: callback,
  });
  for (const value of [
    accessor,
    hiddenAccessor,
    proxy,
    inherited,
    cycle,
    arrayAccessor,
    { toJSON: callback },
    { value: undefined },
    { value: Symbol("private") },
    { value: 1n },
    { value: Infinity },
    { value: NaN },
    new Date(),
    new Map(),
    Buffer.from("private"),
    { [Symbol("private")]: 1 },
  ])
    assert.throws(() => read({ id: "record", value }), /纯 JSON/);
  assert.throws(() => read({ value: new Array(2) }), /上限|纯 JSON/);
  assert.equal(invoked, 0);
  const shared = { nested: [1, "same"] };
  const nonCyclic = { first: shared, second: shared };
  assert.equal(
    Buffer.from(read(nonCyclic).data, "base64").toString(),
    JSON.stringify(nonCyclic),
  );
  const nullProto = Object.create(null);
  nullProto.value = "plain";
  assert.equal(
    Buffer.from(read(nullProto).data, "base64").toString(),
    '{"value":"plain"}',
  );
});

test("chunk serializer does not call inherited toJSON hooks on plain objects or arrays", () => {
  let invoked = 0;
  const hook = () => {
    invoked++;
    throw Error("PRIVATE-HOOK");
  };
  const before = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  const beforeArray = Object.getOwnPropertyDescriptor(
    Array.prototype,
    "toJSON",
  );
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      value: hook,
      configurable: true,
    });
    Object.defineProperty(Array.prototype, "toJSON", {
      value: hook,
      configurable: true,
    });
    assert.equal(
      Buffer.from(
        read({ id: "record", nested: [{ x: 1 }] }).data,
        "base64",
      ).toString(),
      '{"id":"record","nested":[{"x":1}]}',
    );
    assert.equal(invoked, 0);
  } finally {
    if (before) Object.defineProperty(Object.prototype, "toJSON", before);
    else delete Object.prototype.toJSON;
    if (beforeArray)
      Object.defineProperty(Array.prototype, "toJSON", beforeArray);
    else delete Array.prototype.toJSON;
  }
});

test("chunk preflight enforces escaped serialized bytes, value count and depth before record stringify", () => {
  // About 5.6 MiB of controls would expand past 32 MiB; this is a bounded
  // input guard test, not a process-memory/pressure or streaming-store test.
  const escaped = {
    body: "\u0000".repeat(Math.ceil(EXECUTION_RESULT_MAX_BYTES / 6)),
  };
  const manyValues = Array(EXECUTION_RESULT_MAX_VALUES).fill(null);
  let deep = {};
  for (let i = 0; i <= EXECUTION_RESULT_MAX_DEPTH; i++) deep = { nested: deep };
  const stringify = JSON.stringify;
  let objectStringifies = 0;
  JSON.stringify = (value, ...rest) => {
    if (value && typeof value === "object") objectStringifies++;
    return stringify(value, ...rest);
  };
  try {
    for (const record of [escaped, manyValues, deep])
      assert.throws(() => read(record), /分块读取上限.*项目所有者.*备份/);
    assert.equal(objectStringifies, 0);
  } finally {
    JSON.stringify = stringify;
  }
});

test("chunk arguments require own bounded JSON scalars, safe byte offsets, strict sizes and pinned continuation", () => {
  const invalid = [
    null,
    [],
    Object.create(args),
    { ...args, offsetBytes: undefined },
    { projectId: "project", runId: "record" },
    ...[
      -1,
      1.1,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "0",
      null,
      true,
    ].map((offsetBytes) => ({ ...args, offsetBytes })),
    ...[0, -1, 1.1, 262145, NaN, Infinity, "1", null, undefined].map(
      (maxBytes) => ({ ...args, maxBytes }),
    ),
    ...["", "A".repeat(64), "0".repeat(63), {}, null, undefined].map(
      (expectedSha256) => ({ ...args, expectedSha256 }),
    ),
    { ...args, offsetBytes: 1 },
    { ...args, projectId: "" },
    { ...args, runId: "" },
    { ...args, projectId: "p".repeat(4097) },
    { ...args, runId: "🧪".repeat(1025) },
    { ...args, "PRIVATE-ARGUMENT": "secret" },
  ];
  for (const value of invalid)
    assert.throws(() => executionResultChunkArguments(value), {
      message: "执行结果分块参数无效",
    });
  assert.equal(executionResultChunkArguments(args).maxBytes, 65536);
  assert.equal(
    executionResultChunkArguments({ ...args, runId: "🧪".repeat(1024) }).runId
      .length,
    2048,
  );
  assert.equal(
    executionResultChunkArguments({
      ...args,
      offsetBytes: Number.MAX_SAFE_INTEGER,
      expectedSha256: "0".repeat(64),
    }).offsetBytes,
    Number.MAX_SAFE_INTEGER,
  );
});

test("new tool validates malicious direct arguments before generic enumeration, performs no store reads, and does not echo keys", async () => {
  let calls = 0;
  const fail = () => {
    calls++;
    throw Error("PRIVATE-CALLBACK");
  };
  const dispatch = createMCP({ store: { get: fail }, projects: ["project"] });
  const getter = { ...args };
  Object.defineProperty(getter, "runId", { enumerable: true, get: fail });
  const proxy = new Proxy(
    { ...args },
    { get: fail, ownKeys: fail, getPrototypeOf: fail },
  );
  const hidden = { ...args };
  Object.defineProperty(hidden, "PRIVATE-ARGUMENT", { get: fail });
  for (const input of [
    getter,
    proxy,
    hidden,
    { ...args, "PRIVATE-ARGUMENT": "secret" },
  ]) {
    const reply = await dispatch({
      id: 1,
      method: "tools/call",
      params: { name: "localapi_get_execution_result_chunk", arguments: input },
    });
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.content[0].text, "执行结果分块参数无效");
  }
  assert.equal(calls, 0);
});

test("maximum chunk and bounded identifier metadata fit well below an 8 MiB double-JSON RPC frame", () => {
  const record = { body: "\u0000".repeat(EXECUTION_RESULT_CHUNK_MAX_BYTES) };
  const chunk = read(record, {
    projectId: "\u0000".repeat(4096),
    runId: "\u0000".repeat(4096),
    maxBytes: EXECUTION_RESULT_CHUNK_MAX_BYTES,
  });
  assert.equal(chunk.chunkBytes, EXECUTION_RESULT_CHUNK_MAX_BYTES);
  const frame = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(chunk) }] },
  });
  assert(Buffer.byteLength(frame) < 420000);
  assert(Buffer.byteLength(frame) < 8 * 1024 * 1024);
});

test("chunk-only storage failures are fixed short errors, without changing legacy error behavior", async () => {
  const privateError = "PRIVATE-STORE /tmp/private-project secret payload";
  const dispatch = createMCP({
    store: {
      get: async () => {
        throw Error(privateError);
      },
    },
    projects: ["project"],
  });
  const call = async (name, arguments_) =>
    (
      await dispatch({
        id: 1,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      })
    ).result;
  assert.equal(
    (await call("localapi_get_execution_result_chunk", args)).content[0].text,
    "执行结果分块读取失败",
  );
  assert.equal(
    (
      await call("localapi_get_execution_result", {
        projectId: "project",
        runId: "record",
      })
    ).content[0].text,
    privateError,
  );
});
