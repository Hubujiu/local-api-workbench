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
        query: [{ key: "q", value: "saved" }],
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
      { path: "/echo?q=saved", body: '{"original":1,"keep":2}' },
      { path: "/echo?q=second", body: '"{\\"string\\":true}"' },
      { path: "/changed?q=saved", body: '{"new":true}' },
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
