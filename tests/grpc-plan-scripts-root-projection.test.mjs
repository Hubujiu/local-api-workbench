// Root composition acceptance. Real app, SDK, RPC and storage run only in CI.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { importIntoProject, normalizeRequest } from "../src/core.mjs";
import {
  assertNativeHTTPPlan,
  assertNativeHTTPResult,
} from "../src/native-mcp-http-shape.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { extendedProtocolFixture } from "./fixtures/apipost-extended-protocols.mjs";

const scripts = {
  version: 1,
  before: "pm.variables.set('message','script-private-marker');",
  after:
    "pm.test('real native result',()=>{pm.expect(grpc.result.status.code).to.equal(0);pm.expect(grpc.result.messages[0].text).to.equal('script-private-marker');});",
};
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};

test("grpcScripts own markers never become sparse native HTTP state or disappear in derived native exports", () => {
  const request = normalizeRequest({ url: "http://fixture.invalid/" });
  for (const marker of [
    undefined,
    null,
    {},
    { version: 1, before: "", after: "" },
  ]) {
    const step = { request, grpcScripts: marker };
    const plan = { steps: [step] };
    assert.throws(() => assertNativeHTTPPlan(plan), /仅支持HTTP/);
    for (const run of [
      { grpcScripts: marker },
      { results: [{ status: "passed", grpcScripts: marker }] },
      { snapshot: plan, results: [{ request }] },
    ])
      assert.throws(() => assertNativeHTTPResult(run), /原版兼容结果/);
    assert(Object.hasOwn(step, "grpcScripts"));
  }
  assertNativeHTTPPlan({ steps: [{ request }] });
  assertNativeHTTPResult({ status: "failed", results: [{ status: "failed" }] });

  const project = {
    id: "derived-script-project",
    name: "derived protocols",
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    settings: {},
    globalVariables: {},
    plans: [],
  };
  importIntoProject(project, extendedProtocolFixture());
  const source = structuredClone(project);
  for (const exporter of [exportApipost, exportApipostDirectory]) {
    assert.doesNotThrow(() => exporter(project));
    for (const script of [{ version: 1, before: "", after: "" }, scripts]) {
      const modified = structuredClone(project);
      modified.plans.find(
        (plan) => plan.steps[0].type === "grpc",
      ).steps[0].grpcScripts = script;
      const before = structuredClone(modified);
      assert.throws(() => exporter(modified), /已编辑派生消息计划/);
      assert.deepEqual(modified, before);
    }
  }
  assert.deepEqual(project, source);
});

async function fixture(t, mode) {
  const clients = [],
    counts = { http: 0, grpc: 0 };
  let root, app, peer, rpc;
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    rpc?.forceShutdown();
    for (const server of [app?.server, peer]) {
      server?.closeAllConnections();
      if (server?.listening)
        await new Promise((resolve) => server.close(resolve));
    }
    if (root) await rm(root, { recursive: true, force: true });
  });
  peer = http.createServer((request, response) => {
    counts.http++;
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const protoFile = new URL("./fixtures/grpc.proto", import.meta.url);
  const proto = await readFile(protoFile, "utf8");
  const service = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(protoFile), {
      longs: String,
      bytes: String,
      defaults: true,
    }),
  ).fixture.Echo.service;
  rpc = new grpc.Server();
  rpc.addService(service, {
    Unary(call, done) {
      counts.grpc++;
      done(null, call.request);
    },
  });
  const port = await new Promise((resolve, reject) =>
    rpc.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  root = await mkdtemp(path.join(tmpdir(), "grpc-script-projection-"));
  app = await createApp({ root, port: 0 });
  const owner = async (route, method = "GET", body, status = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const connect = async (projectId) => {
    const client = new Client({ name: "grpc-script-projection", version: "1" });
    clients.push(client);
    if (mode === "http") {
      const config = await owner("/api/mcp/config", "POST", {
        enabled: true,
        projects: [projectId],
        write: true,
        execute: true,
        remember: false,
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
      );
    } else {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            projectId,
            "--write",
            "--execute",
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        }),
      );
    }
    return client;
  };
  return {
    get app() {
      return app;
    },
    owner,
    connect,
    counts,
    async restart() {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app = await createApp({ root, port: 0 });
    },
    request: normalizeRequest({
      id: "http-positive",
      name: "HTTP",
      url: `http://127.0.0.1:${peer.address().port}/positive`,
    }),
    step: {
      id: "scripted-rpc",
      type: "grpc",
      grpcScripts: scripts,
      grpc: {
        definition: {
          id: "rpc",
          name: "frozen RPC",
          target: `grpc://127.0.0.1:${port}`,
          proto,
          service: "fixture.Echo",
          method: "Unary",
        },
        messages: [{ text: "{{message}}" }],
      },
    },
  };
}

