import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import protobuf from "protobufjs";
import { Server as SocketIOServer } from "socket.io";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { createMCP } from "../src/mcp.mjs";
import {
  extendedProtocolFixture,
  extendedProto,
} from "./fixtures/apipost-extended-protocols.mjs";
test("native Socket.IO Ack and precise gRPC import run over HTTP/MCP with restore and project isolation", async (t) => {
  const seen = [],
    server = http.createServer(),
    io = new SocketIOServer(server, { maxHttpBufferSize: 65536 });
  io.on("connection", (s) =>
    s.on("fixture", (data, ack) => {
      seen.push({ type: "socketio", data });
      ack({ ok: true, data });
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const pkg = grpc.loadPackageDefinition(
      loader.fromJSON(protobuf.parse(extendedProto).root.toJSON(), {
        longs: String,
        bytes: String,
        defaults: true,
      }),
    ),
    rpc = new grpc.Server();
  rpc.addService(pkg.sample.Echo.service, {
    Unary(call, cb) {
      seen.push({ type: "grpc", data: call.request });
      cb(null, call.request);
    },
    Watch(call) {
      seen.push({ type: "grpc", data: call.request });
      call.write({ ...call.request, text: "first" });
      call.write({ ...call.request, text: "second" });
      call.end();
    },
  });
  const rpcPort = await new Promise((resolve, reject) =>
    rpc.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (e, p) => (e ? reject(e) : resolve(p)),
    ),
  );
  const root = await mkdtemp(path.join(tmpdir(), "native-extended-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    rpc.forceShutdown();
    await new Promise((r) => io.close(r));
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const source = extendedProtocolFixture({
    socketio: `http://127.0.0.1:${server.address().port}`,
    grpc: `127.0.0.1:${rpcPort}`,
  });
  const watcher = source.apis[1].protos[0].services[0].methods[1];
  watcher.url = `127.0.0.1:${rpcPort}`;
  watcher.request.message[0].raw =
    source.apis[1].protos[0].services[0].methods[0].request.message[0].raw;
  const original = JSON.stringify(source),
    p = await app.store.create("native extended"),
    other = await app.store.create("other");
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const post = async (id, action, body) => {
    const r = await fetch(app.url + "/api/projects/" + id + "/" + action, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = await r.json();
    assert.equal(r.status, 200, JSON.stringify(data));
    return data;
  };
  const imported = await post(p.id, "import", { document: source });
  assert.equal(imported.plans.length, 3);
  assert.equal(seen.length, 0);
  const saved = await new Store(root).get(p.id);
  assert.deepEqual(saved.plans, imported.plans);
  const restore = await fetch(app.url + "/api/restore", {
    method: "POST",
    headers,
    body: JSON.stringify({ document: saved }),
  });
  assert.equal(restore.status, 201);
  const restored = await restore.json();
  for (const current of [saved, restored])
    for (const plan of current.plans) {
      const run = await post(current.id, "run", { planId: plan.id });
      assert.equal(run.status, "passed", JSON.stringify(run.results));
      if (plan.steps[0].type === "grpc") {
        assert.equal(
          run.results[0].grpcResult.messages[0].big,
          "9007199254740993",
        );
        assert.equal(run.results[0].grpcResult.messages[0].blob, "/wA=");
        if (plan.steps[0].grpc.definition.method === "Watch")
          assert.deepEqual(
            run.results[0].grpcResult.messages.map((m) => m.text),
            ["first", "second"],
          );
      }
    }
  assert.equal(seen.length, 6);
  const wrong = await fetch(app.url + "/api/projects/" + other.id + "/run", {
    method: "POST",
    headers,
    body: JSON.stringify({ planId: saved.plans[0].id }),
  });
  assert.equal(wrong.status, 400);
  assert.equal(seen.length, 6);
  const runner = createMCP({
    store: app.store,
    projects: [p.id],
    write: true,
    execute: true,
  });
  for (const plan of saved.plans) {
    const response = await runner({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "localapi_run_plan",
        arguments: { projectId: p.id, planId: plan.id },
      },
    });
    assert.equal(response.result.isError, undefined, JSON.stringify(response));
    const run = JSON.parse(response.result.content[0].text);
    assert.equal(run.status, "passed", JSON.stringify(run));
  }
  assert.equal(seen.length, 9);
  for (const x of seen) {
    if (x.type === "grpc") assert.equal(x.data.big, "9007199254740993");
    else assert.equal(x.data, "native-io");
  }
  assert.equal((await new Store(root).get(p.id)).runs.length, 6);
  assert.equal(JSON.stringify(source), original);
});
