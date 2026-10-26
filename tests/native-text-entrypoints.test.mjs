// Independent combined Text extraction/assertion acceptance. Fictional native
// fixtures, real SDK transports, CLI, sockets and owned filesystem faults.
// No original executable, account or separately scoped intrinsic audit is used.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const task = (id, type, data, enabled = 1) => ({
  id,
  name: id,
  type,
  enabled,
  data,
});
const row = (name, type = "envVars", expression) => ({
  name,
  type,
  ...(expression === undefined ? {} : { expression }),
});
const pick = (id, variables, enabled = 1) =>
  task(id, "pickVars", { source: "responseText", variables }, enabled);
const messageFor = (mode = "ok") =>
  `view|state:${mode === "blocked" ? "blocked" : "ready"}| 雪 🧪 | e\u0301\r\n`;
const inertBody = "inert historical response";
const assertion = (
  id,
  value,
  comparison = "eq",
  type = "responseText",
  diagnostic,
  enabled = 1,
) =>
  task(
    id,
    "assert",
    {
      type,
      expression: {
        ...(diagnostic === undefined ? {} : { path: diagnostic }),
        compareType: comparison,
        compareValue: value,
      },
    },
    enabled,
  );
const inertDiagnostic = " {{IGNORED_TEXT_PATH}} [not-selector]() ";
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const invoke = (client, name, args) =>
  client.callTool({ name, arguments: args });
function textSource(base, version, activePick = true) {
  const document = modernApipostFixture();
  document.global.envs = [];
  document.global.servers = [];
  document.global.global_vars = {};
  const login = document.apis[1];
  login.name = "Text login";
  login.url = base + "/login/{{tenant}}";
  login.protocol = version === "2" ? "http/2" : "http/1.1";
  login.request.query.parameter = [];
  login.request.header.parameter = [];
  login.request.pre_tasks = [
    task(
      "before",
      "customScript",
      'pm.environment.set("beforeProof","committed");pm.environment.set("beforeCount",(pm.environment.get("beforeCount")||0)+1);',
    ),
  ];
  login.request.post_tasks = [
    task(
      "prepare",
      "customScript",
      'const prefix="derived:";const currentText=pm.response.text()+"-view";const currentMessage="view|state:"+response.headers["x-state"]+"| 雪 🧪 | e\\u0301\\r\\n";apt.response.setBody(currentText);apt.response.setCode(201);pm.environment.set("postPending","new");pm.globals.set("postGlobal","new");',
    ),
    pick(
      "token-pick",
      [
        row(" token "),
        row(" temporaryToken ", "tempVars", inertDiagnostic),
        row(
          " sharedToken ",
          "globalVars",
          '(()=>{throw Error("expression must not execute")})()',
        ),
      ],
      activePick ? 1 : 0,
    ),
    task("interleaved-wait", "wait", 10),
    task(
      "message-view",
      "customScript",
      "apt.response.setBody(currentMessage);",
    ),
    assertion("Text eq", messageFor()),
    assertion(
      "Text uneq",
      messageFor("blocked"),
      "uneq",
      "responseText",
      inertDiagnostic,
    ),
    assertion("Text includes", "state:ready", "includes", "responseText", ""),
    assertion("Text unincludes", "state:blocked", "unincludes"),
    pick(
      "unicode-pick",
      [row(" unicodeText ", "envVars", "{{MISSING_EXPRESSION}}")],
      activePick ? 1 : 0,
    ),
    task("empty-view", "customScript", 'apt.response.setBody("");'),
    assertion("empty literal", ""),
    pick("empty-pick", [row(" emptyText ", "envVars", "")], activePick ? 1 : 0),
    task(
      "consume",
      "customScript",
      `if(${activePick} && (pm.environment.get("token")!==currentText || pm.variables.get("temporaryToken")!==currentText))throw Error("real Text extraction did not assign exact current body");if(!${activePick})pm.environment.set("token",currentText);pm.environment.set("derived",prefix+pm.environment.get("token"));pm.environment.set("followingTask","yes");apt.response.setBody(currentText);for(const entry of tests)entry.passed=true;tests.length=0;tests.push({name:"forged success",passed:true});`,
    ),
    pick("disabled", [row("disabled", "envVars", "{{TEXT_PATH}}")], 0),
    assertion(
      "disabled assertion",
      "{{IGNORED_EXPECTED}}",
      "eq",
      "responseText",
      "{{TEXT_PATH}}",
      0,
    ),
  ];
  const resource = structuredClone(login);
  resource.target_id = "text-resource";
  resource.name = "Protected resource";
  resource.url = base + "/resource";
  resource.request.pre_tasks = [];
  resource.request.post_tasks = [
    task(
      "mixed-view",
      "customScript",
      'const mixedPrefix="mixed:";apt.response.setBody(mixedPrefix+"雪");',
    ),
    assertion("mixed Text contains", "mixed:", "includes"),
    assertion(
      "Header contains",
      "transport:",
      "includes",
      "responseHeader",
      "x-proof",
    ),
    assertion("Code contains", "20", "includes", "responseCode", ""),
    task("mixed-wait", "wait", 10),
    task(
      "JSON-view",
      "customScript",
      'apt.response.setBody(JSON.stringify({stage:mixedPrefix+"json"}));',
    ),
    assertion("JSON contains", "mixed:", "includes", "responseJson", "$.stage"),
    task(
      "XML-view",
      "customScript",
      'apt.response.setBody("<login><state>"+mixedPrefix+"xml</state></login>");',
    ),
    assertion(
      "XML excludes",
      "blocked",
      "unincludes",
      "responseXml",
      "string(/login/state)",
    ),
    task(
      "mixed-complete",
      "customScript",
      'pm.test("same mixed VM",()=>pm.expect(mixedPrefix).to.equal("mixed:"));',
    ),
  ];
  resource.request.auth = { type: "bearer", bearer: { key: "{{token}}" } };
  document.apis.push(resource);
  return document;
}

