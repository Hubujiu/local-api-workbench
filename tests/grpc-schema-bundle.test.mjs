import test from "node:test";
import assert from "node:assert/strict";
import { inspectGrpcSchema, normalizeGrpcDefinition } from "../src/grpc.mjs";
const proto =
  'syntax="proto3"; package bundle; import "types/common.proto"; import "google/protobuf/timestamp.proto"; message Reply { Shared value=1; google.protobuf.Timestamp at=2; } service Echo {rpc Call(Shared) returns(Reply);}';
const files = {
  "types/common.proto":
    'syntax="proto3"; package bundle; message Shared {string text=1;}',
};
test("gRPC schema bundles resolve only provided files and trusted well-known types", () => {
  const result = inspectGrpcSchema({ proto, files });
  assert.equal(result.services[0].name, "bundle.Echo");
  assert.equal(result.services[0].methods[0].requestType, "bundle.Shared");
  const saved = normalizeGrpcDefinition({
    target: "grpc://localhost:50051",
    proto,
    files,
    service: "bundle.Echo",
    method: "Call",
  });
  assert.deepEqual(saved.files, files);
  assert.throws(() => inspectGrpcSchema({ proto, files: {} }), /缺少/);
  for (const key of [
    "../outside.proto",
    "/tmp/outside.proto",
    "https://example.test/a.proto",
    "C:\\a.proto",
  ])
    assert.throws(() =>
      inspectGrpcSchema({
        proto,
        files: { [key]: files["types/common.proto"] },
      }),
    );
  assert.throws(() =>
    inspectGrpcSchema({
      proto: 'syntax="proto3"; import "/tmp/secret.proto";',
    }),
  );
});

test("gRPC virtual import cycles terminate, unused files stay explicit and JSON schemas share validation", () => {
  const root =
    'syntax="proto3"; package cycle; import "a.proto"; service Service {rpc Send(A) returns(A);}';
  const bundle = {
    "a.proto":
      'syntax="proto3"; package cycle; import "b.proto"; message A {B child=1;}',
    "b.proto":
      'syntax="proto3"; package cycle; import "a.proto"; message B {A child=1;}',
    "unused.proto": 'syntax="proto3"; package unused; message Unused {}',
  };
  const inspected = inspectGrpcSchema({ proto: root, files: bundle });
  assert.deepEqual(inspected.files.unused, ["unused.proto"]);
  assert.equal(inspected.files.loaded.filter((x) => x === "a.proto").length, 1);
  const schema = {
    nested: {
      json: {
        nested: {
          Payload: { fields: { text: { type: "string", id: 1 } } },
          Echo: {
            methods: {
              Call: { requestType: "Payload", responseType: "Payload" },
            },
          },
        },
      },
    },
  };
  assert.equal(inspectGrpcSchema({ schema }).services[0].name, "json.Echo");
  assert.throws(() => inspectGrpcSchema({ schema, proto: root }), /混用/);
  assert.throws(
    () =>
      inspectGrpcSchema({
        schema: JSON.parse('{"nested":{"constructor":{}}}'),
      }),
    /保留/,
  );
  assert.throws(() =>
    inspectGrpcSchema({ proto: root, files: bundle, protoName: 0 }),
  );
});

test("gRPC provided file bundle executes against an independent real service and persists", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const grpc = await import("@grpc/grpc-js");
  const loader = await import("@grpc/proto-loader");
  const { executeGrpc } = await import("../src/grpc.mjs");
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(join(tmpdir(), "grpc-bundle-"));
  await mkdir(join(root, "types"));
  await writeFile(join(root, "main.proto"), proto);
  await writeFile(
    join(root, "types/common.proto"),
    files["types/common.proto"],
  );
  const pkg = grpc.loadPackageDefinition(
    loader.loadSync(join(root, "main.proto"), {
      keepCase: true,
      longs: String,
      enums: String,
      bytes: String,
      defaults: true,
    }),
  );
  const rpc = new grpc.Server();
  rpc.addService(pkg.bundle.Echo.service, {
    Call(call, done) {
      done(null, {
        value: call.request,
        at: { seconds: "1700000000", nanos: 7 },
      });
    },
  });
  const { ReflectionService } = await import("@grpc/reflection");
  new ReflectionService(
    loader.loadSync(join(root, "main.proto"), {
      keepCase: true,
      longs: String,
      enums: String,
      bytes: String,
      defaults: true,
    }),
  ).addToServer(rpc);
  const port = await new Promise((resolve, reject) =>
    rpc.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (e, p) => (e ? reject(e) : resolve(p)),
    ),
  );
  const target = "grpc://127.0.0.1:" + port;
  const app = await createApp({ root: join(root, "app"), port: 0 });
  t.after(async () => {
    rpc.forceShutdown();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const result = await executeGrpc({
    target,
    proto,
    files,
    service: "bundle.Echo",
    method: "Call",
    messages: [{ text: "bundle" }],
  });
  assert.equal(result.status.code, 0);
  assert.equal(result.messages[0].value.text, "bundle");
  assert.equal(result.messages[0].at.seconds, "1700000000");
  const { reflectGrpc } = await import("../src/grpc-reflection.mjs");
  const reflected = await reflectGrpc({ target, service: "bundle.Echo" });
  assert.equal(reflected.status.code, 0, JSON.stringify(reflected));
  const viaReflection = await executeGrpc({
    target,
    schema: reflected.schema,
    service: "bundle.Echo",
    method: "Call",
    messages: [{ text: "reflected bundle" }],
  });
  assert.equal(viaReflection.status.code, 0);
  assert.equal(viaReflection.messages[0].at.nanos, 7);
  const project = await app.store.create("Bundle"),
    headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    },
    base = app.url + "/api/projects/" + project.id;
  const created = await fetch(base + "/grpc-definitions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      target,
      proto,
      files,
      service: "bundle.Echo",
      method: "Call",
    }),
  });
  assert.equal(created.status, 200);
  const { definition } = await created.json();
  const executed = await fetch(base + "/grpc-run", {
    method: "POST",
    headers,
    body: JSON.stringify({
      definitionId: definition.id,
      messages: [{ text: "stored bundle" }],
    }),
  });
  assert.equal(executed.status, 200);
  assert.equal((await executed.json()).messages[0].value.text, "stored bundle");
  assert.deepEqual(
    (await app.store.get(project.id)).protocolRuns[0].definition.files,
    files,
  );
});
