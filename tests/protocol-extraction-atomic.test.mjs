import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Server } from "socket.io";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { executeGrpc } from "../src/grpc.mjs";
import { executeSocketIOFlow } from "../src/socketio-plan.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
const fresh = "fresh-loopback-token";
const protoURL = new URL("./fixtures/grpc.proto", import.meta.url);
const proto = await readFile(protoURL, "utf8");
async function fixture(t) {
  const seen = [],
    calls = { grpc: 0, socketio: 0, protocol: 0 },
    sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  const io = new Server(server);
  io.on("connection", (socket) => {
    socket.on("issue", (_request, ack) => {
      calls.socketio++;
      ack({ text: fresh, count: 7 });
    });
    socket.on("fail", () => {
      calls.socketio++;
    });
  });
  const tcp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", () => {
      calls.protocol++;
      socket.end(fresh);
    });
  });
  const rpc = new grpc.Server();
  const pkg = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(protoURL), {
      longs: String,
      bytes: String,
      defaults: true,
    }),
  );
  rpc.addService(pkg.fixture.Echo.service, {
    Unary(_call, done) {
      calls.grpc++;
      done(null, { text: fresh, count: 7 });
    },
    Fail(_call, done) {
      calls.grpc++;
      done({ code: 7, details: "fixture denied" });
    },
  });
  const grpcPort = await new Promise((resolve, reject) =>
    rpc.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (e, port) => (e ? reject(e) : resolve(port)),
    ),
  );
  await Promise.all([
    new Promise((r) => server.listen(0, "127.0.0.1", r)),
    new Promise((r) => tcp.listen(0, "127.0.0.1", r)),
  ]);
  t.after(async () => {
    rpc.forceShutdown();
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    await Promise.all([
      new Promise((r) => io.close(r)),
      new Promise((r) => tcp.close(r)),
    ]);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const steps = {
    grpc: {
      type: "grpc",
      grpc: {
        definition: {
          target: `grpc://127.0.0.1:${grpcPort}`,
          proto,
          service: "fixture.Echo",
          method: "Unary",
        },
        messages: [{}],
      },
    },
    socketio: {
      type: "socketio",
      socketio: {
        definition: { url },
        timeoutMs: 1000,
        commands: [
          { type: "emit", event: "issue", args: [{}], ackTimeoutMs: 100 },
        ],
      },
    },
    protocol: {
      type: "protocol",
      protocol: {
        definition: { type: "tcp", url: "127.0.0.1", port: tcp.address().port },
        message: "issue",
        duration: 1000,
      },
    },
  };
  return {
    seen,
    calls,
    steps,
    http: {
      request: {
        url: url + "/use",
        headers: ["token", "envToken", "globalToken"].map((name) => ({
          key: "x-" + name.toLowerCase(),
          value: "{{" + name + "}}",
          enabled: true,
        })),
      },
    },
  };
}
const executors = {
  executeGrpc,
  executeSocketIO: executeSocketIOFlow,
  executeProtocol: executeWireFlow,
};
const valuePath = {
  grpc: "$[0].text",
  socketio: "$[0].args[0].text",
  protocol: "$.body",
};
const secondPath = {
  grpc: "$[0].count",
  socketio: "$[0].args[0].count",
  protocol: "$.size",
};
const scopes = (hidden = []) => ({
  globals: { globalToken: "old-global" },
  environment: { envToken: "old-env" },
  runtime: { token: "old-runtime" },
  hidden,
});
for (const family of ["grpc", "socketio", "protocol"])
  test(`${family} extraction batch cannot leak a partial token into later real HTTP`, async (t) => {
    const f = await fixture(t);
    for (const hidden of [[], ["token"]]) {
      const initial = scopes(hidden),
        untouched = structuredClone(initial);
      let commits = 0;
      const plan = snapshotPlan({
        steps: [
          {
            ...f.steps[family],
            extract: [
              { name: "token", path: valuePath[family], scope: "runtime" },
              {
                name: "envToken",
                path: valuePath[family],
                scope: "environment",
              },
              { name: "globalToken", path: valuePath[family], scope: "global" },
              { name: "missing", path: "$.missing", scope: "runtime" },
            ],
          },
          hidden.length
            ? {
                request: {
                  ...f.http.request,
                  headers: f.http.request.headers.filter(
                    (row) => row.key !== "x-token",
                  ),
                },
              }
            : f.http,
        ],
      });
      const run = await runPlan(plan, {}, executeRequest, {
        ...executors,
        variableScopes: initial,
        onScopeChanges: async () => {
          commits++;
        },
      });
      assert.equal(run.status, "failed");
      assert.equal(
        run.results.length,
        2,
        "ordinary protocol failure still continues",
      );
      assert.equal(run.results[1].status, "passed");
      assert.match(run.results[0].error, /无法提取/);
      const sent = f.seen.at(-1);
      assert.equal(sent["x-token"], hidden.length ? undefined : "old-runtime");
      assert.equal(sent["x-envtoken"], "old-env");
      assert.equal(sent["x-globaltoken"], "old-global");
      assert.deepEqual(run.results[0].extracted, {});
      if (hidden.length)
        assert.equal(Object.hasOwn(run.variables, "token"), false);
      assert.equal(commits, 0);
      assert.deepEqual(initial, untouched);
    }
    assert.equal(f.calls[family], 2);
    assert.equal(f.seen.length, 2);
  });
