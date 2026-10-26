// Combined SDK/export acceptance. The approved offline2 fixture is transformed
// into a synthetic MCP-shaped flow; this is not a claim of original MCP execution.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";

// Reuse the feature owner's independently authored mcpSource construction,
// without importing its test module (which would register unrelated tests).
const flowPath = "executions/flows/flow_1792937049044.json";
const indexPath = "executions/flows/index.json";
async function source() {
  const files = [];
  for (const [directory, prefix] of [
    ["directory/", ""],
    ["executions/", "executions/"],
  ]) {
    const root = new URL(
      "./fixtures/original-offline2/" + directory,
      import.meta.url,
    );
    for (const file of (await readdir(root, { recursive: true })).filter((p) =>
      p.endsWith(".json"),
    )) {
      const p = file.replaceAll("\\", "/");
      files.push({
        path: prefix + p,
        text: await readFile(new URL(p, root), "utf8"),
      });
    }
  }
  return { format: "apipost-offline-directory-v1", files };
}
function changeFile(document, path, change) {
  const file = document.files.find((f) => f.path === path),
    value = JSON.parse(file.text);
  change(value);
  file.text = JSON.stringify(value);
}
async function mcpSource(port = 18766) {
  const document = await source();
  changeFile(document, "envs/1.json", (env) => {
    env.env_var_list.native_value.value = "wrong-historical-environment";
  });
  const env = JSON.parse(
    document.files.find((f) => f.path === "envs/1.json").text,
  );
  env.env_id = "2";
  env.name = "Current environment";
  env.env_var_list.native_value.value = "actual-environment";
  document.files.push({ path: "envs/2.json", text: JSON.stringify(env) });
  changeFile(document, "envs/index.json", (index) =>
    index.items.push({ env_id: "2", name: env.name }),
  );
  changeFile(document, indexPath, (index) => {
    index.records[0].source = "mcp";
    index.records[0].environment_id = "2";
  });
  changeFile(document, flowPath, (flow) => {
    flow.source = "mcp";
    flow.environment_id = "2";
    flow.mcp_name = "{{not_expanded}}";
    flow.mcp_description = "Older AI description";
    flow.mcp_environment_id = "1";
    for (const step of flow.steps)
      step.api_snapshot.url = `http://127.0.0.1:${port}/echo?fixture=original`;
    const first = flow.steps[0];
    first.api_snapshot.request.body.raw = JSON.stringify({
      keep: "snapshot",
      obsolete: "must-not-return",
    });
    first.input = {
      body: { keep: "manual-current", value: "{{native_value}}" },
      query: { fixture: "current-query" },
    };
    first.mcp_input = {
      body: { keep: "old-AI", obsolete: "{{not_expanded}}" },
      query: { fixture: "old-query" },
      headers: { "old-header": "literal {{not_expanded}}" },
      auth: { type: "noauth" },
    };
    first.mcp_deleted_body_keys = ["keep", "../outside", "nested.path"];
    first.pre_script = 'console.log("current-step");';
    first.post_script = 'apt.environment.set("native_after", "current-post");';
    flow.steps[1].input = { body: { second: "{{native_value}}" } };
    flow.steps[1].mcp_input = {};
    flow.steps[1].mcp_deleted_body_keys = [];
  });
  return document;
}

const decode = (response) => {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "imported-mcp-entry-")),
    wire = [],
    clients = [];
  const peer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    wire.push({
      path: req.url,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
      oldHeader: req.headers["old-header"],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    for (const client of clients.splice(0))
      await client.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await stop();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, body, method = "POST") => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  return {
    root,
    wire,
    call,
    port: peer.address().port,
    get store() {
      return app.store;
    },
    async import(document) {
      const created = await call("/api/projects", {
        name: "Native MCP import acceptance",
      });
      assert.equal(created.status, 201);
      const imported = await call(`/api/projects/${created.value.id}/import`, {
        document,
      });
      assert.equal(imported.status, 200, JSON.stringify(imported));
      return imported.value;
    },
    async connect(projectId, { write = false, execute = false } = {}) {
      const config = await call("/api/mcp/config", {
        enabled: true,
        projects: [projectId],
        write,
        execute,
        remember: false,
      });
      assert.equal(config.status, 200);
      const client = new Client(
        { name: "imported-flow-sdk", version: "1" },
        { capabilities: {} },
      );
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: {
            headers: { Authorization: "Bearer " + config.value.token },
          },
        }),
      );
      return client;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
  };
}