async function fixture(t, version = "1.1") {
  const root = await mkdtemp(path.join(tmpdir(), "native-text-entry-")),
    wire = [],
    responses = [],
    clients = [],
    sessions = new Set();
  let mode = "ok",
    count = 0;
  const peer = version === "2" ? http2.createServer() : http.createServer();
  peer.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  peer.on("request", (req, res) => {
    wire.push({ path: req.url, authorization: req.headers.authorization });
    // Text does not infer a parser from this deliberately misleading media type.
    res.setHeader("content-type", "application/xml; charset=utf-8");
    res.setHeader("x-state", mode === "blocked" ? "blocked" : "ready");
    res.setHeader("x-proof", "transport:real");
    const body = req.url.startsWith("/login/")
      ? "wire-text-" + ++count
      : inertBody;
    responses.push(body);
    res.end(body);
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
    for (const session of sessions) session.destroy();
    peer.closeAllConnections?.();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, body, method = "POST") => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  return {
    root,
    wire,
    responses,
    call,
    version,
    base: `http://127.0.0.1:${peer.address().port}`,
    get store() {
      return app.store;
    },
    setMode(value) {
      mode = value;
    },
    async import(document) {
      const p = await call("/api/projects", {
        name: "Text entrypoint fixture",
      });
      assert.equal(p.status, 201);
      const imported = await call(`/api/projects/${p.value.id}/import`, {
        document,
      });
      assert.equal(imported.status, 200, JSON.stringify(imported));
      return imported.value;
    },
    async seed(document) {
      const p = await this.import(document);
      p.environments[0].variables = {
        tenant: "selected",
        token: "stale-token",
        beforeCount: 0,
        derived: "old-derived",
        postPending: "old-pending",
        disabled: "unchanged",
        TEXT_PATH: "must-not-be-expanded",
      };
      p.environments.push({
        id: "text-other-env",
        name: "Unselected",
        variables: { tenant: "other", token: "other-env-token" },
      });
      p.globalVariables.postGlobal = "old-global";
      const result = await call(`/api/projects/${p.id}`, p, "PUT");
      assert.equal(result.status, 200, JSON.stringify(result));
      return result.value;
    },
    async connect(
      projectId,
      transport = "http",
      { write = true, execute = true } = {},
    ) {
      const client = new Client(
        { name: "native-text-entrypoints", version: "1" },
        { capabilities: {} },
      );
      clients.push(client);
      if (transport === "http") {
        const configured = await call("/api/mcp/config", {
          enabled: true,
          projects: [projectId],
          write,
          execute,
          remember: false,
        });
        assert.equal(configured.status, 200);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { Authorization: "Bearer " + configured.value.token },
            },
          }),
        );
      } else {
        const stdio = new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            projectId,
            ...(write ? ["--write"] : []),
            ...(execute ? ["--execute"] : []),
          ],
          env: { LOCAL_API_DATA: root },
          stderr: "pipe",
        });
        stdio.stderr.resume();
        await client.connect(stdio);
      }
      return client;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
  };
}

async function sdkPlan(client, project, environmentId) {
  return decode(
    await invoke(client, "localapi_create_execution_flow", {
      projectId: project.id,
      plan: {
        name: "Text to Bearer",
        environmentId,
        steps: project.requests.map((request) => ({ request })),
      },
    }),
  );
}
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
      failure = Error("Text CLI fixture timed out");
      child.kill();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        failure = Error("CLI output exceeds bound");
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
const comparableTasks = (pipeline) =>
  Object.fromEntries(
    Object.entries(pipeline).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(({ id, ...task }) => task) : value,
    ]),
  );
