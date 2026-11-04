import test from "node:test";
import assert from "node:assert/strict";
import { generateGrpcRequestExample } from "../src/grpc-request-example.mjs";
import { compileGrpcSchema } from "../src/grpc-schema.mjs";
import protobuf from "protobufjs";

const proto = `syntax = "proto3";
package demo;
message Node {
  string text = 1;
  int64 signed_value = 2;
  uint64 unsigned_value = 3;
  bytes blob = 4;
  enum Kind { UNKNOWN = 0; READY = 1; }
  Kind kind = 5;
  repeated int32 numbers = 6;
  map<string, Node> children = 7;
  oneof choice { bool enabled = 8; string alternate = 9; }
  Nested nested = 10;
}
message Nested { string value = 1; }
service Echo { rpc Send(Node) returns (Node); }
`;
const input = { proto, service: "demo.Echo", method: "Send" };

test("generates a bounded editable message accepted by the actual gRPC serializer", () => {
  const result = generateGrpcRequestExample(input);
  assert.equal(result.requestType, "demo.Node");
  assert.deepEqual(result.example, {
    text: "",
    signed_value: "0",
    unsigned_value: "0",
    blob: "",
    kind: "UNKNOWN",
    numbers: [0],
    enabled: false,
    nested: { value: "" },
  });
  assert.deepEqual(result.skippedRecursiveFields, ["children"]);
  const method = compileGrpcSchema({ proto }).methods.get("demo.Echo/Send");
  const encoded = method.desc.requestSerialize(result.example);
  const decoded = method.desc.requestDeserialize(encoded);
  assert.equal(decoded.signed_value, "0");
  assert.equal(decoded.nested.value, "");
  assert.deepEqual(generateGrpcRequestExample(input), result);
});

test("handles maps, enums, nested messages and JSON schema discovered by reflection", () => {
  const p = `syntax="proto3"; package ex; message V { bool ok=1; } message Q { map<int64,V> values=1; repeated V entries=2; } service S { rpc M(Q) returns(Q); }`;
  const schema = JSON.parse(JSON.stringify(protobuf.parse(p).root.toJSON()));
  const response = generateGrpcRequestExample({
    schema,
    service: "ex.S",
    method: "M",
  });
  assert.deepEqual(response.example, {
    values: { 0: { ok: false } },
    entries: [{ ok: false }],
  });
  const json = compileGrpcSchema({ schema });
  assert.ok(
    json.methods.get("ex.S/M").desc.requestSerialize(response.example).length,
  );
});

test("rejects missing methods, unexpected sources and required recursive messages", () => {
  assert.throws(
    () => generateGrpcRequestExample({ ...input, method: "Missing" }),
    /方法不存在/,
  );
  assert.throws(
    () => generateGrpcRequestExample({ ...input, extra: true }),
    /来源无效/,
  );
  const required =
    'syntax="proto2"; package x; message Q { required Q next=1; } service S {rpc M(Q) returns(Q);}';
  assert.throws(
    () =>
      generateGrpcRequestExample({
        proto: required,
        service: "x.S",
        method: "M",
      }),
    /递归/,
  );
});

test("MCP generates from a granted saved definition without changing it or contacting a server", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../src/runtime.mjs");
  const { normalizeGrpcDefinition } = await import("../src/grpc.mjs");
  const { createMCP } = await import("../src/mcp.mjs");
  const root = await mkdtemp(join(tmpdir(), "grpc-example-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.init();
  const project = await store.create("Examples");
  const definition = normalizeGrpcDefinition({
    ...input,
    target: "grpc://127.0.0.1:1",
    name: "offline example",
  });
  project.settings.grpcDefinitions = [definition];
  await store.save(project);
  const before = await store.get(project.id);
  const invoke = (projects, definitionId) =>
    createMCP({ store, projects })({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "localapi_generate_grpc_request_example",
        arguments: { projectId: project.id, definitionId },
      },
    });
  const response = await invoke([project.id], definition.id);
  assert.equal(response.result.isError, undefined);
  assert.equal(
    JSON.parse(response.result.content[0].text).requestType,
    "demo.Node",
  );
  assert.deepEqual(await store.get(project.id), before);
  assert.equal((await invoke([], definition.id)).result.isError, true);
  assert.equal((await invoke([project.id], "missing")).result.isError, true);
});

test("cuts an optional ancestor of a required cycle without rejecting a valid message", () => {
  const p =
    'syntax="proto2"; package x; message Q { optional R r=1; } message R { required Q q=1; } service S {rpc M(Q) returns(Q);}';
  const result = generateGrpcRequestExample({
    proto: p,
    service: "x.S",
    method: "M",
  });
  assert.deepEqual(result.example, {});
  assert.deepEqual(result.skippedRecursiveFields, ["r"]);
});

test("bounds all recursive omissions, not only generated values", () => {
  const fields = (type, n) =>
    Array.from({ length: n }, (_, i) => `${type} f${i}=${i + 1};`).join(" ");
  const p = `syntax="proto3"; package x; message Q {${fields("B", 20)}} message B {${fields("C", 20)}} message C {${fields("Q", 100)}} service S {rpc M(Q) returns(Q);}`;
  assert.throws(
    () => generateGrpcRequestExample({ proto: p, service: "x.S", method: "M" }),
    /过大/,
  );
});

test("generated boolean map keys survive a real protobuf wire round trip", () => {
  const p =
    'syntax="proto3"; package x; message Q {map<bool,string> flags=1;} service S {rpc M(Q) returns(Q);}';
  const result = generateGrpcRequestExample({
    proto: p,
    service: "x.S",
    method: "M",
  });
  const method = compileGrpcSchema({ proto: p }).methods.get("x.S/M");
  const decoded = method.desc.requestDeserialize(
    method.desc.requestSerialize(result.example),
  );
  assert.deepEqual(decoded.flags, result.example.flags);
});
