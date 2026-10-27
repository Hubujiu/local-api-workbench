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
  "official SDK environment/service/variable lifecycle preserves independent values, real execution, backup/restart and permissions",
  { timeout: 20000 },
  async (t) => {
    const seen = [],
      upstream = http.createServer(async (req, res) => {
        let body = "";
        for await (const c of req) body += c;
        seen.push({ path: req.url, body });
        res.setHeader("content-type", "application/json");
        res.end('{"seen":"from-response"}');
      });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(path.join(os.tmpdir(), "native-mcp-env-"));
    let app = await createApp({ root, port: 0 });
    const clients = [];
    t.after(async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
      await rm(root, { recursive: true, force: true });
    });
    let p = await app.store.create("Allowed"),
      other = await app.store.create("Other");
    const defaultEnv = p.environments[0].id,
      url = `http://127.0.0.1:${upstream.address().port}`;
    const configure = async (projects, write = false, execute = false) => {
      const r = await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          projects,
          write,
          execute,
          remember: false,
        }),
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    const connect = async (token) => {
      const c = new Client(
        { name: "native-environment-fixture", version: "1" },
        { capabilities: {} },
      );
      clients.push(c);
      await c.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + token } },
        }),
      );
      return c;
    };
    const first = await configure([p.id]);
    let c = await connect(first.token);
    let projectId = p.id;
    const call = (name, args = {}) =>
      c.callTool({
        name: "apipost_" + name,
        arguments: { project_id: projectId, ...args },
      });
    const beforeRead = await app.store.get(p.id);
    assert.equal(
      decode(await call("list_environments")).current_env_id,
      defaultEnv,
    );
    assert.equal(
      decode(await call("list_environment_servers")).servers[0].server_id,
      "1",
    );
    assert.deepEqual(decode(await call("get_global_variables")).variables, []);
    assert.deepEqual(await app.store.get(p.id), beforeRead);
    assert.equal(
      (await call("switch_environment", { environment_id: defaultEnv }))
        .isError,
      true,
    );
    assert.equal(
      (
        await call("get_environment_variables", {
          project_id: other.id,
          environment_id: other.environments[0].id,
        })
      ).isError,
      true,
    );
    await configure([p.id], true, true);
    const cold = await app.store.get(p.id);
    assert.equal(
      (await call("create_environment", { name: " " })).isError,
      true,
    );
    assert.deepEqual(await app.store.get(p.id), cold);
    const qa = decode(
      await call("create_environment", { name: "QA", base_url: url }),
    ).environment;
    assert.equal(qa.is_current, false);
    assert.equal(
      decode(await call("list_environments")).current_env_id,
      defaultEnv,
    );
    let servers = decode(
      await call("list_environment_servers", { environment_id: qa.env_id }),
    ).servers;
    assert.equal(servers[0].base_url, url);
    const defaultService = servers[0].server_id;
    const custom = decode(
      await call("create_environment_server", {
        name: "Shared without environment",
      }),
    ).server;
    assert.equal(custom.base_url, "");
    decode(
      await call("update_environment_server", {
        server_id: custom.server_id,
        name: "Renamed shared",
      }),
    );
    const configured = decode(
      await call("create_environment_server", {
        name: "Configured at creation",
        environment_id: qa.env_id,
        base_url: url + "/created",
      }),
    ).server;
    assert.equal(
      decode(
        await call("list_environment_servers", { environment_id: qa.env_id }),
      ).servers.find((s) => s.server_id === configured.server_id).base_url,
      url + "/created",
    );
    decode(
      await call("delete_environment_server", {
        server_id: configured.server_id,
        confirm: true,
      }),
    );
    const beforeBad = await app.store.get(p.id);
    assert.equal(
      (
        await call("update_environment_server", {
          server_id: custom.server_id,
          base_url: "",
        })
      ).isError,
      true,
    );
    assert.deepEqual(await app.store.get(p.id), beforeBad);
    decode(
      await call("update_environment_server", {
        server_id: custom.server_id,
        environment_id: qa.env_id,
        base_url: url + "/shared",
      }),
    );
    assert.equal(
      decode(
        await call("list_environment_servers", { environment_id: qa.env_id }),
      ).servers.find((s) => s.server_id === custom.server_id).base_url,
      url + "/shared",
    );
    assert.equal(
      decode(await call("list_environment_servers")).servers.find(
        (s) => s.server_id === custom.server_id,
      ).base_url,
      "",
    );
    let v = decode(
      await call("upsert_environment_variable", {
        environment_id: qa.env_id,
        key: " value ",
        value: "initial",
      }),
    ).variable;
    assert.deepEqual(v, {
      key: "value",
      value: "initial",
      current_value: "",
      description: "",
    });
    v = decode(
      await call("upsert_environment_variable", {
        environment_id: qa.env_id,
        key: "value",
        current_value: "runtime",
        description: "kept",
      }),
    ).variable;
    assert.equal(v.value, "initial");
    assert.equal(v.current_value, "runtime");
    decode(
      await call("upsert_global_variable", {
        key: "shared",
        value: "global-initial",
        current_value: "global-runtime",
      }),
    );
    const zero = decode(
      await call("upsert_global_variable", {
        key: "zero",
        value: false,
        current_value: 0,
      }),
    ).variable;
    assert.equal(zero.value, false);
    assert.equal(zero.current_value, 0);
    const nil = decode(
      await call("upsert_global_variable", {
        key: "nil",
        value: null,
        current_value: null,
      }),
    ).variable;
    assert.equal(nil.value, "");
    assert.equal(nil.current_value, "");
    assert.equal((await app.store.get(p.id)).globalVariables.nil, null);
    assert.equal(
      (
        await call("upsert_global_variable", {
          key: " __proto__ ",
          value: "bad",
        })
      ).isError,
      true,
    );
    assert.equal(
      (await call("delete_global_variable", { key: "missing", confirm: true }))
        .isError,
      true,
    );
    assert.equal(
      (await call("delete_global_variable", { key: "zero", confirm: false }))
        .isError,
      true,
    );
    decode(
      await call("delete_global_variable", { key: "zero", confirm: true }),
    );
    assert(
      !decode(await call("get_global_variables")).variables.some(
        (x) => x.key === "zero",
      ),
    );
    p = await app.store.get(p.id);
    p.requests = [
      normalizeRequest({
        id: "api",
        name: "Environment echo",
        method: "POST",
        serviceId: defaultService,
        url: "/echo",
        bodyType: "json",
        body: '{"env":"{{value}}","global":"{{shared}}"}',
      }),
    ];
    await app.store.save(p);
    const flow = decode(
      await call("create_execution_flow", {
        name: "Environment flow",
        environment_id: qa.env_id,
        steps: [
          {
            target_id: "api",
            post_script:
              'apt.environment.set("scriptAdded", apt.response.json().seen);',
          },
        ],
      }),
    );
    assert.equal(
      decode(await call("execute_flow", { flow_id: flow.flow_id })).status,
      "passed",
    );
    assert.deepEqual(seen[0], {
      path: "/echo",
      body: '{"env":"runtime","global":"global-runtime"}',
    });
    const vars = decode(
      await call("get_environment_variables", { environment_id: qa.env_id }),
    ).variables;
    assert.equal(vars.find((x) => x.key === "scriptAdded").value, "");
    assert.equal(
      vars.find((x) => x.key === "scriptAdded").current_value,
      "from-response",
    );
    decode(
      await call("update_environment", {
        environment_id: qa.env_id,
        base_url: url + "/updated",
      }),
    );
    assert.equal(
      decode(
        await call("list_environment_servers", { environment_id: qa.env_id }),
      ).servers.find((s) => s.server_id === defaultService).base_url,
      url + "/updated",
    );
    assert.equal(
      decode(await call("execute_flow", { flow_id: flow.flow_id })).status,
      "passed",
    );
    assert.equal(seen[1].path, "/updated/echo");
    decode(await call("switch_environment", { environment_id: qa.env_id }));
    assert.equal(
      decode(await call("list_environments")).current_env_id,
      qa.env_id,
    );
    const beforeEmpty = await app.store.get(p.id);
    for (const [operation, args] of [
      ["delete_environment", { environment_id: "", confirm: true }],
      ["update_environment", { environment_id: "", name: "wrong" }],
      [
        "upsert_environment_variable",
        { environment_id: "", key: "wrong", value: "bad" },
      ],
      [
        "create_environment_server",
        { name: "wrong", environment_id: "", base_url: url },
      ],
      ["list_environment_servers", { environment_id: "" }],
      [
        "create_execution_flow",
        { name: "wrong", environment_id: "", steps: [{ target_id: "api" }] },
      ],
      ["execute_flow", { flow_id: flow.flow_id, environment_id: "" }],
    ])
      assert.equal((await call(operation, args)).isError, true, operation);
    assert.deepEqual(await app.store.get(p.id), beforeEmpty);
    decode(
      await call("update_environment", {
        environment_id: "1",
        base_url: url + "/default",
      }),
    );
    const aliasFlow = decode(
      await call("create_execution_flow", {
        name: "Default alias",
        environment_id: "1",
        steps: [{ target_id: "api", input: { body: { alias: true } } }],
      }),
    );
    assert.equal(
      decode(await call("get_execution_flow", { flow_id: aliasFlow.flow_id }))
        .flow.environment_id,
      defaultEnv,
    );
    assert.equal(
      decode(
        await call("execute_flow", {
          flow_id: aliasFlow.flow_id,
          environment_id: "1",
        }),
      ).status,
      "passed",
    );
    assert.equal(seen.at(-1).path, "/default/echo");
    assert.equal(
      decode(await call("list_environments")).current_env_id,
      qa.env_id,
    );
    decode(
      await call("delete_execution_flow", {
        flow_id: aliasFlow.flow_id,
        confirm: true,
      }),
    );

    assert.equal(
      (
        await call("delete_environment", {
          environment_id: defaultEnv,
          confirm: true,
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await c.callTool({
          name: "localapi_delete_environment",
          arguments: {
            projectId: p.id,
            environmentId: defaultEnv,
            confirm: true,
          },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await call("delete_environment_server", {
          server_id: defaultService,
          confirm: true,
        })
      ).isError,
      true,
    );
    decode(
      await call("delete_environment_server", {
        server_id: custom.server_id,
        confirm: true,
      }),
    );
    assert(
      (await app.store.get(p.id)).environments.every(
        (e) => !Object.hasOwn(e.serverUrls || {}, custom.server_id),
      ),
    );
    const restored = restoreProject(await app.store.get(p.id));
    await app.store.save(restored);
    const disposable = decode(
      await call("create_environment", { name: "Disposable" }),
    ).environment;
    assert.equal(
      decode(
        await call("delete_environment", {
          environment_id: disposable.env_id,
          confirm: true,
        }),
      ).deleted,
      true,
    );
    decode(
      await c.callTool({
        name: "localapi_delete_environment",
        arguments: { projectId: p.id, environmentId: qa.env_id, confirm: true },
      }),
    );
    assert.equal((await app.store.get(p.id)).plans[0].environmentId, qa.env_id);
    const count = seen.length;
    assert.equal(
      (await call("execute_flow", { flow_id: flow.flow_id })).isError,
      true,
    );
    assert.equal(seen.length, count);
    await c.close();
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    app = await createApp({ root, port: 0 });
    assert.equal(
      (
        await fetch(app.url + "/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer " + first.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        })
      ).status,
      403,
    );
    projectId = restored.id;
    const reopened = await configure([restored.id], true, true);
    c = await connect(reopened.token);
    assert.equal(
      decode(
        await call("get_environment_variables", { environment_id: qa.env_id }),
      ).variables.find((x) => x.key === "value").current_value,
      "runtime",
    );
    assert.equal(
      (await call("get_global_variables", { project_id: p.id })).isError,
      true,
    );
    assert.equal(
      decode(await call("execute_flow", { flow_id: flow.flow_id })).status,
      "passed",
    );
    decode(
      await call("upsert_global_variable", {
        key: "shared",
        current_value: "restored-only",
      }),
    );
    assert.equal(
      (await app.store.get(p.id)).globalVariables.shared,
      "global-runtime",
    );
    assert.equal(
      (await app.store.get(restored.id)).globalVariables.shared,
      "restored-only",
    );
  },
);