function textAssertions(run, passed) {
  for (const name of [
    "Text eq",
    "Text uneq",
    "Text includes",
    "Text unincludes",
  ])
    assert.equal(
      run.results[0].assertions.find((entry) => entry.name === name)?.passed,
      passed,
      JSON.stringify(run.results[0].assertions),
    );
}
function assertTextRun(run, wireToken) {
  const token = wireToken + "-view";
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.equal(run.recordId, run.attemptedRecordId);
  assert.equal(run.results[0].response.status, 200);
  assert.equal(run.results[0].response.body, wireToken);
  assert.deepEqual(run.results[0].scriptResponse, { body: token, status: 201 });
  textAssertions(run, true);
  for (const name of ["empty literal"])
    assert.equal(
      run.results[0].assertions.find((entry) => entry.name === name)?.passed,
      true,
      name,
    );
  assert.equal(run.variables.unicodeText, messageFor());
  assert.equal(run.variables.emptyText, "");
  assert.equal(run.variables.token, token);
  assert.equal(run.variables.derived, "derived:" + token);
  assert.equal(run.variables.disabled, "unchanged");
  assert.equal(run.results[1].request.auth.token, token);
  for (const name of [
    "mixed Text contains",
    "Header contains",
    "Code contains",
    "JSON contains",
    "XML excludes",
    "same mixed VM",
  ])
    assert.equal(
      run.results[1].assertions.find((entry) => entry.name === name)?.passed,
      true,
      name,
    );
}
async function waitFor(predicate, message) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error(message);
}

for (const [version, transport] of [
  ["1.1", "http"],
  ["2", "stdio"],
])
  test(
    `Text HTTP/${version} native API export reaches official ${transport} SDK and true CLI with scoped backup restart`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t, version),
        document = textSource(f.base, version),
        untouched = structuredClone(document);
      const original = await f.seed(document),
        originalBefore = await f.store.get(original.id);
      const exported = await f.call(
        `/api/projects/${original.id}/export?format=apipost`,
        undefined,
        "GET",
      );
      assert.equal(exported.status, 200, JSON.stringify(exported));
      const copy = await f.import(exported.value);
      const selected = copy.environments.find(
          (env) => env.variables.tenant === "selected",
        ),
        unselected = copy.environments.find(
          (env) => env.variables.tenant === "other",
        );
      assert(selected && unselected);
      assert.deepEqual(
        comparableTasks(copy.requests[0].nativeTasks),
        comparableTasks(original.requests[0].nativeTasks),
      );
      const disabled = copy.requests[0].nativeTasks.after.find(
        (task) => task.type === "pickVars" && task.enabled === 0,
      );
      assert.equal(disabled.data.variables[0].expression, "{{TEXT_PATH}}");
      const tokenTask = copy.requests[0].nativeTasks.after.find(
        (entry) => entry.name === "token-pick",
      );
      assert.equal(tokenTask.data.variables[0].name, " token ");
      assert(!Object.hasOwn(tokenTask.data.variables[0], "expression"));
      assert.equal(tokenTask.data.variables[1].expression, inertDiagnostic);
      const eq = copy.requests[0].nativeTasks.after.find(
        (entry) => entry.name === "Text eq",
      );
      assert(!Object.hasOwn(eq.data.expression, "path"));
      assert.equal(
        copy.requests[0].nativeTasks.after.find(
          (entry) => entry.name === "Text uneq",
        ).data.expression.path,
        inertDiagnostic,
      );
      const reader = await f.connect(copy.id, transport, {
        write: false,
        execute: false,
      });
      const readTools = (await reader.listTools()).tools.map(
        (tool) => tool.name,
      );
      assert(!readTools.includes("localapi_execute_flow"));
      assert.equal(
        (
          await invoke(reader, "localapi_execute_api", {
            projectId: copy.id,
            apiId: copy.requests[0].id,
          })
        ).isError,
        true,
      );
      const client = await f.connect(copy.id, transport);
      const plan = await sdkPlan(client, copy, selected.id);
      for (const args of [
        { projectId: original.id, planId: plan.id },
        {
          projectId: copy.id,
          planId: plan.id,
          environmentId: original.environments[0].id,
        },
      ])
        assert.equal(
          (await invoke(client, "localapi_execute_flow", args)).isError,
          true,
        );
      assert.deepEqual(f.wire, []);
      const run = decode(
        await invoke(client, "localapi_execute_flow", {
          projectId: copy.id,
          planId: plan.id,
        }),
      );
      assertTextRun(run, "wire-text-1");
      assert.deepEqual(f.wire, [
        { path: "/login/selected", authorization: undefined },
        { path: "/resource", authorization: "Bearer wire-text-1-view" },
      ]);
      const stored = await f.store.get(copy.id);
      assert.deepEqual(
        stored.runs.find((entry) => entry.id === run.id).results,
        run.results,
      );
      const storedVars = stored.environments.find(
        (env) => env.id === selected.id,
      ).variables;
      assert.equal(storedVars.unicodeText, messageFor());
      assert.equal(storedVars.emptyText, "");
      assert.equal(stored.globalVariables.sharedToken, "wire-text-1-view");
      for (const absent of [
        " token ",
        " temporaryToken ",
        " sharedToken ",
        " unicodeText ",
        " emptyText ",
        "temporaryToken",
      ])
        assert(!Object.hasOwn(storedVars, absent), absent);
      assert.equal(
        stored.environments.find((env) => env.id === selected.id).variables
          .temporaryToken,
        undefined,
      );
      assert.deepEqual(
        stored.environments.find((env) => env.id === unselected.id),
        unselected,
      );
      // Frozen plan survives later live-definition drift, without rereading it.
      stored.requests[0].nativeTasks.after.find(
        (task) =>
          task.id ===
          copy.requests[0].nativeTasks.after.find(
            (task) => task.type === "pickVars" && task.enabled === 1,
          ).id,
      ).data.variables[0].name = "liveEditedToken";
      const edit = await f.call(`/api/projects/${copy.id}`, stored, "PUT");
      assert.equal(edit.status, 200);
      const command = await cli(f.root, copy.id, plan.id);
      assert.equal(command.code, 0, command.stderr);
      assert.equal(command.signal, null);
      assertTextRun(JSON.parse(command.stdout), "wire-text-2");
      assert.equal(f.wire.at(-1).authorization, "Bearer wire-text-2-view");
      const saved = await f.store.get(copy.id);
      const backup = await f.call(
        `/api/projects/${copy.id}/export`,
        undefined,
        "GET",
      );
      assert.equal(backup.status, 200);
      const restored = await f.call("/api/restore", { document: backup.value });
      assert.equal(restored.status, 201);
      await f.restart();
      assert.equal(f.wire.length, 4);
      assert.deepEqual(
        (await new Store(f.root).get(restored.value.id)).runs,
        saved.runs,
      );
      const restoredRead = await f.connect(restored.value.id, transport, {
        write: false,
        execute: false,
      });
      assert.equal(
        (
          await invoke(restoredRead, "localapi_execute_flow", {
            projectId: restored.value.id,
            planId: plan.id,
          })
        ).isError,
        true,
      );
      const again = await cli(f.root, restored.value.id, plan.id);
      assert.equal(again.code, 0, again.stderr);
      assertTextRun(JSON.parse(again.stdout), "wire-text-3");
      const restarted = await new Store(f.root).get(restored.value.id);
      assert.equal(restarted.runs.length, 3);
      assert.deepEqual(
        restarted.plans[0].steps[0].request.nativeTasks,
        plan.steps[0].request.nativeTasks,
      );
      assert.deepEqual(
        restarted.environments.find((env) => env.id === unselected.id),
        unselected,
      );
      assert.deepEqual(await f.store.get(copy.id), saved);
      assert.deepEqual(await f.store.get(original.id), originalBefore);
      assert.deepEqual(document, untouched);
      assert.equal(f.wire.length, 6);
      assert.equal(f.wire.at(-1).authorization, "Bearer wire-text-3-view");
    },
  );

