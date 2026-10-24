import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { ReflectionService } from "@grpc/reflection";
import { reflectGrpc } from "../src/grpc-reflection.mjs";
import { executeGrpc } from "../src/grpc.mjs";
async function server(t, { alphaOnly = false, denied = false } = {}) {
  const definition = loader.loadSync(
    fileURLToPath(new URL("./fixtures/grpc.proto", import.meta.url)),
    {
      keepCase: true,
      longs: String,
      bytes: String,
      enums: String,
      defaults: true,
    },
  );
  const server = new grpc.Server();
  server.addService(
    grpc.loadPackageDefinition(definition).fixture.Echo.service,
    {
      Unary(call, done) {
        done(null, call.request);
      },
    },
  );
  const reflection = new ReflectionService(definition);
  reflection.addToServer(server);
  const v1 = grpc.loadPackageDefinition(
    loader.loadSync(
      fileURLToPath(
        new URL("../src/vendor/grpc-reflection-v1.proto", import.meta.url),
      ),
    ),
  ).grpc.reflection.v1.ServerReflection.service;
  if (alphaOnly || denied) server.removeService(v1);
  if (denied)
    server.addService(v1, {
      ServerReflectionInfo(call) {
        call.emit("error", {
          code: grpc.status.PERMISSION_DENIED,
          details: "no reflection access",
        });
      },
    });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (e, p) => (e ? reject(e) : resolve(p)),
    ),
  );
  t.after(() => server.forceShutdown());
  return "grpc://127.0.0.1:" + port;
}
test("gRPC reflection lists services then produces an executable descriptor schema", async (t) => {
  const target = await server(t),
    list = await reflectGrpc({ target });
  assert.equal(list.status.code, 0, JSON.stringify(list));
  assert(list.services.some((x) => x.name === "fixture.Echo"));
  const reflected = await reflectGrpc({ target, service: "fixture.Echo" });
  assert.equal(reflected.status.code, 0, JSON.stringify(reflected));
  assert(reflected.files.length > 0);
  assert(reflected.schema);
  const response = await executeGrpc({
    target,
    schema: reflected.schema,
    service: "fixture.Echo",
    method: "Unary",
    messages: [{ text: "reflected", big: "9007199254740993", blob: "AAEC" }],
  });
  assert.equal(response.status.code, 0);
  assert.equal(response.messages[0].big, "9007199254740993");
  assert.equal(response.messages[0].text, "reflected");
});
test("gRPC reflection negotiates only UNIMPLEMENTED, not permission denial", async (t) => {
  const target = await server(t, { alphaOnly: true });
  const reflected = await reflectGrpc({ target, service: "fixture.Echo" });
  assert.equal(reflected.status.code, 0, JSON.stringify(reflected));
  assert.equal(reflected.version, "v1alpha");
  assert.equal(reflected.queries, 2);
  const deniedTarget = await server(t, { denied: true });
  const denied = await reflectGrpc({
    target: deniedTarget,
    service: "fixture.Echo",
  });
  assert.equal(denied.status.code, 7);
  assert.equal(denied.queries, 1);
  assert.equal(denied.version, "v1");
});

test("gRPC reflection HTTP flow saves its schema, executes it and restores the definition", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const { Store } = await import("../src/runtime.mjs");
  const target = await server(t),
    root = await mkdtemp(join(tmpdir(), "grpc-reflection-api-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Reflected service"),
    base = app.url + "/api/projects/" + project.id,
    headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
  const post = (action, data, extra = {}) =>
    fetch(base + "/" + action, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(data),
    });
  assert.equal(
    (
      await post(
        "grpc-reflection",
        { target },
        { Origin: "https://untrusted.example" },
      )
    ).ok,
    false,
  );
  const reflectedResponse = await post("grpc-reflection", {
    target,
    service: "fixture.Echo",
    runId: "reflect-schema",
  });
  assert.equal(reflectedResponse.status, 200);
  const reflected = await reflectedResponse.json();
  assert.equal(reflected.status.code, 0, JSON.stringify(reflected));
  const created = await post("grpc-definitions", {
    target,
    schema: reflected.schema,
    service: "fixture.Echo",
    method: "Unary",
    name: "Discovered",
  });
  assert.equal(created.status, 200);
  const { definition } = await created.json();
  const executed = await post("grpc-run", {
    definitionId: definition.id,
    messages: [{ text: "via reflection", big: "9007199254740993" }],
  });
  assert.equal(executed.status, 200);
  const run = await executed.json();
  assert.equal(run.status.code, 0);
  assert.equal(run.messages[0].text, "via reflection");
  assert.equal(run.recordSaved, true);
  const saved = await new Store(root).get(project.id);
  assert.deepEqual(saved.settings.grpcDefinitions[0].schema, definition.schema);
  assert.equal(saved.protocolRuns[0].definition.id, definition.id);
  const restored = await fetch(app.url + "/api/restore", {
    method: "POST",
    headers,
    body: JSON.stringify({ document: saved }),
  });
  assert.equal(restored.status, 201);
  assert.deepEqual(
    (await restored.json()).settings.grpcDefinitions[0].schema,
    definition.schema,
  );
});

