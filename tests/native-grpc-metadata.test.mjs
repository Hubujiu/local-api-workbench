import { nativeGrpcMetadata } from "../src/apipost-grpc-metadata.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import protobuf from "protobufjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import {
  importIntoProject,
  restoreProject,
  snapshotPlan,
  runPlan,
} from "../src/core.mjs";
import {
  executeGrpc,
  normalizeGrpcDefinition,
  grpcTransport,
} from "../src/grpc.mjs";
import { normalizeRequiredMetadata } from "../src/grpc-metadata-requirements.mjs";
import {
  extendedProtocolFixture,
  extendedProto,
} from "./fixtures/apipost-extended-protocols.mjs";
const row = (key, value, is_checked = 1) => ({
  key,
  value,
  is_checked,
  field_type: "string",
  schema: { type: "string" },
});
test(
  "native gRPC metadata declarations require explicit runtime binding across HTTP SDK frozen plans and restore",
  { timeout: 20000 },
  async (t) => {
    const pkg = grpc.loadPackageDefinition(
        loader.fromJSON(protobuf.parse(extendedProto).root.toJSON(), {
          longs: String,
          bytes: String,
          defaults: true,
        }),
      ),
      seen = [],
      server = new grpc.Server();
    const observe = (call) =>
      seen.push({
        authorization: call.metadata.get("authorization"),
        fixture: call.metadata.get("x-fixture"),
        request: call.request,
      });
    server.addService(pkg.sample.Echo.service, {
      Unary(call, cb) {
        observe(call);
        cb(null, call.request);
      },
      Watch(call) {
        observe(call);
        call.write({ ...call.request, text: "one" });
        call.write({ ...call.request, text: "two" });
        call.end();
      },
    });
    const port = await new Promise((r, j) =>
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (e, p) => (e ? j(e) : r(p)),
      ),
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "native-grpc-metadata-"));
    let app = await createApp({ root, port: 0 });
    const client = new Client(
      { name: "native-grpc-metadata", version: "1" },
      { capabilities: {} },
    );
    t.after(async () => {
      await client.close().catch(() => {});
      server.forceShutdown();
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const source = extendedProtocolFixture({ grpc: "127.0.0.1:" + port });
    source.apis = source.apis.filter((n) => n.target_type === "grpc");
    const proto = source.apis[0].protos[0],
      methods = proto.services[0].methods;
    for (const m of methods)
      m.request.metadata.parameter = [
        row("x-fixture", "SOURCE-CUSTOM-SECRET"),
        row("authorization", "SOURCE-AUTH-SECRET"),
        row("x-disabled", "DISABLED-SECRET", 0),
        row(" ", "BLANK-SECRET", -1),
      ];
    proto.proto_content = proto.proto_content.replace(
      "rpc Watch(Input) returns (stream Input);",
      "rpc Watch(Input) returns (stream Input); rpc Collect(stream Input) returns (Input); rpc Unused(Input) returns (Input);",
    );
    methods[1].url = methods[0].url;
    methods[1].request.message[0].raw = methods[0].request.message[0].raw;
    const collect = structuredClone(methods[0]);
    collect.name = "Collect";
    collect.grpc_method_id = "collect";
    collect.request_stream = 1;
    methods.push(collect);
    const unused = structuredClone(methods[0]);
    unused.name = "Unused";
    unused.grpc_method_id = "unused";
    unused.url = "";
    unused.request.message[0].raw = "";
    methods.push(unused);
    const original = JSON.stringify(source),
      p = await app.store.create("Metadata");
    importIntoProject(p, source);
    await app.store.save(p);
    assert.equal(JSON.stringify(source), original);
    assert.doesNotMatch(
      JSON.stringify(p),
      /SOURCE-.*?-SECRET|DISABLED-SECRET|BLANK-SECRET/,
    );
    assert.equal(p.settings.grpcDefinitions.length, 3);
    assert.equal(p.plans.length, 2);
    for (const d of p.settings.grpcDefinitions)
      assert.deepEqual(d.requiredMetadata, ["authorization", "x-fixture"]);
    const plan = p.plans.find(
        (plan) => plan.steps[0].grpc.definition.method === "Unary",
      ),
      metadata = [
        { key: "authorization", value: "Bearer runtime-token" },
        { key: "x-fixture", value: "runtime-value" },
      ];
    const creds = { [plan.steps[0].id]: { metadata } };
    let beforeNetwork = 0;
    await assert.rejects(
      runPlan(
        snapshotPlan({
          steps: [{ request: { url: "http://127.0.0.1:1" } }, ...plan.steps],
        }),
        {},
        async () => {
          beforeNetwork++;
          return {};
        },
        { executeGrpc },
      ),
      /缺少gRPC运行时metadata/,
    );
    assert.equal(beforeNetwork, 0);
    assert.equal(seen.length, 0);
    const restored = restoreProject(p);
    await app.store.save(restored);
    const owner = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
    for (const current of [p, restored])
      for (const definition of current.settings.grpcDefinitions.filter(
        (d) => d.method !== "Collect",
      )) {
        const endpoint = app.url + "/api/projects/" + current.id + "/grpc-run",
          body = {
            definitionId: definition.id,
            messages: [{ text: "real", big: "9007199254740993" }],
          };
        assert.equal(
          (
            await fetch(endpoint, {
              method: "POST",
              headers: owner,
              body: JSON.stringify(body),
            })
          ).status,
          400,
        );
        const response = await fetch(endpoint, {
          method: "POST",
          headers: owner,
          body: JSON.stringify({ ...body, metadata }),
        });
        assert.equal(response.status, 200, await response.text());
      }
    const config = await (
      await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: owner,
        body: JSON.stringify({
          enabled: true,
          projects: [p.id],
          write: true,
          execute: true,
          remember: false,
        }),
      })
    ).json();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    const call = (projectId, binding) =>
      client.callTool({
        name: "localapi_execute_flow",
        arguments: {
          projectId,
          planId: plan.id,
          ...(binding ? { grpcCredentials: binding } : {}),
        },
      });
    assert.equal((await call(restored.id, creds)).isError, true);
    assert.equal((await call(p.id)).isError, true);
    assert.equal(seen.length, 4);
    const result = await call(p.id, creds);
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.equal(JSON.parse(result.content[0].text).status, "passed");
    assert.equal(seen.length, 5);
    for (const wire of seen) {
      assert.deepEqual(wire.authorization, ["Bearer runtime-token"]);
      assert.deepEqual(wire.fixture, ["runtime-value"]);
      assert.equal(wire.request.big, "9007199254740993");
    }
    const saved = await app.store.get(p.id);
    assert.doesNotMatch(
      JSON.stringify(saved),
      /SOURCE-.*?-SECRET|DISABLED-SECRET|BLANK-SECRET|runtime-token|runtime-value/,
    );
    await client.close();
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    app = await createApp({ root, port: 0 });
    assert.deepEqual(
      (await app.store.get(p.id)).settings.grpcDefinitions,
      p.settings.grpcDefinitions,
    );
    assert.equal((await app.store.get(p.id)).runs.length, 1);
  },
);
test("gRPC required metadata preserves old shapes and rejects controlled or ambiguous declarations", () => {
  const d = normalizeGrpcDefinition({
    target: "grpc://localhost:1",
    proto: extendedProto,
    service: "sample.Echo",
    method: "Unary",
  });
  assert.equal(Object.hasOwn(d, "requiredMetadata"), false);
  for (const value of [
    ["Authorization", "authorization"],
    ["user-agent"],
    ["content-type"],
    ["te"],
    ["grpc-timeout"],
    [":authority"],
    Array.from({ length: 101 }, (_, i) => "x-" + i),
  ])
    assert.throws(() => normalizeRequiredMetadata(value));
  assert.deepEqual(normalizeRequiredMetadata(["X-Trace", "authorization"]), [
    "authorization",
    "x-trace",
  ]);
});

test("native binary metadata remains explicit unsupported while canonical runtime preserves Base64 bytes", () => {
  assert.throws(
    () => nativeGrpcMetadata([row("payload-bin", "AP8=")]),
    /二进制metadata/,
  );
  assert.throws(
    () =>
      nativeGrpcMetadata([
        row("Authorization", "a"),
        row("authorization", "b"),
      ]),
    /重复/,
  );
  assert.throws(
    () => nativeGrpcMetadata([row("x-value", "{{template}}")]),
    /模板/,
  );
  const transport = grpcTransport("grpc://localhost:1", {
    requiredMetadata: ["payload-bin"],
    metadata: [{ key: "payload-bin", value: "AP8=" }],
  });
  assert.deepEqual(transport.metadata.get("payload-bin"), [
    Buffer.from([0, 255]),
  ]);
  assert.throws(
    () =>
      grpcTransport("grpc://localhost:1", {
        metadata: [{ key: "payload-bin", value: "not base64" }],
      }),
    /编码/,
  );
});
