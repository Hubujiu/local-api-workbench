import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";
import { runPlanCLI } from "./helpers/run-plan-cli.mjs";

async function projectFileBytes(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of Object.entries(
        await projectFileBytes(filename),
      ))
        result[entry.name + "/" + name] = bytes;
    } else result[entry.name] = (await readFile(filename)).toString("base64");
  }
  return result;
}

for (const transport of ["http", "stdio"])
  test(
    `native protocol extraction batches stay atomic through ${transport} SDK, CLI, frozen plans and restore`,
    { timeout: 45000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "native-extract-entry-"));
      const seen = [];
      const upstream = http.createServer(async (req, res) => {
        for await (const chunk of req) void chunk;
        if (req.url.startsWith("/events")) {
          seen.push({ type: "sse" });
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end("data: fresh-global\n\n");
        } else {
          seen.push({ type: "http", url: req.url });
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ url: req.url }));
        }
      });
      const io = new SocketIOServer(upstream);
      io.on("connection", (socket) =>
        socket.on("fixture", (data, ack) => {
          seen.push({ type: "socketio", data });
          ack({ text: "fresh-environment" });
        }),
      );
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const url = `http://127.0.0.1:${upstream.address().port}`;
      const pkg = grpc.loadPackageDefinition(
        loader.fromJSON(protobuf.parse(extendedProto).root.toJSON(), {
          longs: String,
          bytes: String,
          defaults: true,
        }),
      );
      const rpc = new grpc.Server();
      rpc.addService(pkg.sample.Echo.service, {
        Unary(call, done) {
          seen.push({ type: "grpc", text: call.request.text });
          done(null, call.request);
        },
      });
      const port = await new Promise((resolve, reject) =>
        rpc.bindAsync(
          "127.0.0.1:0",
          grpc.ServerCredentials.createInsecure(),
          (error, p) => (error ? reject(error) : resolve(p)),
        ),
      );
      let app = await createApp({ root, port: 0 }),
        client;
      const closeApp = async () => {
        app.server.closeAllConnections();
        await app.close();
      };
      t.after(async () => {
        await client?.close().catch(() => {});
        await closeApp();
        rpc.forceShutdown();
        await new Promise((r) => io.close(r));
        upstream.closeAllConnections();
        await rm(root, { recursive: true, force: true });
      });
      const owner = async (route, method = "GET", body, status = 200) => {
        const response = await fetch(app.url + route, {
          method,
          headers: {
            "content-type": "application/json",
            "x-local-token": app.token,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const result = await response.json();
        assert.equal(response.status, status, JSON.stringify(result));
        return result;
      };
      const project = await app.store.create("atomic target"),
        other = await app.store.create("isolated");
      const otherBefore = await app.store.get(other.id);
      client = new Client(
        { name: "native-extraction", version: "1" },
        { capabilities: {} },
      );
      if (transport === "http") {
        const config = await owner("/api/mcp/config", "POST", {
          enabled: true,
          projects: [project.id],
          write: true,
          execute: true,
          remember: false,
        });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          }),
        );
      } else {
        const wire = new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            project.id,
            "--write",
            "--execute",
          ],
          env: { LOCAL_API_DATA: root },
          stderr: "pipe",
        });
        wire.stderr.resume();
        await client.connect(wire);
      }
      const raw = (name, args) =>
        client.callTool({ name: "localapi_" + name, arguments: args });
      const call = async (name, args) => {
        const response = await raw(name, args);
        assert.notEqual(response.isError, true, JSON.stringify(response));
        return JSON.parse(response.content[0].text);
      };
      const native = extendedProtocolFixture({
        socketio: url,
        grpc: `127.0.0.1:${port}`,
      });
      await call("import_project", {
        projectId: project.id,
        format: "apipost",
        document: native,
      });
      const sse = nativeProtocolFixture({ sse: url + "/events" });
      sse.apis = sse.apis.filter((node) => node.target_type === "sse");
      await call("import_project", {
        projectId: project.id,
        format: "apipost",
        document: sse,
      });
      assert.deepEqual(
        seen,
        [],
        "definition imports do not execute transports",
      );
      const saved = await app.store.get(project.id);
      const environmentId =
        saved.currentEnvironmentId || saved.environments[0].id;
      const environment = saved.environments.find(
        (e) => e.id === environmentId,
      );
      environment.variables.envToken = "initial-environment";
      saved.globalVariables.globalToken = "initial-global";
      await app.store.save(saved);
      const grpcStep = structuredClone(
        saved.plans.find(
          (p) =>
            p.steps[0].type === "grpc" &&
            p.steps[0].grpc.definition.method === "Unary",
        ).steps[0],
      );
      const socketStep = structuredClone(
        saved.plans.find((p) => p.steps[0].type === "socketio").steps[0],
      );
      const extraction = (name, scope, path) => ({ name, scope, path });
      const initial = structuredClone(grpcStep);
      initial.grpc.messages = [{ text: "committed" }];
      initial.extract = [
        extraction("runtimeToken", "runtime", "$[0].text"),
        extraction("envToken", "environment", "$[0].text"),
        extraction("globalToken", "global", "$[0].text"),
      ];
      grpcStep.grpc.messages = [{ text: "fresh-runtime" }];
      grpcStep.extract = [
        extraction("runtimeToken", "runtime", "$[0].text"),
        extraction("missingGrpc", "runtime", "$[0].missing"),
      ];
      socketStep.extract = [
        extraction("envToken", "environment", "$[0].args[0].text"),
        extraction("missingSocket", "environment", "$[0].missing"),
      ];
      const protocolStep = {
        type: "protocol",
        protocol: {
          definitionId: saved.protocols.find((d) => d.type === "sse").id,
          duration: 1000,
        },
        extract: [
          extraction("globalToken", "global", "$.events[0].data"),
          extraction("missingSse", "global", "$.missing"),
        ],
      };
      const echo = () => ({
        request: {
          method: "GET",
          url: url + "/{{runtimeToken}}/{{envToken}}/{{globalToken}}",
        },
      });
      const input = {
        projectId: project.id,
        plan: {
          name: "atomic extraction seven steps",
          environmentId,
          steps: [
            initial,
            grpcStep,
            echo(),
            socketStep,
            echo(),
            protocolStep,
            echo(),
          ],
        },
      };
      // Cloning a frozen step also clones its plan-step identity, distinct from
      // grpc.definition.id. Reject the duplicate, then give the new step its own
      // identity without changing the shared template or protocol/scopes checks.
      assert.equal(initial.id, grpcStep.id);
      assert.equal(initial.grpc.definition.id, grpcStep.grpc.definition.id);
      const beforeDuplicate = await app.store.get(project.id);
      const bytesBeforeDuplicate = await projectFileBytes(
        app.store.directory(project.id),
      );
      const duplicate = await raw("create_execution_flow", input);
      assert.equal(duplicate.isError, true);
      assert.match(duplicate.content[0].text, /步骤ID无效或重复/);
      assert.deepEqual(await app.store.get(project.id), beforeDuplicate);
      assert.deepEqual(
        await projectFileBytes(app.store.directory(project.id)),
        bytesBeforeDuplicate,
      );
      assert.deepEqual(
        seen,
        [],
        "duplicate identities cannot start any transport",
      );
      delete initial.id;
      const plan = await call("create_execution_flow", input);
      assert.equal(plan.steps.length, 7);
      assert.equal(plan.steps[1].id, grpcStep.id);
      assert.notEqual(plan.steps[0].id, grpcStep.id);
      assert.equal(
        plan.steps[0].grpc.definition.id,
        grpcStep.grpc.definition.id,
      );
      assert.equal(
        plan.steps[1].grpc.definition.id,
        grpcStep.grpc.definition.id,
      );
      assert.equal(new Set(plan.steps.map((step) => step.id)).size, 7);
      assert(
        plan.steps[5].protocol.definition,
        "protocol reference freezes the imported template",
      );
      const live = await app.store.get(project.id);
      for (const definition of live.protocols)
        definition.url = "http://127.0.0.1:1/changed";
      for (const definition of live.settings.grpcDefinitions || [])
        definition.target = "grpc://127.0.0.1:1";
      for (const definition of live.settings.socketioDefinitions || [])
        definition.url = "http://127.0.0.1:1";
      await app.store.save(live);
      const checkRun = (run) => {
        assert.equal(run.status, "failed", JSON.stringify(run));
        assert.equal(run.recordSaved, true);
        assert.equal(typeof run.attemptedRecordId, "string");
        assert(run.attemptedRecordId.length > 0);
        assert.equal(run.recordId, run.id);
        assert.equal(run.attemptedRecordId, run.id);
        assert.equal(run.environmentId, environmentId);
        assert.deepEqual(run.snapshot.steps, plan.steps);
        assert.equal(run.results.length, 7);
        assert.deepEqual(
          run.results.map((r) => r.status),
          [
            "passed",
            "failed",
            "passed",
            "failed",
            "passed",
            "failed",
            "passed",
          ],
        );
        assert.deepEqual(run.results[0].extracted, {
          runtimeToken: "committed",
          envToken: "committed",
          globalToken: "committed",
        });
        for (const i of [1, 3, 5]) {
          assert.deepEqual(run.results[i].extracted, {});
          assert.match(run.results[i].error, /提取|路径|missing/);
        }
        assert.equal(run.results[1].grpcResult.status.code, 0);
        assert.equal(
          run.results[1].grpcResult.messages[0].text,
          "fresh-runtime",
        );
        assert.equal(
          run.results[3].socketioResult.results[0].args[0].text,
          "fresh-environment",
        );
        assert.equal(
          run.results[5].protocolResult.result.events[0].data,
          "fresh-global",
        );
      };
      const checkDisk = async (id, run, count) => {
        const disk = await new Store(root).get(id);
        assert.equal(
          disk.environments.find((e) => e.id === environmentId).variables
            .envToken,
          "committed",
        );
        assert.equal(disk.globalVariables.globalToken, "committed");
        assert.equal(disk.globalVariables.missingSse, undefined);
        assert.equal(
          disk.environments.find((e) => e.id === environmentId).variables
            .missingSocket,
          undefined,
        );
        const record = disk.runs.find((r) => r.id === run.id);
        assert(record);
        assert.equal(record.id, run.attemptedRecordId);
        assert.deepEqual(record.results, run.results);
        assert.equal(disk.runs.length, count);
      };
      const checkWire = (runs) => {
        assert.equal(seen.length, runs * 7);
        assert.deepEqual(
          seen.filter((v) => v.type === "http").map((v) => v.url),
          Array(runs * 3).fill("/committed/committed/committed"),
        );
      };
      const first = await call("run_plan", {
        projectId: project.id,
        planId: plan.id,
      });
      checkRun(first);
      checkWire(1);
      await checkDisk(project.id, first, 1);
      const read = await call("get_run", {
        projectId: project.id,
        runId: first.id,
      });
      assert.equal(read.id, first.attemptedRecordId);
      assert.equal(
        (await raw("run_plan", { projectId: other.id, planId: plan.id }))
          .isError,
        true,
      );
      assert.equal(
        (await raw("get_run", { projectId: other.id, runId: first.id }))
          .isError,
        true,
      );
      checkWire(1);
      await client.close();
      client = null;
      const cli = await runPlanCLI(root, project.id, plan.id, environmentId);
      assert.equal(cli.code, 1, cli.stderr);
      const second = JSON.parse(cli.stdout);
      checkRun(second);
      checkWire(2);
      await checkDisk(project.id, second, 2);
      assert.notEqual(second.attemptedRecordId, first.attemptedRecordId);
      const backup = await owner(`/api/projects/${project.id}/export`);
      const restored = await owner(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      assert.deepEqual(restored.plans, backup.plans);
      assert.deepEqual(restored.runs, backup.runs);
      await closeApp();
      app = await createApp({ root, port: 0 });
      const again = await runPlanCLI(root, restored.id, plan.id, environmentId);
      assert.equal(again.code, 1, again.stderr);
      const third = JSON.parse(again.stdout);
      checkRun(third);
      checkWire(3);
      await checkDisk(restored.id, third, 3);
      assert.notEqual(third.attemptedRecordId, second.attemptedRecordId);
      assert.deepEqual(await app.store.get(other.id), otherBefore);
      assert.equal((await new Store(root).get(project.id)).runs.length, 2);
    },
  );