test("native directory export refuses inert MCP comparison history without mutating the imported project", async (t) => {
  const f = await fixture(t);
  const document = await mcpSource(f.port),
    original = structuredClone(document);
  const imported = await f.import(document);
  // Explicit fixture edits remove independent legacy exporter blockers. Keep
  // the new flow provenance intact so a rejection cannot be a false positive
  // caused by archived runs or differing display/HTTP request names.
  delete imported.settings.apipostDirectoryArtifacts;
  for (const step of imported.plans[0].steps) step.name = step.request.name;
  const prepared = await f.call(
    `/api/projects/${imported.id}`,
    imported,
    "PUT",
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared));
  const before = await f.store.get(imported.id);
  assert.equal(before.plans[0].importedNativeFlowSource.source, "mcp");
  const exported = await f.call(
    `/api/projects/${imported.id}/export?format=apipost-directory`,
    undefined,
    "GET",
  );
  assert.equal(
    exported.status,
    400,
    "native export must not silently erase imported MCP comparison history",
  );
  assert.match(exported.value.error, /备份/);
  assert.match(exported.value.error, /MCP.*历史|来源/);
  const reader = await f.connect(imported.id);
  const sdkExport = await reader.callTool({
    name: "localapi_export_project",
    arguments: { projectId: imported.id, format: "apipost-directory" },
  });
  assert.equal(sdkExport.isError, true);
  assert.match(sdkExport.content[0].text, /MCP历史来源.*备份/);
  assert.deepEqual(await f.store.get(imported.id), before);
  assert.deepEqual(document, original);
  assert.deepEqual(f.wire, []);
});

function cli(root, projectId, planId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        projectId,
        "--plan",
        planId,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = setTimeout(() => {
      failure = Error("native MCP flow CLI fixture timed out");
      child.kill();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        failure = Error("CLI fixture exceeds bounded output");
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      failure ? reject(failure) : resolve({ code, signal, stdout, stderr });
    });
  });
}

const invoke = (client, name, args) =>
  client.callTool({ name, arguments: args });
const toolNames = async (client) =>
  (await client.listTools()).tools.map((tool) => tool.name).sort();

