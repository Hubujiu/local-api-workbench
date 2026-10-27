import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import protobuf from "protobufjs";
import { Server as SocketIOServer } from "socket.io";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import {
  extendedProtocolFixture,
  extendedProto,
} from "./fixtures/apipost-extended-protocols.mjs";
const cwd = fileURLToPath(new URL("..", import.meta.url));
async function cli(root, projectId, planId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/run-plan.mjs", "--project", projectId, "--plan", planId],
      {
        cwd,
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        assert.equal(code, 0, err);
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}
for (const transport of ["http", "stdio"])
  for (const format of ["apipost", "apipost-directory"])
    test(
      `extended messages ${transport}/${format}: owner two-generation export, official SDK, frozen CLI and restarted backup`,
      { timeout: 30000 },
      async (t) => {
        const root = await mkdtemp(path.join(tmpdir(), "extended-export-")),
          seen = [];
        const server = http.createServer(),
          io = new SocketIOServer(server, { maxHttpBufferSize: 65536 });
        io.on("connection", (s) =>
          s.on("fixture", (data, ack) => {
            seen.push({ type: "io", data });
            ack({ ok: true, data });
          }),
        );
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
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
        const port = await new Promise((resolve, reject) =>
          rpc.bindAsync(
            "127.0.0.1:0",
            grpc.ServerCredentials.createInsecure(),
            (e, p) => (e ? reject(e) : resolve(p)),
          ),
        );
        let app = await createApp({ root, port: 0 });
        const clients = [];
        t.after(async () => {
          await Promise.all(clients.map((c) => c.close().catch(() => {})));
          app.server.closeAllConnections();
          await new Promise((r) => app.server.close(r));
          rpc.forceShutdown();
          await new Promise((r) => io.close(r));
          await rm(root, { recursive: true, force: true });
        });
        const call = async (route, body, status = 200) => {
          const r = await fetch(app.url + route, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const v = await r.json();
          assert.equal(r.status, status, JSON.stringify(v));
          return v;
        };
        const source = extendedProtocolFixture({
          socketio: `http://127.0.0.1:${server.address().port}`,
          grpc: `127.0.0.1:${port}`,
        });
        const watch = source.apis[1].protos[0].services[0].methods[1];
        watch.url = `127.0.0.1:${port}`;
        watch.request.message[0].raw =
          source.apis[1].protos[0].services[0].methods[0].request.message[0].raw;
        source.apis[0].request.header.parameter = [
          { key: "Accept-Language", value: "zh-CN", is_checked: 1 },
        ];
        const original = structuredClone(source),
          p = await app.store.create("source"),
          other = await app.store.create("other");
        const untouched = await app.store.get(other.id);
        await call(`/api/projects/${p.id}/import`, { document: source });
        const before = await app.store.get(p.id);
        let current = p;
        for (let generation = 0; generation < 2; generation++) {
          const document = await call(
            `/api/projects/${current.id}/export?format=${format}`,
          );
          current = await app.store.create("generation" + generation);
          await call(`/api/projects/${current.id}/import`, { document });
        }
        assert.equal(
          seen.length,
          0,
          "conversion never executes protocol messages",
        );
        const saved = await app.store.get(current.id);
        assert.equal(saved.plans.length, 3);
        const c = new Client(
          { name: "extended-export", version: "1" },
          { capabilities: {} },
        );
        clients.push(c);
        if (transport === "http") {
          const cfg = await call("/api/mcp/config", {
            enabled: true,
            projects: [current.id],
            write: true,
            execute: true,
            remember: false,
          });
          await c.connect(
            new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
              requestInit: {
                headers: { Authorization: "Bearer " + cfg.token },
              },
            }),
          );
        } else
          await c.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [
                path.join(cwd, "src/mcp.mjs"),
                "--project",
                current.id,
                "--write",
                "--execute",
              ],
              env: { LOCAL_API_DATA: root },
              stderr: "pipe",
            }),
          );
        const runIds = [];
        function verify(run, plan) {
          assert.equal(run.status, "passed", JSON.stringify(run.results));
          assert.equal(run.recordSaved, true);
          runIds.push(run.id);
          assert.deepEqual(run.snapshot.steps, plan.steps);
          if (plan.steps[0].type === "grpc") {
            const messages = run.results[0].grpcResult.messages;
            assert.equal(messages[0].big, "9007199254740993");
            assert.equal(messages[0].blob, "/wA=");
            if (plan.steps[0].grpc.definition.method === "Watch")
              assert.deepEqual(
                messages.map((m) => m.text),
                ["first", "second"],
              );
          }
        }
        for (const plan of saved.plans)
          verify(
            await call(`/api/projects/${current.id}/run`, { planId: plan.id }),
            plan,
          );
        for (const plan of saved.plans) {
          const result = await c.callTool({
            name: "localapi_run_plan",
            arguments: { projectId: current.id, planId: plan.id },
          });
          assert.notEqual(result.isError, true, result.content?.[0]?.text);
          verify(JSON.parse(result.content[0].text), plan);
        }
        assert.equal(
          (
            await c.callTool({
              name: "localapi_run_plan",
              arguments: { projectId: other.id, planId: saved.plans[0].id },
            })
          ).isError,
          true,
        );
        await c.close();
        const changed = await app.store.get(current.id);
        changed.settings.grpcDefinitions[0].target = "grpc://127.0.0.1:1";
        changed.settings.socketioDefinitions[0].url = "http://127.0.0.1:1/";
        await app.store.save(changed);
        const calls = seen.length;
        for (const f of ["apipost", "apipost-directory"])
          await call(
            `/api/projects/${current.id}/export?format=${f}`,
            undefined,
            400,
          );
        assert.equal(seen.length, calls);
        for (const plan of saved.plans)
          verify(await cli(root, current.id, plan.id), plan);
        const backup = await call(`/api/projects/${current.id}/export`),
          restored = await call("/api/restore", { document: backup }, 201);
        app.server.closeAllConnections();
        await new Promise((r) => app.server.close(r));
        app = await createApp({ root, port: 0 });
        assert.equal(seen.length, 9, "restart/restore never replay");
        for (const plan of saved.plans)
          verify(await cli(root, restored.id, plan.id), plan);
        assert.equal(seen.length, 12);
        const history = (await new Store(root).get(restored.id)).runs;
        assert.equal(history.length, 12);
        assert.deepEqual(history.map((run) => run.id).sort(), runIds.sort());
        assert.deepEqual(await new Store(root).get(other.id), untouched);
        assert.deepEqual(await new Store(root).get(p.id), before);
        assert.deepEqual(source, original);
        for (const entry of seen)
          if (entry.type === "grpc")
            assert.equal(entry.data.big, "9007199254740993");
          else assert.equal(entry.data, "native-io");
      },
    );