for (const mode of ["http", "stdio"])
  test(
    `scripted gRPC ${mode} remains canonical through native refusals, backup and sparse legacy evidence`,
    { timeout: 45000 },
    async (t) => {
      const f = await fixture(t, mode);
      const project = await f.app.store.create("scripted native boundaries");
      project.requests = [f.request];
      await f.owner(`/api/projects/${project.id}`, "PUT", project);
      const httpPlan = await f.owner(
        `/api/projects/${project.id}/plans`,
        "POST",
        {
          name: "positive HTTP",
          environmentId: project.environments[0].id,
          statusPolicy: "strict200",
          steps: [{ id: "http-step", request: f.request }],
        },
      );
      let client = await f.connect(project.id);
      const call = (name, args) => client.callTool({ name, arguments: args });
      const deny = async (name, args) => {
        const response = await call(name, args);
        assert.equal(response.isError, true, JSON.stringify(response));
        assert.match(
          response.content[0].text,
          /原版兼容流程|原版兼容结果|canonical/,
        );
        assert(!response.content[0].text.includes("script-private-marker"));
      };
      const nativeHTTP = decode(
        await call("apipost_execute_flow", {
          project_id: project.id,
          flow_id: httpPlan.id,
        }),
      );
      assert.equal(nativeHTTP.status, "passed");
      assert.equal(nativeHTTP.record_saved, true);
      const httpRun = decode(
        await call("localapi_get_execution_result", {
          projectId: project.id,
          runId: nativeHTTP.run_id,
        }),
      );
      assert.equal(httpRun.results[0].response.status, 200);
      await f.owner(
        `/api/projects/${project.id}/export?format=apipost-directory`,
      );

      // A marker on an otherwise exportable HTTP shape must be checked before
      // snapshot normalization, not silently omitted as an unknown HTTP field.
      const plain = await f.app.store.get(project.id);
      assert(!plain.postmanCollections?.items?.length);
      for (const marker of [
        undefined,
        null,
        {},
        { version: 1, before: "", after: "" },
      ]) {
        const input = structuredClone(plain);
        input.plans[0].steps[0].grpcScripts = marker;
        const unchanged = structuredClone(input);
        assert.throws(
          () => exportApipostDirectory(input),
          /grpcScripts|gRPC|HTTP/,
        );
        assert.deepEqual(input, unchanged);
      }

      const plans = [];
      for (const [name, steps] of [
        ["linear", [f.step]],
        [
          "nested",
          [
            {
              id: "outer",
              type: "repeat",
              count: 2,
              steps: [
                { id: "inner", type: "repeat", count: 2, steps: [f.step] },
              ],
            },
          ],
        ],
        [
          "disabled",
          [
            { id: "http-step", request: f.request },
            { ...f.step, enabled: false },
          ],
        ],
      ]) {
        const plan = decode(
          await call("localapi_create_execution_flow", {
            projectId: project.id,
            plan: { name, environmentId: project.environments[0].id, steps },
          }),
        );
        plans.push(plan);
      }
      const before = await f.app.store.get(project.id);
      const beforeCounts = { ...f.counts };
      await deny("apipost_list_execution_flows", { project_id: project.id });
      for (const plan of plans) {
        for (const name of [
          "apipost_get_execution_flow",
          "apipost_execute_flow",
        ])
          await deny(name, { project_id: project.id, flow_id: plan.id });
        await deny("apipost_update_execution_flow", {
          project_id: project.id,
          flow_id: plan.id,
          name: "must-not-rewrite",
        });
        await deny("apipost_update_execution_flow", {
          project_id: project.id,
          flow_id: plan.id,
          steps: [{ target_id: f.request.id }],
        });
        assert.deepEqual(
          decode(
            await call("localapi_get_execution_flow", {
              projectId: project.id,
              planId: plan.id,
            }),
          ),
          plan,
        );
      }
      for (const format of ["apipost", "apipost-directory"]) {
        const ownerError = await f.owner(
          `/api/projects/${project.id}/export?format=${format}`,
          "GET",
          undefined,
          400,
        );
        assert(!JSON.stringify(ownerError).includes("Postman collection"));
        const result = await call("localapi_export_project", {
          projectId: project.id,
          format,
        });
        assert.equal(result.isError, true, JSON.stringify(result));
        assert(!result.content[0].text.includes("Postman collection"));
      }
      assert.deepEqual(f.counts, beforeCounts);
      assert.deepEqual(await f.app.store.get(project.id), before);

      // Obtain truthful native evidence once, then prove every projection/read
      // remains non-executing. This is not a second entrypoint execution matrix.
      const run = decode(
        await call("localapi_execute_flow", {
          projectId: project.id,
          planId: plans[0].id,
        }),
      );
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.equal(run.recordSaved, true);
      assert.equal(
        run.results[0].grpcResult.messages[0].text,
        "script-private-marker",
      );
      assert.deepEqual(run.snapshot.steps[0].grpcScripts, scripts);
      assert.equal(run.results[0].response, undefined);
      await deny("apipost_get_execution_result", {
        project_id: project.id,
        run_id: run.id,
      });
      await deny("apipost_list_execution_runs", {
        project_id: project.id,
        flow_id: plans[0].id,
      });

      const legacy = structuredClone(httpRun);
      legacy.id = "legacy-grpc-script-marker";
      delete legacy.snapshot;
      legacy.results[0].grpcScripts = { version: 1, before: "", after: "" };
      await f.app.store.append(project.id, "runs", legacy);
      await deny("apipost_get_execution_result", {
        project_id: project.id,
        run_id: legacy.id,
      });
      assert.deepEqual(
        decode(
          await call("localapi_get_execution_result", {
            projectId: project.id,
            runId: legacy.id,
          }),
        ).results,
        legacy.results,
      );
      const calls = { ...f.counts };
      const backup = await f.owner(`/api/projects/${project.id}/export`);
      const restored = await f.owner(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      assert.deepEqual(restored.plans, backup.plans);
      assert.deepEqual(restored.runs, backup.runs);
      await client.close();
      await f.restart();
      client = await f.connect(restored.id);
      const persisted = await f.owner(`/api/projects/${restored.id}`);
      assert.deepEqual(persisted.plans, backup.plans);
      assert.deepEqual(persisted.runs, backup.runs);
      await deny("apipost_execute_flow", {
        project_id: restored.id,
        flow_id: plans[0].id,
      });
      await deny("apipost_get_execution_result", {
        project_id: restored.id,
        run_id: legacy.id,
      });
      const canonical = decode(
        await call("localapi_get_execution_result", {
          projectId: restored.id,
          runId: run.id,
        }),
      );
      assert.deepEqual(canonical.snapshot, run.snapshot);
      assert.equal(canonical.planHash, run.planHash);
      assert.deepEqual(f.counts, calls);
      assert.deepEqual(calls, { http: 1, grpc: 1 });
    },
  );
