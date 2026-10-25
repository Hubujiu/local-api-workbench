import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { normalizeRequest, restoreProject } from "../src/core.mjs";
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};

test(
  "official SDK native-input workflow closes discovery/documents/create/update/frozen execution/evidence/restore with isolated grants",
  { timeout: 20000 },
  async (t) => {
    const seen = [],
      server = http.createServer(async (req, res) => {
        let body = "";
        for await (const c of req) body += c;
        seen.push({ path: req.url, body });
        res.setHeader("content-type", "application/json");
        res.end('{"value":"after-value"}');
      });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(path.join(os.tmpdir(), "native-mcp-flow-")),
      app = await createApp({ root, port: 0 }),
      clients = [];
    t.after(async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    let p = await app.store.create("Allowed"),
      denied = await app.store.create("Denied");
    const env = p.environments[0].id;
    p.requests = [
      normalizeRequest({
        id: "api",
        name: "Echo",
        folder: "Parent/Child",
        method: "POST",
        url: `http://127.0.0.1:${server.address().port}/echo`,
        bodyType: "json",
        body: '{"original":1,"keep":2}',
        query: [
          {
            key: "q",
            value: "saved",
            dynamic: { source: "fixed", value: "dynamic-default" },
          },
        ],
        assertions: [{ target: "status", op: "eq", value: 418 }],
        extract: [
          {
            name: "forbiddenExtraction",
            path: "$.value",
            scope: "environment",
          },
        ],
        scriptDialect: "apipost8",
        beforeScript: 'throw Error("API task must not execute")',
        afterScript: 'throw Error("API after must not execute")',
      }),
    ];
    p.documents = [
      {
        id: "doc",
        title: "Guide",
        folder: "Parent/Child",
        content: "# Complete document\nA retained body.",
      },
    ];
    await app.store.save(p);
    const config = async (opts = {}) => {
      const r = await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          projects: [p.id],
          write: false,
          execute: false,
          remember: false,
          ...opts,
        }),
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    const connection = await config();
    const c = new Client(
      { name: "native-compat-fixture", version: "1" },
      { capabilities: {} },
    );
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer " + connection.token },
        },
      }),
    );
    const call = (name, args = {}) =>
      c.callTool({ name: "apipost_" + name, arguments: args });
    assert.deepEqual(
      decode(await call("list_projects")).projects.map((x) => x.project_id),
      [p.id],
    );
    assert(
      !(await c.listTools()).tools.some(
        (x) => x.name === "apipost_create_execution_flow",
      ),
    );
    const listed = decode(
      await call("list_apis", {
        project_id: p.id,
        parent_id: "folder:Parent/Child",
        keyword: "GUIDE",
      }),
    );
    assert.equal(listed.apis[0].target_type, "doc");
    assert.equal(
      decode(
        await call("get_api_detail", { project_id: p.id, target_id: "doc" }),
      ).api.description,
      p.documents[0].content,
    );
    assert.equal(
      decode(
        await c.callTool({
          name: "localapi_get_api_detail",
          arguments: { projectId: p.id, apiId: "doc" },
        }),
      ).content,
      p.documents[0].content,
    );
    assert.equal(
      (
        await call("get_api_detail", {
          project_id: denied.id,
          target_id: "doc",
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await call("create_execution_flow", {
          project_id: p.id,
          name: "Denied",
          steps: [],
        })
      ).isError,
      true,
    );
    await config({ write: true });
    const created = decode(
      await call("create_execution_flow", {
        project_id: p.id,
        name: "Frozen flow",
        environment_id: env,
        steps: [
          {
            target_id: "api",
            input: { body: { value: "{{v}}" }, query: { q: "first" } },
            pre_script: 'apt.environment.set("v", "from-step");',
            post_script:
              'apt.environment.set("after", apt.response.json().value);',
          },
          {
            target_id: "api",
            input: { body: '{"string":true}', query: { q: "second" } },
          },
        ],
      }),
    );
    assert.equal(
      (
        await call("execute_flow", {
          project_id: p.id,
          flow_id: created.flow_id,
        })
      ).isError,
      true,
    );
    let flow = decode(
      await call("get_execution_flow", {
        project_id: p.id,
        flow_id: created.flow_id,
      }),
    ).flow;
    assert.notEqual(flow.steps[0].step_id, flow.steps[1].step_id);
    assert.equal(flow.steps[0].api_snapshot.beforeScript, "");
    assert.equal(seen.length, 0);
    p = await app.store.get(p.id);
    p.requests[0].url = p.requests[0].url.replace("/echo", "/changed");
    p.requests[0].body = '{"new":true}';
    await app.store.save(p);
    await config({ write: true, execute: true });
    const run = decode(
      await call("execute_flow", {
        project_id: p.id,
        flow_id: created.flow_id,
      }),
    );
    assert.equal(run.status, "passed");
    assert.equal(run.passed, 2);
    assert.deepEqual(run.failed, []);
    assert.equal(run.record_saved, true);
    assert.deepEqual(seen, [
      { path: "/echo?q=first", body: '{"value":"from-step"}' },
      { path: "/echo?q=second", body: '"{\\"string\\":true}"' },
    ]);
    const evidence = decode(
      await call("get_execution_result", {
        project_id: p.id,
        run_id: run.run_id,
      }),
    ).run;
    assert.equal(evidence.results.length, 2);
    assert.equal(
      (await app.store.get(p.id)).environments[0].variables.after,
      "after-value",
    );
    assert.equal(
      (await app.store.get(p.id)).environments[0].variables.forbiddenExtraction,
      undefined,
    );
    const previous = await app.store.get(p.id);
    assert.equal(
      (
        await call("update_execution_flow", {
          project_id: p.id,
          flow_id: created.flow_id,
          steps: [
            { target_id: "api", step_id: flow.steps[0].step_id },
            { target_id: "api", step_id: flow.steps[0].step_id },
          ],
        })
      ).isError,
      true,
    );
    assert.deepEqual((await app.store.get(p.id)).plans, previous.plans);
    decode(
      await call("update_execution_flow", {
        project_id: p.id,
        flow_id: created.flow_id,
        name: "Updated",
        steps: [
          {
            target_id: "api",
            step_id: flow.steps[0].step_id,
            input: {},
            pre_script: "",
            post_script: "",
          },
          { target_id: "api", step_id: flow.steps[1].step_id },
          { target_id: "api" },
        ],
      }),
    );
    flow = decode(
      await call("get_execution_flow", {
        project_id: p.id,
        flow_id: created.flow_id,
      }),
    ).flow;
    assert.equal(flow.steps.length, 3);
    assert.equal(flow.steps[0].api_snapshot.url.endsWith("/echo"), true);
    assert.equal(flow.steps[2].api_snapshot.url.endsWith("/changed"), true);
    const second = decode(
      await call("execute_flow", {
        project_id: p.id,
        flow_id: created.flow_id,
      }),
    );
    assert.equal(second.status, "passed");
    assert.deepEqual(seen.slice(2), [
      { path: "/echo?q=dynamic-default", body: '{"original":1,"keep":2}' },
      { path: "/echo?q=second", body: '"{\\"string\\":true}"' },
      { path: "/changed?q=dynamic-default", body: '{"new":true}' },
    ]);
    p = await app.store.get(p.id);
    const restored = restoreProject(p);
    await app.store.save(restored);
    const tampered = structuredClone(p);
    tampered.plans[0].steps[0].nativeMCP.input = { body: { tampered: true } };
    assert.throws(() => restoreProject(tampered), /不一致/);
    p.requests[0].deletedAt = new Date().toISOString();
    await app.store.save(p);
    assert.equal(
      decode(
        await call("execute_flow", {
          project_id: p.id,
          flow_id: created.flow_id,
        }),
      ).status,
      "passed",
    );
    assert.equal(
      (
        await call("update_execution_flow", {
          project_id: p.id,
          flow_id: created.flow_id,
          steps: [{ target_id: "api", step_id: flow.steps[0].step_id }],
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await call("delete_execution_flow", {
          project_id: p.id,
          flow_id: created.flow_id,
          confirm: false,
        })
      ).isError,
      true,
    );
    assert.equal(
      decode(
        await call("delete_execution_flow", {
          project_id: p.id,
          flow_id: created.flow_id,
          confirm: true,
        }),
      ).deleted,
      true,
    );
    assert.equal((await app.store.get(restored.id)).plans.length, 1);
  },
);

test(
  "independent HTTP MCP dispatches share a running-plan lock and release it after completion",
  { timeout: 15000 },
  async (t) => {
    let entered, release;
    const reached = new Promise((r) => (entered = r)),
      hold = new Promise((r) => (release = r));
    const upstream = http.createServer(async (_req, res) => {
      entered();
      await hold;
      res.end("{}");
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(path.join(os.tmpdir(), "native-mcp-lock-")),
      app = await createApp({ root, port: 0 });
    t.after(async () => {
      release();
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("Lock");
    p.requests = [
      normalizeRequest({
        id: "slow",
        url: `http://127.0.0.1:${upstream.address().port}/slow`,
      }),
    ];
    await app.store.save(p);
    const config = await (
      await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          projects: [p.id],
          write: true,
          execute: true,
          remember: false,
        }),
      })
    ).json();
    let seq = 0;
    const call = async (name, args) => {
      const r = await fetch(app.url + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + config.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++seq,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      assert.equal(r.status, 200);
      return (await r.json()).result;
    };
    const created = decode(
      await call("apipost_create_execution_flow", {
        project_id: p.id,
        name: "Slow",
        steps: [{ target_id: "slow" }],
      }),
    );
    const pending = call("apipost_execute_flow", {
      project_id: p.id,
      flow_id: created.flow_id,
    });
    await reached;
    for (const [name, args] of [
      [
        "apipost_update_execution_flow",
        { project_id: p.id, flow_id: created.flow_id, name: "blocked" },
      ],
      [
        "apipost_delete_execution_flow",
        { project_id: p.id, flow_id: created.flow_id, confirm: true },
      ],
      ["apipost_execute_flow", { project_id: p.id, flow_id: created.flow_id }],
      [
        "localapi_save_plan",
        { projectId: p.id, plan: (await app.store.get(p.id)).plans[0] },
      ],
    ]) {
      const blocked = await call(name, args);
      assert.equal(blocked.isError, true);
      assert.match(blocked.content[0].text, /执行中/);
    }
    release();
    assert.equal(decode(await pending).status, "passed");
    decode(
      await call("apipost_update_execution_flow", {
        project_id: p.id,
        flow_id: created.flow_id,
        name: "Released",
      }),
    );
    assert.equal((await app.store.get(p.id)).plans[0].name, "Released");
  },
);

test(
  "official SDK stdio restarts and executes restored native-input plans without inheriting HTTP grants",
  { timeout: 15000 },
  async (t) => {
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );
    const { fileURLToPath } = await import("node:url");
    const { Store } = await import("../src/runtime.mjs");
    const upstream = http.createServer((_req, res) => res.end("{}"));
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(path.join(os.tmpdir(), "native-mcp-stdio-")),
      store = new Store(root),
      clients = [];
    t.after(async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const p = await store.create("Stdio");
    p.requests = [
      normalizeRequest({
        id: "api",
        url: `http://127.0.0.1:${upstream.address().port}/echo`,
      }),
    ];
    await store.save(p);
    const connect = async (projectId, write = false, execute = false) => {
      const c = new Client(
        { name: "native-stdio-fixture", version: "1" },
        { capabilities: {} },
      );
      clients.push(c);
      await c.connect(
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
      return c;
    };
    const readonly = await connect(p.id);
    assert(
      !(await readonly.listTools()).tools.some(
        (x) => x.name === "apipost_create_execution_flow",
      ),
    );
    await readonly.close();
    let c = await connect(p.id, true, true);
    const created = decode(
      await c.callTool({
        name: "apipost_create_execution_flow",
        arguments: {
          project_id: p.id,
          name: "Persisted",
          steps: [{ target_id: "api" }],
        },
      }),
    );
    await c.close();
    c = await connect(p.id, true, true);
    assert.equal(
      decode(
        await c.callTool({
          name: "apipost_execute_flow",
          arguments: { project_id: p.id, flow_id: created.flow_id },
        }),
      ).status,
      "passed",
    );
    await c.close();
    const restored = restoreProject(await store.get(p.id));
    await store.save(restored);
    const other = await connect(restored.id, true, true);
    assert.equal(
      (
        await other.callTool({
          name: "apipost_get_execution_flow",
          arguments: { project_id: p.id, flow_id: created.flow_id },
        })
      ).isError,
      true,
    );
    assert.equal(
      decode(
        await other.callTool({
          name: "apipost_execute_flow",
          arguments: { project_id: restored.id, flow_id: created.flow_id },
        }),
      ).status,
      "passed",
    );
    assert.equal((await store.get(restored.id)).runs.length, 2);
  },
);

test("mutation-first and execution-read-inflight interleavings are excluded before asynchronous storage", async (t) => {
  const { Store } = await import("../src/runtime.mjs");
  const { createMCP } = await import("../src/mcp.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mcp-race-")),
    store = new Store(root);
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits++;
    res.end("{}");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  let release;
  t.after(async () => {
    release?.();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await store.create("Interleaving");
  p.requests = [
    normalizeRequest({
      id: "api",
      url: `http://127.0.0.1:${upstream.address().port}/echo`,
    }),
  ];
  await store.save(p);
  let blocking, entered, hold;
  const wrapped = {
    root: store.root,
    list: store.list.bind(store),
    append: store.append.bind(store),
    get: async (id) => {
      if (blocking === "get") {
        blocking = null;
        entered();
        await hold;
      }
      return store.get(id);
    },
    save: async (value, ...rest) => {
      if (blocking === "save") {
        blocking = null;
        entered();
        await hold;
      }
      return store.save(value, ...rest);
    },
  };
  const dispatch = () =>
    createMCP({ store: wrapped, projects: [p.id], write: true, execute: true });
  const call = async (name, args) => {
    const r = await dispatch()({
      id: 1,
      method: "tools/call",
      params: {
        name: "apipost_" + name,
        arguments: { project_id: p.id, ...args },
      },
    });
    return r.result;
  };
  const flow = decode(
    await call("create_execution_flow", {
      name: "Original",
      steps: [{ target_id: "api" }],
    }),
  );
  const block = (kind) => {
    blocking = kind;
    const ready = new Promise((r) => (entered = r));
    hold = new Promise((r) => (release = r));
    return ready;
  };
  let ready = block("save");
  const mutation = call("update_execution_flow", {
    flow_id: flow.flow_id,
    name: "Saved",
  });
  await ready;
  assert.equal(
    (await call("execute_flow", { flow_id: flow.flow_id })).isError,
    true,
  );
  assert.equal(hits, 0);
  release();
  decode(await mutation);
  ready = block("get");
  const execution = call("execute_flow", { flow_id: flow.flow_id });
  await ready;
  assert.equal(
    (
      await call("update_execution_flow", {
        flow_id: flow.flow_id,
        name: "Must not save",
      })
    ).isError,
    true,
  );
  release();
  assert.equal(decode(await execution).status, "passed");
  assert.equal(hits, 1);
  assert.equal((await store.get(p.id)).plans[0].name, "Saved");
});

test("native frozen metadata preserves disabled steps, detaches explicit manual edits and bounds aggregate expansion", async () => {
  const { buildNativeMCPPlan } = await import("../src/native-mcp-plan.mjs");
  const { versionPlan } = await import("../src/plan-version.mjs");
  const project = {
    id: "p",
    name: "P",
    requests: [
      normalizeRequest({
        id: "api",
        url: "http://127.0.0.1/echo",
        bodyType: "json",
        body: "{}",
      }),
    ],
    environments: [{ id: "e", name: "Env", variables: {} }],
    settings: {},
  };
  let saved = versionPlan(
    undefined,
    buildNativeMCPPlan(
      project,
      { name: "Native", steps: [{ target_id: "api" }] },
      undefined,
      normalizeRequest,
    ),
    "ai",
    project,
  );
  saved.steps[0].enabled = false;
  const update = versionPlan(
    saved,
    buildNativeMCPPlan(
      project,
      { steps: [{ target_id: "api", step_id: saved.steps[0].id }] },
      saved,
      normalizeRequest,
    ),
    "ai",
    project,
  );
  assert.equal(update.steps[0].enabled, false);
  const edited = structuredClone(saved);
  edited.steps[0].request.body = '{"manual":true}';
  const manual = versionPlan(saved, edited, "manual", project);
  assert.equal(manual.steps[0].nativeMCP, undefined);
  assert.match(manual.steps[0].request.importNotes.at(-1), /解除/);
  assert.equal(manual.steps[0].request.body, '{"manual":true}');
  assert(saved.steps[0].nativeMCP);
  project.requests[0].bodyType = "raw";
  project.requests[0].body = "x".repeat(350000);
  assert.throws(
    () =>
      buildNativeMCPPlan(
        project,
        {
          name: "Too large",
          steps: Array.from({ length: 10 }, () => ({ target_id: "api" })),
        },
        undefined,
        normalizeRequest,
      ),
    /4MiB/,
  );
});