for (const activePick of [false, true])
  test(
    `Text false comparisons with ${activePick ? "active" : "disabled"} extraction have exact continuation and private evidence`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        p = await f.seed(textSource(f.base, "1.1", activePick));
      f.setMode("blocked");
      const before = await f.store.get(p.id),
        client = await f.connect(p.id),
        plan = await sdkPlan(client, p, p.environments[0].id);
      const run = decode(
        await invoke(client, "localapi_execute_flow", {
          projectId: p.id,
          planId: plan.id,
        }),
      );
      assert.equal(run.status, "failed");
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, activePick ? 1 : 2);
      textAssertions(run, false);
      assert.equal(run.results[0].response.body, "wire-text-1");
      assert.equal(run.results[0].scopeCommit, undefined);
      const saved = await new Store(f.root).get(p.id),
        vars = saved.environments[0].variables;
      assert.equal(vars.beforeProof, "committed");
      assert.equal(vars.beforeCount, 1);
      assert.equal(vars.token, activePick ? "stale-token" : "wire-text-1-view");
      assert.equal(
        vars.derived,
        activePick ? "old-derived" : "derived:wire-text-1-view",
      );
      assert.equal(vars.postPending, activePick ? "old-pending" : "new");
      assert.equal(vars.followingTask, activePick ? undefined : "yes");
      assert.equal(vars.unicodeText, undefined);
      assert.equal(vars.emptyText, undefined);
      assert.equal(
        saved.globalVariables.postGlobal,
        activePick ? "old-global" : "new",
      );
      assert.equal(saved.globalVariables.sharedToken, undefined);
      assert.deepEqual(saved.environments[1], before.environments[1]);
      assert.deepEqual(saved.runs[0].results, run.results);
      assert.deepEqual(f.wire, [
        { path: "/login/selected", authorization: undefined },
        ...(!activePick
          ? [{ path: "/resource", authorization: "Bearer wire-text-1-view" }]
          : []),
      ]);
    },
  );
