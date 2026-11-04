import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { extendedProtocolFixture } from "./fixtures/apipost-extended-protocols.mjs";
const project = () => ({
  requests: [],
  folders: [],
  environments: [],
  servers: [],
  globalVariables: {},
  settings: {},
  plans: [],
});
test("native Socket.IO/gRPC become scoped definitions and explicit immutable message plans", () => {
  const source = extendedProtocolFixture(),
    original = JSON.stringify(source),
    p = project();
  importIntoProject(p, source);
  assert.equal(p.settings.socketioDefinitions.length, 1);
  assert.equal(p.settings.grpcDefinitions.length, 1);
  assert.equal(p.plans.length, 2);
  assert.equal(p.settings.socketioDefinitions[0].transport, "auto");
  assert.deepEqual(p.settings.socketioDefinitions[0].events, []);
  assert.equal(p.plans[0].steps[0].socketio.commands[0].ackTimeoutMs, 3000);
  assert.equal(p.plans[1].steps[0].grpc.messages[0].big, "9007199254740993");
  const before = JSON.stringify(p);
  importIntoProject(p, source);
  assert.equal(JSON.stringify(p), before);
  assert.equal(JSON.stringify(source), original);
  source.apis[1].protos[0].services[0].methods[0].request.message[0].raw =
    '{"text":"changed"}';
  assert.throws(() => importIntoProject(p, source), /冲突/);
  assert.equal(JSON.stringify(p), before);
});
test("unsupported native RPC/Socket.IO options reject without mutating prior project", () => {
  const cases = [
    (d) => (d.apis[0].msg_data = "{{event}}"),
    (d) => (d.apis[0].description = "x".repeat(1024 * 1024)),
    (d) => (d.apis[0].config.reconnect_num = 8),
    (d) => d.apis[0].request.query.parameter.push({ key: "token", value: "x" }),
    (d) => d.apis[0].request.event.parameter.push({ key: "fixture" }),
    (d) => (d.apis[0].message[0].request.mode = "json"),
    (d) => (d.apis[0].message[0].request.raw = "{{variable}}"),
    (d) => (d.apis[0].msg_data = "connect"),
    (d) => d.apis[1].protos[0].include_dirs.push("/etc"),
    (d) => (d.apis[1].protos[0].proto_path = "/secret.proto"),
    (d) => (d.apis[1].protos[0].services[0].methods[0].ssl = 1),
    (d) =>
      d.apis[1].protos[0].services[0].methods[0].request.metadata.parameter.push(
        { key: "grpc-timeout", value: "10S" },
      ),
    (d) => (d.apis[1].protos[0].services[0].methods[0].request_stream = 1),
    (d) =>
      (d.apis[1].protos[0].services[0].methods[0].request.message[0].raw =
        '{"big":9007199254740993}'),
    (d) =>
      (d.apis[1].protos[0].services[0].methods[0].request.message[0].raw =
        '{"text":"{{unsafe}}"}'),
  ];
  for (const change of cases) {
    const source = extendedProtocolFixture(),
      p = project(),
      before = JSON.stringify(p);
    change(source);
    assert.throws(() => importIntoProject(p, source));
    assert.equal(JSON.stringify(p), before);
  }
});

test("native unsupported client-stream messages remain inert instead of creating invented schedules", () => {
  const source = extendedProtocolFixture();
  const proto = source.apis[1].protos[0];
  proto.proto_content = proto.proto_content.replace(
    "rpc Unary(Input)",
    "rpc Unary(stream Input)",
  );
  proto.services[0].methods[0].request_stream = 1;
  const p = project();
  importIntoProject(p, source);
  assert.equal(p.settings.grpcDefinitions.length, 1);
  assert.equal(p.plans.length, 1);
  assert.equal(p.plans[0].steps[0].type, "socketio");
  const notes = p.settings.apipostProtocolSources.find(
    (s) => s.sourceTargetId === "rpc",
  ).notes;
  assert(notes.some((n) => n.includes("不生成发送计划")));
  assert.equal(
    p.settings.apipostProtocolSources.find((s) => s.sourceTargetId === "rpc")
      .source.protos[0].services[0].methods[0].request.message[0].raw,
    source.apis[1].protos[0].services[0].methods[0].request.message[0].raw,
  );
});

test("native authorization metadata migrates only its requirement, not a stored credential", () => {
  const source = extendedProtocolFixture();
  source.apis[1].protos[0].services[0].methods[0].request.metadata.parameter.push(
    { key: "authorization", value: "fixture-source-secret" },
  );
  const original = JSON.stringify(source),
    p = project();
  importIntoProject(p, source);
  assert.deepEqual(p.settings.grpcDefinitions[0].requiredMetadata, [
    "authorization",
  ]);
  assert.doesNotMatch(JSON.stringify(p), /fixture-source-secret/);
  assert.equal(JSON.stringify(source), original);
});

test("ambiguous legacy protocol identity tuples reject atomically in one or successive imports", () => {
  const source = extendedProtocolFixture();
  const a = source.apis[1],
    b = structuredClone(a);
  a.target_id = "a:b";
  b.target_id = "a";
  for (const n of [a, b])
    n.protos[0].services[0].methods = n.protos[0].services[0].methods.slice(
      0,
      1,
    );
  a.protos[0].services[0].methods[0].grpc_method_id = "c";
  b.protos[0].services[0].methods[0].grpc_method_id = "b:c";
  source.apis = [a, b];
  const original = structuredClone(source);
  const empty = project(),
    before = structuredClone(empty);
  assert.throws(() => importIntoProject(empty, source), /身份拼接歧义/);
  assert.deepEqual(empty, before);
  const p = project();
  importIntoProject(p, { ...source, apis: [a] });
  const saved = structuredClone(p);
  importIntoProject(p, { ...source, apis: [a] });
  assert.deepEqual(p, saved, "same source reimport remains idempotent");
  assert.throws(
    () => importIntoProject(p, { ...source, apis: [b] }),
    /身份拼接歧义/,
  );
  assert.deepEqual(p, saved);
  importIntoProject(p, {
    ...source,
    project_id: "another-project",
    apis: [{ ...b, project_id: "another-project" }],
  });
  assert.equal(
    p.settings.grpcDefinitions.length,
    2,
    "different source projects remain isolated",
  );
  assert.deepEqual(source, original);
});
