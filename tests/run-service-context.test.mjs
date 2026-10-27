import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "run-service-"));
  const seen = [],
    peers = [];
  let onFirst = async () => {},
    token = "fresh-1";
  for (const host of ["original", "changed"]) {
    const peer = http.createServer(async (req, res) => {
      seen.push({ host, url: req.url, token: req.headers["x-token"] });
      try {
        if (req.url === "/first") await onFirst();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token }));
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
    peer.listen(0, "127.0.0.1");
    await once(peer, "listening");
    peers.push(peer);
  }
  const urls = peers.map((peer) => `http://127.0.0.1:${peer.address().port}`);
  let app = await createApp({ root, port: 0 });
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await closeApp();
    for (const peer of peers) {
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  const owner = async (route, method = "POST", body, status = 200) => {
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
  const project = await app.store.create("service context"),
    other = await app.store.create("isolated");
  const environmentId = project.environments[0].id;
  project.servers = [{ id: "svc", name: "loopback" }];
  project.environments[0].serverUrls = { svc: urls[0] };
  project.environments[0].variables.token = "initial";
  project.settings.folderServices = { Orders: "svc" };
  project.requests = [
    { id: "probe", name: "probe", folder: "Orders", url: "/probe" },
  ];
  await app.store.save(project);
  const otherBefore = await app.store.get(other.id);
  const route = (action, id = project.id) => `/api/projects/${id}/${action}`;
  const plan = await owner(route("plans"), "POST", {
    name: "two ordinary HTTP steps",
    environmentId,
    steps: [
      {
        request: {
          name: "first",
          folder: "Orders",
          url: "/first",
          extract: [
            {
              name: "token",
              source: "json",
              path: "$.token",
              scope: "environment",
            },
          ],
        },
      },
      {
        request: {
          name: "second",
          folder: "Orders",
          url: "/second",
          headers: [{ key: "x-token", value: "{{token}}", enabled: true }],
        },
      },
    ],
  });
  const environment = (operation, args = {}) =>
    owner(route("environments"), "POST", {
      operation,
      arguments: { environmentId, ...args },
    });
  return {
    root,
    urls,
    seen,
    project,
    other,
    otherBefore,
    environmentId,
    plan,
    owner,
    route,
    environment,
    get app() {
      return app;
    },
    onFirst(fn) {
      onFirst = fn;
    },
    token(value) {
      token = value;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
  };
}

async function executor(t, f, transport) {
  if (transport === "owner")
    return (projectId = f.project.id) =>
      f.owner(f.route("run", projectId), "POST", { planId: f.plan.id });
  if (transport === "cli")
    return async (projectId = f.project.id) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
          "--project",
          projectId,
          "--plan",
          f.plan.id,
        ],
        {
          env: { ...process.env, LOCAL_API_DATA: f.root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const output = [],
        errors = [];
      child.stdout.on("data", (part) => output.push(part));
      child.stderr.on("data", (part) => errors.push(part));
      const timer = setTimeout(() => child.kill(), 15000);
      const [code] = await once(child, "close");
      clearTimeout(timer);
      assert.equal(code, 0, Buffer.concat(errors).toString());
      return JSON.parse(Buffer.concat(output).toString());
    };
  const client = new Client(
    { name: "service-context", version: "1" },
    { capabilities: {} },
  );
  t.after(() => client.close().catch(() => {}));
  if (transport === "http") {
    const config = await f.owner("/api/mcp/config", "POST", {
      enabled: true,
      projects: [f.project.id],
      write: true,
      execute: true,
      remember: false,
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
  } else {
    const wire = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
        "--project",
        f.project.id,
        "--write",
        "--execute",
      ],
      env: { LOCAL_API_DATA: f.root },
      stderr: "pipe",
    });
    wire.stderr.resume();
    await client.connect(wire);
  }
  const run = async (projectId = f.project.id) => {
    const result = await client.callTool({
      name: "localapi_run_plan",
      arguments: { projectId, planId: f.plan.id },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  run.single = async () => {
    const result = await client.callTool({
      name: "localapi_execute_api",
      arguments: { projectId: f.project.id, apiId: "probe" },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  return run;
}

for (const transport of ["owner", "http", "stdio", "cli"])
  test(
    `${transport}: service configuration is stable inside a run and current between runs while extraction evolves`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t),
        run = await executor(t, f, transport);
      f.onFirst(async () => {
        await f.environment("update_environment_server", {
          serverId: "svc",
          url: f.urls[1],
        });
        const probe = await f.owner(f.route("execute"), "POST", {
          request: f.project.requests[0],
        });
        assert.equal(probe.status, 200);
      });
      const first = await run();
      assert.equal(first.status, "passed");
      assert.equal(first.recordSaved, true);
      assert.deepEqual(f.seen, [
        { host: "original", url: "/first", token: undefined },
        { host: "changed", url: "/probe", token: undefined },
        { host: "original", url: "/second", token: "fresh-1" },
      ]);
      assert.deepEqual(first.snapshot.steps, f.plan.steps);
      f.onFirst(async () => {});
      f.token("fresh-2");
      const second = await run();
      assert.equal(second.status, "passed");
      assert.equal(second.recordSaved, true);
      assert.deepEqual(f.seen.slice(3), [
        { host: "changed", url: "/first", token: undefined },
        { host: "changed", url: "/second", token: "fresh-2" },
      ]);
      const disk = await new Store(f.root).get(f.project.id);
      assert.equal(disk.environments[0].variables.token, "fresh-2");
      assert.equal(disk.environments[0].serverUrls.svc, f.urls[1]);
      assert.equal(disk.runs.length, 2);
      assert.deepEqual(disk.plans[0].steps, f.plan.steps);
      assert.deepEqual(await new Store(f.root).get(f.other.id), f.otherBefore);
      if (run.single) {
        const single = await run.single();
        assert.equal(single.status, "passed");
        assert.deepEqual(f.seen.at(-1), {
          host: "changed",
          url: "/probe",
          token: undefined,
        });
        const count = f.seen.length;
        await assert.rejects(run(f.other.id));
        assert.equal(
          f.seen.length,
          count,
          "MCP project grants must still block unauthorized execution",
        );
      }
      const backup = await f.owner(f.route("export"), "GET");
      const restored = await f.owner(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      await f.restart();
      const restoredRun = await f.owner(f.route("run", restored.id), "POST", {
        planId: f.plan.id,
      });
      assert.equal(restoredRun.status, "passed");
      assert.deepEqual(f.seen.slice(-2), [
        { host: "changed", url: "/first", token: undefined },
        { host: "changed", url: "/second", token: "fresh-2" },
      ]);
    },
  );

for (const remove of [false, true])
  test(
    `owner: ${remove ? "deleted service" : "cleared service address"} applies to the next run, not an active run`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      f.onFirst(() =>
        f.environment(
          remove ? "delete_environment_server" : "update_environment_server",
          { serverId: "svc", ...(remove ? {} : { url: "" }) },
        ),
      );
      const first = await f.owner(f.route("run"), "POST", {
        planId: f.plan.id,
      });
      assert.equal(first.status, "passed");
      assert.deepEqual(f.seen, [
        { host: "original", url: "/first", token: undefined },
        { host: "original", url: "/second", token: "fresh-1" },
      ]);
      f.onFirst(async () => {});
      const second = await f.owner(f.route("run"), "POST", {
        planId: f.plan.id,
      });
      assert.equal(second.status, "failed");
      assert.equal(second.recordSaved, true);
      assert.equal(second.results.length, 2);
      for (const result of second.results) {
        assert.equal(result.status, "failed");
        assert.match(
          result.error,
          remove ? /服务不存在/ : /当前环境未配置服务地址/,
        );
        assert.equal(result.response, undefined);
      }
      assert.equal(
        f.seen.length,
        2,
        "missing config must not use an old resolver or send any request",
      );
      const disk = await new Store(f.root).get(f.project.id);
      assert.equal(disk.environments[0].variables.token, "fresh-1");
      assert.equal(
        disk.environments[0].serverUrls.svc,
        remove ? undefined : "",
      );
    },
  );

test(
  "owner: cancellation does not send later leaves or commit extraction",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    f.onFirst(async () => {
      await f.environment("update_environment_server", {
        serverId: "svc",
        url: f.urls[1],
      });
      await f.owner("/api/cancel", "POST", { id: "cancel-service" });
    });
    const run = await f.owner(f.route("run"), "POST", {
      planId: f.plan.id,
      runId: "cancel-service",
    });
    assert.equal(run.status, "cancelled");
    assert.equal(run.recordSaved, true);
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].host, "original");
    const disk = await new Store(f.root).get(f.project.id);
    assert.equal(disk.environments[0].variables.token, "initial");
    assert.equal(disk.environments[0].serverUrls.svc, f.urls[1]);
  },
);

test(
  "owner: conflicting extraction preserves real response and does not retry HTTP or overwrite owner state",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    f.onFirst(async () => {
      await f.environment("update_environment_server", {
        serverId: "svc",
        url: f.urls[1],
      });
      await f.environment("upsert_environment_variable", {
        key: "token",
        value: "owner-value",
      });
    });
    const run = await f.owner(f.route("run"), "POST", { planId: f.plan.id });
    assert.equal(run.status, "failed");
    assert.equal(run.recordSaved, true);
    assert.equal(run.results[0].response.status, 200);
    assert.match(run.results[0].error, /变量冲突/);
    assert.equal(JSON.parse(run.results[0].response.body).token, "fresh-1");
    assert.deepEqual(f.seen, [
      { host: "original", url: "/first", token: undefined },
      { host: "original", url: "/second", token: "initial" },
    ]);
    const disk = await new Store(f.root).get(f.project.id);
    assert.equal(disk.environments[0].variables.token, "owner-value");
    assert.equal(disk.environments[0].serverUrls.svc, f.urls[1]);
    assert.deepEqual(disk.runs[0].results, run.results);
  },
);

test(
  "concurrent projects keep independent service contexts and extracted values for identical service IDs",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const other = await f.app.store.get(f.other.id);
    other.servers = [{ id: "svc", name: "independent" }];
    other.environments[0].serverUrls = { svc: f.urls[0] };
    other.environments[0].variables.token = "other-token";
    await f.app.store.save(other);
    f.onFirst(async () => {
      await f.environment("update_environment_server", {
        serverId: "svc",
        url: f.urls[1],
      });
      const probe = await f.owner(f.route("execute", other.id), "POST", {
        request: {
          name: "other",
          url: "/other",
          serviceId: "svc",
          headers: [{ key: "x-token", value: "{{token}}", enabled: true }],
        },
      });
      assert.equal(probe.status, 200);
    });
    const run = await f.owner(f.route("run"), "POST", { planId: f.plan.id });
    assert.equal(run.status, "passed");
    assert.deepEqual(f.seen, [
      { host: "original", url: "/first", token: undefined },
      { host: "original", url: "/other", token: "other-token" },
      { host: "original", url: "/second", token: "fresh-1" },
    ]);
    const disk = await new Store(f.root).get(other.id);
    assert.deepEqual(disk.environments, other.environments);
    assert.deepEqual(disk.servers, other.servers);
  },
);
