import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Server as SocketServer } from "socket.io";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
const decode = (value) => {
  assert.notEqual(value.isError, true, JSON.stringify(value));
  return JSON.parse(value.content[0].text);
};
async function fixture(t, transport) {
  const counts = {
      http: 0,
      tcpConnections: 0,
      tcp: 0,
      grpc: 0,
      socketConnections: 0,
      socket: 0,
    },
    errors = [],
    sockets = new Set(),
    clients = [];
  let peer, tcp, rpc, io, root, app;
  // Own listeners even if a later fixture setup step rejects.
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    if (app?.server.listening) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    rpc?.forceShutdown();
    for (const socket of sockets) socket.destroy();
    if (tcp?.listening) await new Promise((resolve) => tcp.close(resolve));
    if (io) await new Promise((resolve) => io.close(resolve));
    if (peer?.listening) {
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
    }
    if (root) await rm(root, { recursive: true, force: true });
  });
  peer = http.createServer((req, res) => {
    counts.http++;
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  tcp = net.createServer((socket) => {
    counts.tcpConnections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => errors.push(error.message));
    const chunks = [];
    let total = 0,
      replied = false;
    socket.on("data", (bytes) => {
      chunks.push(bytes);
      total += bytes.length;
      if (replied || total > Buffer.byteLength("wire-echo")) {
        errors.push("unexpected TCP fixture payload");
        socket.destroy();
        return;
      }
      if (total === Buffer.byteLength("wire-echo")) {
        replied = true;
        counts.tcp++;
        socket.end(Buffer.concat(chunks));
      }
    });
  });
  await new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const protoFile = new URL("./fixtures/grpc.proto", import.meta.url),
    proto = await readFile(protoFile, "utf8");
  rpc = new grpc.Server();
  const pkg = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(protoFile), {
      longs: String,
      bytes: String,
      defaults: true,
    }),
  );
  rpc.addService(pkg.fixture.Echo.service, {
    Unary(call, done) {
      counts.grpc++;
      done(null, call.request);
    },
  });
  const grpcPort = await new Promise((resolve, reject) =>
    rpc.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  const socketHttp = http.createServer();
  io = new SocketServer(socketHttp);
  io.on("connection", (socket) => {
    counts.socketConnections++;
    socket.on("echo", (value, ack) => {
      counts.socket++;
      ack(value);
    });
  });
  await new Promise((resolve) => socketHttp.listen(0, "127.0.0.1", resolve));
  root = await mkdtemp(join(tmpdir(), "native-http-projection-"));
  app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  async function owner(route, method = "GET", data, status = 200) {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  async function connect(projectId, write, execute) {
    const client = new Client(
      { name: "native-http-projection", version: "1" },
      { capabilities: {} },
    );
    clients.push(client);
    if (transport === "http") {
      const config = await owner("/api/mcp/config", "POST", {
        enabled: true,
        projects: [projectId],
        write,
        execute,
        remember: false,
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
      );
    } else
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            projectId,
            ...(write ? ["--write"] : []),
            ...(execute ? ["--execute"] : []),
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        }),
      );
    return client;
  }
  return {
    get app() {
      return app;
    },
    owner,
    connect,
    counts,
    errors,
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    request: normalizeRequest({
      id: "api",
      name: "HTTP positive",
      url: "http://127.0.0.1:" + peer.address().port + "/http",
    }),
    protocol: {
      id: "tcp-leaf",
      type: "protocol",
      protocol: {
        definition: { type: "tcp", url: "127.0.0.1", port: tcp.address().port },
        message: "wire-echo",
      },
    },
    grpc: {
      id: "grpc-leaf",
      type: "grpc",
      grpc: {
        definition: {
          id: "rpc",
          name: "RPC",
          proto,
          target: "grpc://127.0.0.1:" + grpcPort,
          service: "fixture.Echo",
          method: "Unary",
        },
        messages: [{ text: "grpc-echo" }],
      },
    },
    socketio: {
      id: "socket-leaf",
      type: "socketio",
      socketio: {
        definition: {
          id: "socket",
          name: "Socket",
          url: "http://127.0.0.1:" + socketHttp.address().port,
        },
        timeoutMs: 2000,
        commands: [
          {
            type: "emit",
            event: "echo",
            args: [{ text: "socket-echo" }],
            ackTimeoutMs: 1000,
          },
        ],
      },
    },
  };
}
for (const transport of ["http", "stdio"])
  test(
    `native HTTP projection ${transport} rejects whole unsupported flows before I/O while canonical protocols and restored HTTP remain usable`,
    { timeout: 60000 },
    async (t) => {
      const f = await fixture(t, transport),
        project = await f.app.store.create("Allowed projection"),
        foreign = await f.app.store.create("Foreign private-sentinel");
      project.requests = [f.request];
      await f.owner("/api/projects/" + project.id, "PUT", project);
      const plans = {};
      for (const [name, steps] of [
        ["http", [{ request: f.request }]],
        ["protocol", [f.protocol]],
        ["grpc", [f.grpc]],
        ["socketio", [f.socketio]],
        ["mixed", [{ request: f.request }, f.protocol]],
        ["disabled", [{ request: f.request }, { ...f.grpc, enabled: false }]],
      ])
        plans[name] = await f.owner(
          "/api/projects/" + project.id + "/plans",
          "POST",
          { name: "private-sentinel-" + name, steps },
        );
      const original = await f.app.store.get(project.id),
        foreignBefore = await f.app.store.get(foreign.id),
        zero = { ...f.counts };
      const call = (client, name, args) =>
        client.callTool({ name, arguments: args });
      const denied = async (client, name, args, shape = true) => {
        const result = await call(client, name, args);
        assert.equal(result.isError, true, JSON.stringify(result));
        if (shape)
          assert.match(
            result.content[0].text,
            /原版兼容流程仅支持HTTP|原版兼容结果不支持/,
          );
        assert(!result.content[0].text.includes("private-sentinel"));
      };
      let client = await f.connect(project.id, false, false);
      await denied(
        client,
        "apipost_execute_flow",
        { project_id: project.id, flow_id: plans.http.id },
        false,
      );
      await denied(
        client,
        "apipost_update_execution_flow",
        { project_id: project.id, flow_id: plans.http.id, name: "changed" },
        false,
      );
      await client.close();
      client = await f.connect(project.id, true, false);
      await denied(
        client,
        "apipost_execute_flow",
        { project_id: project.id, flow_id: plans.http.id },
        false,
      );
      await client.close();
      client = await f.connect(project.id, true, true);
      await denied(client, "apipost_list_execution_flows", {
        project_id: project.id,
      });
      for (const name of [
        "protocol",
        "grpc",
        "socketio",
        "mixed",
        "disabled",
      ]) {
        const plan = plans[name];
        await denied(client, "apipost_get_execution_flow", {
          project_id: project.id,
          flow_id: plan.id,
        });
        await denied(client, "apipost_update_execution_flow", {
          project_id: project.id,
          flow_id: plan.id,
          name: "private-sentinel-new",
        });
        await denied(client, "apipost_update_execution_flow", {
          project_id: project.id,
          flow_id: plan.id,
          steps: [{ target_id: "api" }],
        });
        await denied(client, "apipost_execute_flow", {
          project_id: project.id,
          flow_id: plan.id,
        });
        const canonical = decode(
          await call(client, "localapi_get_execution_flow", {
            projectId: project.id,
            planId: plan.id,
          }),
        );
        assert.deepEqual(canonical.steps, plan.steps);
      }
      await denied(
        client,
        "apipost_get_execution_flow",
        { project_id: foreign.id, flow_id: plans.protocol.id },
        false,
      );
      assert.deepEqual(f.counts, zero);
      assert.deepEqual(await f.app.store.get(project.id), original);
      assert.equal(
        decode(
          await call(client, "apipost_list_execution_runs", {
            project_id: project.id,
          }),
        ).total,
        0,
      );
      const runs = {};
      for (const name of ["protocol", "grpc", "socketio"]) {
        const run = decode(
          await call(client, "localapi_execute_flow", {
            projectId: project.id,
            planId: plans[name].id,
          }),
        );
        assert.equal(run.status, "passed", JSON.stringify(run));
        assert.equal(run.recordSaved, true);
        runs[name] = run;
        assert.equal(run.results[0].type, name);
        const canonical = decode(
          await call(client, "localapi_get_execution_result", {
            projectId: project.id,
            runId: run.id,
          }),
        );
        assert.deepEqual(canonical.results, run.results);
        await denied(client, "apipost_get_execution_result", {
          project_id: project.id,
          run_id: run.id,
        });
        await denied(client, "apipost_list_execution_runs", {
          project_id: project.id,
          flow_id: plans[name].id,
        });
      }
      assert.equal(
        runs.protocol.results[0].protocolResult.result.body,
        "wire-echo",
      );
      assert.equal(
        runs.grpc.results[0].grpcResult.messages[0].text,
        "grpc-echo",
      );
      assert.equal(runs.socketio.results[0].socketioResult.status, "passed");
      assert.deepEqual(f.counts, {
        http: 0,
        tcpConnections: 1,
        tcp: 1,
        grpc: 1,
        socketConnections: 1,
        socket: 1,
      });
      for (const name of ["disabled", "mixed"]) {
        const run = decode(
          await call(client, "localapi_execute_flow", {
            projectId: project.id,
            planId: plans[name].id,
          }),
        );
        assert.equal(run.status, "passed", JSON.stringify(run));
        assert.equal(run.recordSaved, true);
        assert.equal(run.results.length, name === "disabled" ? 1 : 2);
        assert.equal(run.results[0].response.status, 200);
        if (name === "mixed")
          assert.equal(run.results[1].protocolResult.result.body, "wire-echo");
        await denied(client, "apipost_get_execution_result", {
          project_id: project.id,
          run_id: run.id,
        });
        await denied(client, "apipost_list_execution_runs", {
          project_id: project.id,
          flow_id: plans[name].id,
        });
      }
      assert.deepEqual(f.counts, {
        http: 2,
        tcpConnections: 2,
        tcp: 2,
        grpc: 1,
        socketConnections: 1,
        socket: 1,
      });
      const legacy = structuredClone(runs.protocol);
      legacy.id = "legacy-without-snapshot";
      delete legacy.snapshot;
      delete legacy.results[0].type;
      delete legacy.results[0].protocol;
      // Synthetic old-format copy of actual protocol evidence; configuration PUT
      // correctly preserves history. Use the activity path, then real restore.
      await f.app.store.append(project.id, "runs", legacy);
      await denied(client, "apipost_get_execution_result", {
        project_id: project.id,
        run_id: legacy.id,
      });
      assert.equal(
        decode(
          await call(client, "localapi_get_execution_result", {
            projectId: project.id,
            runId: legacy.id,
          }),
        ).results[0].protocolResult.result.body,
        "wire-echo",
      );
      const created = decode(
        await call(client, "apipost_create_execution_flow", {
          project_id: project.id,
          name: "Native HTTP",
          steps: [{ target_id: "api" }],
        }),
      );
      decode(
        await call(client, "apipost_update_execution_flow", {
          project_id: project.id,
          flow_id: created.flow_id,
          name: "Native HTTP updated",
        }),
      );
      const httpRun = decode(
        await call(client, "apipost_execute_flow", {
          project_id: project.id,
          flow_id: created.flow_id,
        }),
      );
      assert.equal(httpRun.status, "passed");
      assert.equal(httpRun.record_saved, true);
      const apiRun = decode(
        await call(client, "apipost_execute_api", {
          project_id: project.id,
          target_id: "api",
        }),
      );
      assert.equal(apiRun.status, "passed");
      assert.equal(apiRun.record_saved, true);
      const httpHistory = decode(
        await call(client, "apipost_list_execution_runs", {
          project_id: project.id,
          flow_id: created.flow_id,
        }),
      );
      assert.equal(httpHistory.total, 1);
      assert.equal(httpHistory.records[0].run_id, httpRun.run_id);
      const apiHistory = decode(
        await call(client, "apipost_list_execution_runs", {
          project_id: project.id,
          scope: "api",
        }),
      );
      assert.equal(apiHistory.total, 1);
      assert.equal(apiHistory.records[0].run_id, apiRun.run_id);
      assert.equal(
        decode(
          await call(client, "apipost_get_execution_result", {
            project_id: project.id,
            run_id: httpRun.run_id,
          }),
        ).run.results[0].response.status,
        200,
      );
      const countsBeforeRestore = { ...f.counts },
        sourceBefore = await f.app.store.get(project.id),
        backup = await f.owner("/api/projects/" + project.id + "/export"),
        restored = await f.owner(
          "/api/restore",
          "POST",
          { document: backup },
          201,
        );
      await denied(
        client,
        "apipost_get_execution_flow",
        { project_id: restored.id, flow_id: plans.protocol.id },
        false,
      );
      await client.close();
      await f.restart();
      client = await f.connect(restored.id, true, true);
      const persisted = await f.app.store.get(restored.id);
      assert.deepEqual(persisted.plans, sourceBefore.plans);
      for (const name of [
        "protocol",
        "grpc",
        "socketio",
        "mixed",
        "disabled",
      ]) {
        await denied(client, "apipost_execute_flow", {
          project_id: restored.id,
          flow_id: plans[name].id,
        });
        await denied(client, "apipost_update_execution_flow", {
          project_id: restored.id,
          flow_id: plans[name].id,
          name: "changed",
        });
      }
      await denied(client, "apipost_list_execution_runs", {
        project_id: restored.id,
      });
      await denied(client, "apipost_get_execution_result", {
        project_id: restored.id,
        run_id: legacy.id,
      });
      assert.deepEqual(f.counts, countsBeforeRestore);
      assert.deepEqual(await f.app.store.get(restored.id), persisted);
      const replay = decode(
        await call(client, "apipost_execute_flow", {
          project_id: restored.id,
          flow_id: created.flow_id,
        }),
      );
      assert.equal(replay.status, "passed");
      assert.equal(replay.record_saved, true);
      assert.equal(f.counts.http, countsBeforeRestore.http + 1);
      assert.deepEqual(await f.app.store.get(project.id), sourceBefore);
      assert.deepEqual(await f.app.store.get(foreign.id), foreignBefore);
      assert.deepEqual(f.errors, []);
    },
  );