test(
  "SDK imported MCP history stays inert through native edits, manual active-binding detachment, CLI and backup restart",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const created = await f.call("/api/projects", {
      name: "Existing scoped destination",
    });
    assert.equal(created.status, 201);
    const id = created.value.id;
    const other = await f.store.create("Never authorized"),
      otherBefore = await f.store.get(other.id);
    const readonly = await f.connect(id),
      namesBefore = await toolNames(readonly);
    const document = await mcpSource(f.port),
      original = structuredClone(document);
    const imported = await f.call(`/api/projects/${id}/import`, { document });
    assert.equal(imported.status, 200, JSON.stringify(imported));
    assert.deepEqual(document, original);
    assert.deepEqual(await toolNames(readonly), namesBefore);
    assert(!namesBefore.includes("apipost_execute_flow"));
    assert(!namesBefore.includes("apipost_update_execution_flow"));
    let saved = await f.store.get(id),
      plan = saved.plans[0];
    const history = structuredClone(plan.importedNativeFlowSource),
      artifacts = structuredClone(saved.settings.apipostDirectoryArtifacts);
    assert.equal(plan.source, "ai");
    assert.equal(history.source, "mcp");
    assert.equal(history.mcp_name, "{{not_expanded}}");
    assert.equal(history.mcp_environment_id, "1");
    assert.deepEqual(history.steps[0].mcp_deleted_body_keys, [
      "keep",
      "../outside",
      "nested.path",
    ]);
    assert.equal(plan.steps[0].nativeMCP, undefined);
    const currentEnvironment = saved.environments.find(
      (env) => env.id === plan.environmentId,
    );
    assert.equal(
      currentEnvironment.variables.native_value,
      "actual-environment",
    );
    assert.equal(saved.runs.length, 0);
    for (const [name, args] of [
      ["apipost_execute_flow", { project_id: id, flow_id: plan.id }],
      ["localapi_execute_flow", { projectId: id, planId: plan.id }],
      [
        "apipost_update_execution_flow",
        { project_id: id, flow_id: plan.id, name: "unauthorized" },
      ],
      [
        "apipost_get_execution_flow",
        { project_id: other.id, flow_id: plan.id },
      ],
    ])
      assert.equal((await invoke(readonly, name, args)).isError, true);
    const view = decode(
      await invoke(readonly, "apipost_get_execution_flow", {
        project_id: id,
        flow_id: plan.id,
      }),
    ).flow;
    assert.equal(view.environment_id, currentEnvironment.id);
    assert.notEqual(view.name, history.mcp_name);
    assert.deepEqual(JSON.parse(view.steps[0].api_snapshot.body), {
      keep: "manual-current",
      value: "{{native_value}}",
    });
    assert.equal(Object.hasOwn(view, "mcp_name"), false);
    assert.equal(Object.hasOwn(view.steps[0], "mcp_input"), false);
    assert.deepEqual(f.wire, []);

    const client = await f.connect(id, { write: true, execute: true });
    const nativeCall = (name, args = {}) =>
      invoke(client, "apipost_" + name, { project_id: id, ...args });
    const canonicalPlan = async () =>
      decode(
        await invoke(client, "localapi_get_execution_flow", {
          projectId: id,
          planId: plan.id,
        }),
      );
    assert.deepEqual((await canonicalPlan()).importedNativeFlowSource, history);
    decode(
      await nativeCall("update_execution_flow", {
        flow_id: plan.id,
        name: "SDK metadata edit",
        description: "Current description, not the AI comparison",
      }),
    );
    plan = await canonicalPlan();
    assert.equal(plan.name, "SDK metadata edit");
    assert.deepEqual(plan.importedNativeFlowSource, history);
    const executed = decode(
      await nativeCall("execute_flow", { flow_id: plan.id }),
    );
    assert.equal(executed.status, "passed");
    assert.equal(executed.record_saved, true);
    assert.equal(executed.record_id, executed.attempted_record_id);
    assert.deepEqual(f.wire, [
      {
        path: "/echo?fixture=current-query",
        body: { keep: "manual-current", value: "actual-environment" },
        oldHeader: undefined,
      },
      {
        path: "/echo?fixture=original",
        body: { second: "actual-environment" },
        oldHeader: undefined,
      },
    ]);
    const result = decode(
      await nativeCall("get_execution_result", { run_id: executed.run_id }),
    ).run;
    assert.deepEqual(result.snapshot.importedNativeFlowSource, history);
    assert.deepEqual(
      result.results[0].logs.map((entry) => entry.message).filter(Boolean),
      ["current-step"],
    );
    assert.equal(result.variables.native_after, "current-post");
    saved = await f.store.get(id);
    assert.equal(saved.runs[0].source, "mcp");
    assert.equal(
      saved.environments.find(
        (env) => env.variables.native_value === "wrong-historical-environment",
      ).variables.native_after,
      "",
    );
    assert.deepEqual(saved.settings.apipostDirectoryArtifacts, artifacts);
    assert.deepEqual(await f.store.get(other.id), otherBefore);

    // Imported steps are already materialized, not active native MCP bindings.
    // Reject editing one as a live binding rather than resurrecting mcp_input.
    const beforeRejectedEdit = await f.store.get(id);
    const rejectedEdit = await nativeCall("update_execution_flow", {
      flow_id: plan.id,
      steps: [
        {
          target_id: saved.requests[0].id,
          step_id: plan.steps[0].id,
          input: { body: { mustNotAppear: true } },
        },
      ],
    });
    assert.equal(rejectedEdit.isError, true);
    assert.match(rejectedEdit.content[0].text, /非兼容步骤/);
    assert.deepEqual(await f.store.get(id), beforeRejectedEdit);

    // Add a genuine new active nativeMCP step via the public SDK. The historical
    // importedStepIds remain history, not a constraint on today's edited steps.
    saved.requests[0].url = `http://127.0.0.1:${f.port}/active`;
    const changedAPI = await f.call(`/api/projects/${id}`, saved, "PUT");
    assert.equal(changedAPI.status, 200, JSON.stringify(changedAPI));
    decode(
      await nativeCall("update_execution_flow", {
        flow_id: plan.id,
        steps: [
          {
            target_id: saved.requests[0].id,
            input: {
              body: { active: "{{native_value}}" },
              query: { fixture: "active" },
            },
            pre_script: 'console.log("active-current");',
            post_script: "",
          },
        ],
      }),
    );
    const active = await canonicalPlan();
    assert(active.steps[0].nativeMCP);
    assert.deepEqual(active.steps[0].nativeMCP.input.body, {
      active: "{{native_value}}",
    });
    assert.deepEqual(active.importedNativeFlowSource, history);
    const edit = structuredClone(active);
    delete edit.importedNativeFlowSource; // Existing provenance is inherited.
    edit.steps[0].request.body =
      '{"manual":"{{native_value}}","keep":"manual-kept"}';
    const manuallySaved = await f.call(`/api/projects/${id}/plans`, edit);
    assert.equal(manuallySaved.status, 200, JSON.stringify(manuallySaved));
    assert.equal(manuallySaved.value.steps[0].nativeMCP, undefined);
    assert.deepEqual(manuallySaved.value.importedNativeFlowSource, history);
    assert.match(
      manuallySaved.value.steps[0].request.importNotes.join(" "),
      /手工编辑已解除/,
    );
    plan = await canonicalPlan();
    assert.equal(plan.steps[0].nativeMCP, undefined);
    assert.deepEqual(plan.importedNativeFlowSource, history);
    const currentView = decode(
      await nativeCall("get_execution_flow", { flow_id: plan.id }),
    ).flow;
    assert.deepEqual(currentView.steps[0].input, {});
    assert.deepEqual(JSON.parse(currentView.steps[0].api_snapshot.body), {
      manual: "{{native_value}}",
      keep: "manual-kept",
    });
    assert.equal(f.wire.length, 2, "all definition edits are execution-free");
    const cliRun = await cli(f.root, id, plan.id);
    assert.equal(cliRun.code, 0, cliRun.stderr);
    assert.equal(cliRun.signal, null);
    const run = JSON.parse(cliRun.stdout);
    assert.equal(run.status, "passed");
    assert.equal(run.recordSaved, true);
    assert.deepEqual(run.snapshot.importedNativeFlowSource, history);
    assert.equal(run.snapshot.steps[0].nativeMCP, undefined);
    assert.deepEqual(f.wire[2], {
      path: "/active?fixture=active",
      body: { manual: "actual-environment", keep: "manual-kept" },
      oldHeader: undefined,
    });
    assert.deepEqual(
      run.results[0].logs.map((entry) => entry.message).filter(Boolean),
      ["active-current"],
    );
    const backup = await f.call(`/api/projects/${id}/export`, undefined, "GET");
    assert.equal(backup.status, 200);
    const originalSaved = await f.store.get(id);
    const restored = await f.call("/api/restore", { document: backup.value });
    assert.equal(restored.status, 201, JSON.stringify(restored));
    assert.notEqual(restored.value.id, id);
    assert.deepEqual(restored.value.plans[0].importedNativeFlowSource, history);
    await f.restart();
    assert.equal(f.wire.length, 3);
    assert.deepEqual(await new Store(f.root).get(id), originalSaved);
    const restoredReader = await f.connect(restored.value.id);
    assert(!(await toolNames(restoredReader)).includes("apipost_execute_flow"));
    const restoredPlan = decode(
      await invoke(restoredReader, "localapi_get_execution_flow", {
        projectId: restored.value.id,
        planId: plan.id,
      }),
    );
    assert.deepEqual(restoredPlan.importedNativeFlowSource, history);
    assert.equal(
      (
        await invoke(restoredReader, "apipost_execute_flow", {
          project_id: restored.value.id,
          flow_id: plan.id,
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await invoke(restoredReader, "apipost_get_execution_flow", {
          project_id: id,
          flow_id: plan.id,
        })
      ).isError,
      true,
    );
    assert.equal(f.wire.length, 3);
    const restartedCLI = await cli(f.root, restored.value.id, plan.id);
    assert.equal(restartedCLI.code, 0, restartedCLI.stderr);
    const final = await new Store(f.root).get(restored.value.id);
    assert.equal(final.runs.length, originalSaved.runs.length + 1);
    assert.equal(final.runs[0].source, "cli");
    assert.deepEqual(final.runs[0].snapshot.importedNativeFlowSource, history);
    assert.deepEqual(final.settings.apipostDirectoryArtifacts, artifacts);
    assert.deepEqual(f.wire[3], f.wire[2]);
    assert.deepEqual(await f.store.get(id), originalSaved);
    assert.deepEqual(await f.store.get(other.id), otherBefore);
    assert.deepEqual(document, original);
  },
);

test("legacy native flow without MCP comparison metadata still exports and reimports through HTTP", async (t) => {
  const f = await fixture(t);
  const imported = await f.import(await source());
  assert.equal(imported.plans[0].importedNativeFlowSource, undefined);
  // Same explicit fixture preparation as the new-history export case: archives
  // are intentionally discarded here, rather than claimed native-exportable.
  delete imported.settings.apipostDirectoryArtifacts;
  for (const step of imported.plans[0].steps) step.name = step.request.name;
  const prepared = await f.call(
    `/api/projects/${imported.id}`,
    imported,
    "PUT",
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared));
  const before = await f.store.get(imported.id);
  const exported = await f.call(
    `/api/projects/${imported.id}/export?format=apipost-directory`,
    undefined,
    "GET",
  );
  assert.equal(exported.status, 200, JSON.stringify(exported));
  const copy = await f.import(exported.value);
  assert.equal(copy.plans.length, 1);
  assert.equal(copy.plans[0].importedNativeFlowSource, undefined);
  assert.equal(copy.plans[0].steps.length, before.plans[0].steps.length);
  assert.deepEqual(
    copy.plans[0].steps.map((step) => ({
      body: step.request.body,
      pre: step.request.beforeScript,
      post: step.request.afterScript,
    })),
    before.plans[0].steps.map((step) => ({
      body: step.request.body,
      pre: step.request.beforeScript,
      post: step.request.afterScript,
    })),
  );
  assert.deepEqual(await f.store.get(imported.id), before);
  assert.deepEqual(f.wire, []);
});