for (const failure of ["non-string", "getter", "later-task"])
  test(
    `SDK Text ${failure} preserves original evidence, rolls back earlier rows, and never sends stale Bearer`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        document = textSource(f.base, "1.1"),
        tasks = document.apis[1].request.post_tasks;
      if (failure === "later-task") {
        // All Text rows read one body: first complete a real multirow extraction,
        // then reject a later extraction after a body mutation, not a fake selector.
        tasks.splice(
          2,
          1,
          task("invalidate", "customScript", "response.body=null;"),
          pick("late-pick", [row("lateAssignment")]),
        );
      } else {
        const index = tasks.findIndex((entry) => entry.name === "Text eq");
        tasks.splice(
          index,
          0,
          task(
            "invalid-current-body",
            "customScript",
            failure === "getter"
              ? 'Object.defineProperty(response,"body",{configurable:true,get(){throw Error("OWNED_TEXT_GETTER_MUST_NOT_RUN");}});'
              : "response.body=42;",
          ),
        );
      }
      const p = await f.seed(document),
        before = await f.store.get(p.id),
        client = await f.connect(p.id),
        plan = await sdkPlan(client, p, p.environments[0].id);
      const run = decode(
        await invoke(client, "localapi_execute_flow", {
          projectId: p.id,
          planId: plan.id,
        }),
      );
      assert.equal(run.status, "failed");
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 1);
      assert.match(run.results[0].error, /自有字符串/);
      assert(!run.results[0].error.includes("OWNED_TEXT_GETTER_MUST_NOT_RUN"));
      assert.equal(run.results[0].response.body, "wire-text-1");
      assert.equal(run.results[0].response.status, 200);
      const saved = await new Store(f.root).get(p.id),
        vars = saved.environments[0].variables;
      assert.equal(vars.token, "stale-token");
      assert.equal(vars.beforeProof, "committed");
      assert.equal(vars.beforeCount, 1);
      assert.equal(vars.postPending, "old-pending");
      assert.equal(vars.derived, "old-derived");
      for (const key of [
        "unicodeText",
        "emptyText",
        "temporaryToken",
        "lateAssignment",
        "followingTask",
      ])
        assert.equal(vars[key], undefined, key);
      assert.equal(saved.globalVariables.sharedToken, undefined);
      assert.equal(saved.globalVariables.postGlobal, "old-global");
      assert.deepEqual(saved.environments[1], before.environments[1]);
      assert.deepEqual(saved.runs[0].results, run.results);
      assert.deepEqual(f.wire, [
        { path: "/login/selected", authorization: undefined },
      ]);
    },
  );