test("gRPC reflection rejects unsafe and excessive descriptors without treating them as remote success", async (t) => {
  const descriptor = (await import("protobufjs/ext/descriptor/index.js"))
    .default;
  const definition = loader.loadSync(
    fileURLToPath(
      new URL("../src/vendor/grpc-reflection-v1.proto", import.meta.url),
    ),
  );
  for (const [payload, expected, stage] of [
    [
      {
        errorResponse: {
          errorCode: 0,
          errorMessage: "not a successful result",
        },
      },
      15,
      "response-validation",
    ],
    [
      {
        fileDescriptorResponse: {
          fileDescriptorProto: [
            descriptor.FileDescriptorProto.encode({
              name: "../escape.proto",
              syntax: "proto3",
            }).finish(),
          ],
        },
      },
      15,
      "response-validation",
    ],
    [
      {
        fileDescriptorResponse: {
          fileDescriptorProto: [
            descriptor.FileDescriptorProto.encode({
              name: "x".repeat(300000),
            }).finish(),
          ],
        },
      },
      8,
      "response-validation",
    ],
    [
      {
        errorResponse: {
          errorCode: 7,
          errorMessage: "descriptor access denied",
        },
      },
      7,
      "reflection-response",
    ],
  ]) {
    const rpc = new grpc.Server();
    let calls = 0;
    rpc.addService(
      grpc.loadPackageDefinition(definition).grpc.reflection.v1.ServerReflection
        .service,
      {
        ServerReflectionInfo(call) {
          call.on("data", (request) => {
            calls++;
            call.write({ originalRequest: request, ...payload });
            call.end();
          });
        },
      },
    );
    const port = await new Promise((resolve, reject) =>
      rpc.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (e, p) => (e ? reject(e) : resolve(p)),
      ),
    );
    t.after(() => rpc.forceShutdown());
    const result = await reflectGrpc({
      target: "grpc://127.0.0.1:" + port,
      service: "fixture.Echo",
    });
    assert.equal(result.status.code, expected, JSON.stringify(result));
    assert.equal(result.complete, false);
    assert.equal(result.failureStage, stage);
    assert.equal(result.lastCallStatus.code, 0);
    assert.equal(calls, 1);
    assert.equal(result.queries, 1);
  }
});

test("gRPC reflection shares one overall deadline and accepts pre-cancellation without a query", async (t) => {
  const descriptor = (await import("protobufjs/ext/descriptor/index.js"))
    .default;
  const pkg = grpc.loadPackageDefinition(
    loader.loadSync(
      fileURLToPath(
        new URL("../src/vendor/grpc-reflection-v1.proto", import.meta.url),
      ),
    ),
  );
  const graph = {
    "root.proto": {
      name: "root.proto",
      package: "fixture",
      syntax: "proto3",
      dependency: ["dep1.proto"],
      messageType: [{ name: "Payload" }],
      service: [
        {
          name: "Echo",
          method: [
            {
              name: "Unary",
              inputType: ".fixture.Payload",
              outputType: ".fixture.Payload",
            },
          ],
        },
      ],
    },
    "dep1.proto": {
      name: "dep1.proto",
      syntax: "proto3",
      dependency: ["dep2.proto"],
    },
    "dep2.proto": { name: "dep2.proto", syntax: "proto3" },
  };
  const rpc = new grpc.Server();
  let calls = 0;
  rpc.addService(pkg.grpc.reflection.v1.ServerReflection.service, {
    ServerReflectionInfo(call) {
      call.on("data", (request) => {
        calls++;
        const timer = setTimeout(() => {
          if (!call.cancelled) {
            call.write({
              originalRequest: request,
              fileDescriptorResponse: {
                fileDescriptorProto: [
                  descriptor.FileDescriptorProto.encode(
                    graph[request.fileByFilename || "root.proto"],
                  ).finish(),
                ],
              },
            });
            call.end();
          }
        }, 90);
        call.on("cancelled", () => clearTimeout(timer));
      });
    },
  });
  const port = await new Promise((resolve, reject) =>
    rpc.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (e, p) => (e ? reject(e) : resolve(p)),
    ),
  );
  t.after(() => rpc.forceShutdown());
  const target = "grpc://127.0.0.1:" + port;
  const controller = new AbortController();
  controller.abort();
  const cancelled = await reflectGrpc(
    { target, service: "fixture.Echo" },
    controller.signal,
  );
  assert.equal(cancelled.status.code, 1);
  assert.equal(cancelled.queries, 0);
  assert.equal(calls, 0);
  const result = await reflectGrpc({
    target,
    service: "fixture.Echo",
    timeoutMs: 150,
  });
  assert.equal(result.status.code, 4, JSON.stringify(result));
  assert.equal(result.complete, false);
  assert(result.queries < 3);
  assert(calls < 3);
});