test(
  "SDK Text post-scope journal uncertainty preserves before state and actual response, not a saved-record acknowledgement or stale-token retry",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.seed(textSource(f.base, "1.1"));
    const other = await f.store.create("Unrelated journal project"),
      otherBefore = await f.store.get(other.id);
    const client = await f.connect(p.id),
      plan = await sdkPlan(client, p, p.environments[0].id);
    const before = await f.store.get(p.id),
      envId = p.environments[0].id;
    const store = f.store,
      originalSave = store.save,
      originalRead = store.readUnlocked;
    const directory = store.directory(p.id),
      history = path.join(directory, "history"),
      kept = path.join(directory, "history-kept"),
      journalFile = path.join(directory, ".transaction.json");
    let postAttempts = 0,
      beforePostRead,
      observed;
    t.after(() => {
      store.save = originalSave;
      store.readUnlocked = originalRead;
    });
    // Wait until the original save has read the committed pre-stage. Then an owned
    // ordinary file prevents real apply after journal rename. Never fake an error.
    store.save = async function (value, options) {
      if (
        value.id !== p.id ||
        options?.activity ||
        value.environments.find((env) => env.id === envId)?.variables.token !==
          "wire-text-1-view"
      )
        return originalSave.call(this, value, options);
      postAttempts++;
      this.readUnlocked = async function (id) {
        const state = await originalRead.call(this, id);
        beforePostRead = structuredClone(state);
        this.readUnlocked = originalRead;
        await rename(history, kept);
        await writeFile(history, "owned text scope apply obstacle");
        return state;
      };
      try {
        return await originalSave.call(this, value, options);
      } catch (error) {
        observed = error;
        throw error;
      } finally {
        this.readUnlocked = originalRead;
      }
    };
    const run = decode(
      await invoke(client, "localapi_execute_flow", {
        projectId: p.id,
        planId: plan.id,
      }),
    );
    store.save = originalSave;
    assert.equal(postAttempts, 1);
    assert(observed instanceof ProjectCommitUncertain);
    assert.equal(beforePostRead.revision, before.revision + 1);
    assert.equal(beforePostRead.environments[0].variables.beforeCount, 1);
    assert.equal(
      beforePostRead.environments[0].variables.beforeProof,
      "committed",
    );
    assert.equal(beforePostRead.environments[0].variables.token, "stale-token");
    assert.equal(run.status, "failed");
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].response.status, 200);
    assert.equal(run.results[0].response.body, f.responses[0]);
    assert.equal(run.results[0].response.headers["x-state"], "ready");
    textAssertions(run, true);
    assert(run.results[0].assertions.every((entry) => entry.passed));
    assert.deepEqual(run.results[0].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
    });
    assert.equal(run.variables.beforeProof, "committed");
    assert.equal(run.variables.beforeCount, 1);
    assert.equal(run.variables.token, "stale-token");
    assert.equal(run.variables.derived, "old-derived");
    assert.equal(run.recordSaved, false);
    assert.equal(run.recordId, null);
    assert.equal(run.attemptedRecordId, run.id);
    assert.deepEqual(run.persistenceOutcome, {
      code: "PROJECT_COMMIT_UNCERTAIN",
      project_id: p.id,
      commit_outcome: "unknown",
      retry_safe: false,
    });
    for (const hidden of [
      f.root,
      JSON.stringify(f.root).slice(1, -1),
      "ENOTDIR",
      '"cause"',
      "owned text scope apply obstacle",
    ])
      assert(!JSON.stringify(run).includes(hidden));
    assert.equal((await stat(history)).isFile(), true);
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    assert.equal(journal.revision, before.revision + 2);
    assert.equal(journal.configRevision, before.configRevision + 2);
    assert.equal(journal.environments[0].variables.token, "wire-text-1-view");
    assert.equal(
      journal.environments[0].variables.derived,
      "derived:wire-text-1-view",
    );
    const physicalEnvironment = JSON.parse(
      await readFile(path.join(directory, "envs", envId + ".json"), "utf8"),
    );
    assert.equal(physicalEnvironment.variables.token, "wire-text-1-view");
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "project.json"), "utf8"))
        .revision,
      beforePostRead.revision,
    );
    assert.deepEqual(
      journal.runs,
      before.runs,
      "the scope journal is not a saved execution record",
    );
    await assert.rejects(
      new Store(f.root).get(p.id),
      (error) => error instanceof ProjectCommitUncertain,
    );
    assert.deepEqual(f.wire, [
      { path: "/login/selected", authorization: undefined },
    ]);
    assert.deepEqual(await f.store.get(other.id), otherBefore);
    // Repair only the fixture obstacle; recovery can reveal committed scopes, but
    // cannot imply that the attempted run record was saved, or authorize replay.
    await rm(history);
    await rename(kept, history);
    const recovered = await new Store(f.root).get(p.id);
    assert.equal(recovered.environments[0].variables.token, "wire-text-1-view");
    assert.equal(recovered.environments[0].variables.beforeCount, 1);
    assert.equal(recovered.environments[0].variables.beforeProof, "committed");
    assert.equal(
      recovered.environments[0].variables.derived,
      "derived:wire-text-1-view",
    );
    assert.equal(recovered.environments[0].variables.temporaryToken, undefined);
    assert.deepEqual(recovered.environments[1], before.environments[1]);
    assert.deepEqual(recovered.runs, before.runs);
    assert(
      !recovered.runs.some((record) => record.id === run.attemptedRecordId),
    );
    assert.deepEqual(await new Store(f.root).get(p.id), recovered);
    await assert.rejects(readFile(journalFile), { code: "ENOENT" });
    await client.ping();
    assert.equal(postAttempts, 1);
    assert.deepEqual(f.wire, [
      { path: "/login/selected", authorization: undefined },
    ]);
  },
);

async function inertFlowDocument(base) {
  const files = [];
  for (const [directory, prefix] of [
    ["directory/", ""],
    ["executions/", "executions/"],
  ]) {
    const root = new URL(
      "./fixtures/original-offline2/" + directory,
      import.meta.url,
    );
    for (const name of (await readdir(root, { recursive: true })).filter(
      (name) => name.endsWith(".json"),
    )) {
      const relative = name.replaceAll("\\", "/");
      files.push({
        path: prefix + relative,
        text: await readFile(new URL(relative, root), "utf8"),
      });
    }
  }
  const file = files.find(
      (entry) => entry.path === "executions/flows/flow_1792937049044.json",
    ),
    flow = JSON.parse(file.text);
  for (const step of flow.steps) {
    step.api_snapshot.url = base + "/inert";
    step.pre_script = "";
    step.post_script = "";
    step.api_snapshot.request.pre_tasks = [
      task(
        "historical-script",
        "customScript",
        'throw Error("historical {{TEXT_PATH}} must not run")',
      ),
    ];
    // Raw enabled tasks first pass their own closed structural grammar. Unlike
    // selectors, Text expression/path strings are retained diagnostic data only;
    // converting to historical source never authorizes any task to execute.
    step.api_snapshot.request.post_tasks = [
      pick("historical-text", [row(" token ")]),
      pick(
        "historical-disabled",
        [row("disabled", "envVars", "{{MISSING_TEXT_PATH}}")],
        0,
      ),
      assertion(
        "historical-assert",
        "must-not-be-observed",
        "eq",
        "responseText",
        inertDiagnostic,
      ),
      assertion(
        "historical-disabled-assert",
        "{{INERT_EXPECTED}}",
        "unincludes",
        "responseText",
        undefined,
        0,
      ),
    ];
  }
  file.text = JSON.stringify(flow);
  return { format: "apipost-offline-directory-v1", files };
}

test(
  "raw Text task grammar rejects atomically while native flow source stays inert through true CLI and backup restart",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      document = await inertFlowDocument(f.base),
      untouched = structuredClone(document);
    const created = await f.call("/api/projects", {
      name: "Inert Text source",
    });
    assert.equal(created.status, 201);
    const initial = await f.store.get(created.value.id);
    const invalid = structuredClone(document);
    const invalidFile = invalid.files.find(
      (entry) => entry.path === "executions/flows/flow_1792937049044.json",
    );
    const invalidFlow = JSON.parse(invalidFile.text);
    invalidFlow.steps[0].api_snapshot.request.post_tasks[0].data.variables.push(
      row(" __proto__ "),
    );
    invalidFile.text = JSON.stringify(invalidFlow);
    const rejected = await f.call(`/api/projects/${initial.id}/import`, {
      document: invalid,
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.value.error, /变量名/);
    assert.deepEqual(await f.store.get(initial.id), initial);
    assert.deepEqual(f.wire, []);
    const badExpected = structuredClone(document);
    const expectedFile = badExpected.files.find(
      (entry) => entry.path === "executions/flows/flow_1792937049044.json",
    );
    const expectedFlow = JSON.parse(expectedFile.text);
    expectedFlow.steps[0].api_snapshot.request.post_tasks[2].data.expression.compareValue =
      "{{UNSUPPORTED_EXPECTED}}";
    expectedFile.text = JSON.stringify(expectedFlow);
    const rejectedExpected = await f.call(
      `/api/projects/${initial.id}/import`,
      { document: badExpected },
    );
    assert.equal(rejectedExpected.status, 400);
    assert.match(rejectedExpected.value.error, /模板/);
    assert.deepEqual(await f.store.get(initial.id), initial);
    assert.deepEqual(f.wire, []);
    const imported = await f.call(`/api/projects/${initial.id}/import`, {
      document,
    });
    assert.equal(imported.status, 200, JSON.stringify(imported));
    const p = imported.value,
      plan = p.plans[0],
      env = p.environments.find((env) => env.id === plan.environmentId);
    env.variables.token = "unchanged-inert-token";
    env.variables.TEXT_PATH = "string(/login/token)";
    const seeded = await f.call(`/api/projects/${p.id}`, p, "PUT");
    assert.equal(seeded.status, 200);
    const histories = plan.steps.map((step) =>
      structuredClone(step.request.importedNativeTaskSource),
    );
    for (const [index, step] of plan.steps.entries()) {
      assert.equal(step.request.nativeTasks, undefined);
      assert.equal(step.request.beforeScript, "");
      assert.equal(step.request.afterScript, "");
      assert.equal(histories[index].after[0].enabled, 1);
      assert.equal(histories[index].after[0].data.source, "responseText");
      assert.equal(histories[index].after[0].data.variables[0].name, " token ");
      assert(
        !Object.hasOwn(
          histories[index].after[0].data.variables[0],
          "expression",
        ),
      );
      assert.equal(
        histories[index].after[2].data.expression.path,
        inertDiagnostic,
      );
      assert.equal(
        histories[index].after[3].data.expression.compareValue,
        "{{INERT_EXPECTED}}",
      );
      assert.equal(
        histories[index].after[1].data.variables[0].expression,
        "{{MISSING_TEXT_PATH}}",
      );
    }
    const command = await cli(f.root, p.id, plan.id);
    assert.equal(command.code, 0, command.stderr);
    const run = JSON.parse(command.stdout);
    assert.equal(run.status, "passed");
    assert.equal(run.variables.token, "unchanged-inert-token");
    assert.equal(run.variables.disabled, undefined);
    assert(
      run.results.every(
        (result) =>
          result.response.body === inertBody && result.assertions.length === 0,
      ),
    );
    assert.deepEqual(
      run.snapshot.steps.map((step) => step.request.importedNativeTaskSource),
      histories,
    );
    assert.deepEqual(
      f.wire,
      Array.from({ length: 2 }, () => ({
        path: "/inert?fixture=original",
        authorization: undefined,
      })),
    );
    const saved = await f.store.get(p.id),
      backup = await f.call(`/api/projects/${p.id}/export`, undefined, "GET");
    assert.equal(backup.status, 200);
    const restored = await f.call("/api/restore", { document: backup.value });
    assert.equal(restored.status, 201);
    await f.restart();
    const reread = await new Store(f.root).get(restored.value.id);
    assert.deepEqual(
      reread.plans[0].steps.map(
        (step) => step.request.importedNativeTaskSource,
      ),
      histories,
    );
    assert.deepEqual(
      reread.runs[0].snapshot.steps.map(
        (step) => step.request.importedNativeTaskSource,
      ),
      histories,
    );
    assert.equal(
      reread.environments.find((env) => env.id === plan.environmentId).variables
        .token,
      "unchanged-inert-token",
    );
    assert.deepEqual(await f.store.get(p.id), saved);
    assert.deepEqual(document, untouched);
    assert.equal(f.wire.length, 2);
  },
);

test(
  "official stdio cancellation after real Text extraction discards post scopes and isolates another explicit project",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      document = textSource(f.base, "1.1");
    const initial = document.apis[1].request.post_tasks;
    document.apis[1].request.post_tasks = [
      initial[0],
      initial[1],
      task(
        "cancel-marker",
        "customScript",
        `let finished=false;setTimeout(()=>pm.sendRequest(${JSON.stringify(f.base + "/waiting-text")}+"?finished="+finished,()=>{}),50);`,
      ),
      task("cancel-wait", "wait", 1000),
      task(
        "late-after-wait",
        "customScript",
        'finished=true;pm.environment.set("afterWait","must-not-commit");',
      ),
      assertion("late Text still valid", "wire-text-", "includes"),
    ];
    const p = await f.seed(document),
      before = await f.store.get(p.id),
      other = await f.seed(textSource(f.base, "1.1")),
      otherBefore = await f.store.get(other.id),
      client = await f.connect(p.id, "stdio"),
      plan = await sdkPlan(client, p, p.environments[0].id),
      controller = new AbortController();
    t.after(() => controller.abort());
    let settled = false;
    const pending = client.callTool(
      {
        name: "localapi_execute_flow",
        arguments: { projectId: p.id, planId: plan.id },
      },
      undefined,
      { signal: controller.signal },
    );
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitFor(() => {
      assert.equal(settled, false, "must observe the in-flight native wait");
      return f.wire.some(
        (entry) => entry.path === "/waiting-text?finished=false",
      );
    }, "public timer marker was not observed while Text post phase waited");
    // Marker HTTP is intentional evidence, not an absent side effect. The text
    // extraction already ran; no subsequent protected resource may be sent.
    assert.deepEqual(f.wire, [
      { path: "/login/selected", authorization: undefined },
      { path: "/waiting-text?finished=false", authorization: undefined },
    ]);
    const rejected = assert.rejects(pending, /abort|cancel/i);
    controller.abort();
    await rejected;
    let saved, cancelled;
    await waitFor(async () => {
      saved = await new Store(f.root).get(p.id);
      cancelled = saved.runs.find((entry) => entry.status === "cancelled");
      return Boolean(cancelled);
    }, "cancelled Text run was not durably recorded");
    assert.equal(cancelled.results.length, 1);
    assert.match(cancelled.results[0].error, /取消/);
    assert.equal(cancelled.results[0].response.status, 200);
    assert.equal(cancelled.results[0].response.body, "wire-text-1");
    assert.equal(cancelled.variables.token, "stale-token");
    const vars = saved.environments[0].variables;
    assert.equal(vars.beforeProof, "committed");
    assert.equal(vars.beforeCount, 1);
    assert.equal(vars.token, "stale-token");
    assert.equal(vars.postPending, "old-pending");
    assert.equal(vars.afterWait, undefined);
    assert.equal(vars.temporaryToken, undefined);
    assert.equal(saved.globalVariables.postGlobal, "old-global");
    assert.equal(saved.globalVariables.sharedToken, undefined);
    assert.deepEqual(saved.environments[1], before.environments[1]);
    assert.deepEqual(await f.store.get(other.id), otherBefore);
    await client.ping();
    const independent = await f.connect(other.id),
      otherPlan = await sdkPlan(independent, other, other.environments[0].id);
    const otherRun = decode(
      await invoke(independent, "localapi_execute_flow", {
        projectId: other.id,
        planId: otherPlan.id,
      }),
    );
    assertTextRun(otherRun, "wire-text-2");
    assert.deepEqual(await f.store.get(p.id), saved);
    assert.deepEqual(f.wire.slice(2), [
      { path: "/login/selected", authorization: undefined },
      { path: "/resource", authorization: "Bearer wire-text-2-view" },
    ]);
    await f.restart();
    assert.deepEqual(await new Store(f.root).get(p.id), saved);
    assert.equal(f.wire.length, 4, "restart must not replay cancelled work");
  },
);
