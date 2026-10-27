// Independent combined comparator acceptance. Fictional native
// fixtures, real SDK transports, CLI, sockets and owned filesystem faults.
// No original executable, account or separately scoped intrinsic audit is used.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
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
const script = (id, data) => task(id, "customScript", data);
const unary = new Set(["null", "notnull", "exist", "notexist"]);
const assertion = (name, type, path, compareType, compareValue, enabled = 1) =>
  task(
    name,
    "assert",
    {
      type,
      expression: {
        ...(path === undefined ? {} : { path }),
        compareType,
        ...(compareValue === undefined ? {} : { compareValue }),
      },
    },
    enabled,
  );
const json = (name, path, comparison, expected) =>
  assertion(name, "responseJson", path, comparison, expected);
const pick = (enabled = 1) =>
  task(
    "token extraction",
    "pickVars",
    {
      source: "responseJson",
      variables: [{ name: "token", type: "envVars", expression: "$.token" }],
    },
    enabled,
  );
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const invoke = (client, name, args) =>
  client.callTool({ name, arguments: args });
const forge =
  'for(const entry of tests)entry.passed=true;tests.length=0;tests.push({name:"forged success",passed:true});';
function sourceFor(base, version = "1.1") {
  const source = modernApipostFixture();
  source.global.envs = [];
  source.global.servers = [];
  source.global.global_vars = {};
  const prototype = structuredClone(source.apis[1]);
  source.apis.length = 1;
  const add = (id, url, after, before = []) => {
    const api = structuredClone(prototype);
    api.target_id = id;
    api.name = id;
    api.protocol = version === "2" ? "http/2" : "http/1.1";
    api.url = base + url;
    api.request.query.parameter = [];
    api.request.header.parameter = [];
    api.request.pre_tasks = before;
    api.request.post_tasks = after;
    if (id === "text")
      api.request.auth = { type: "bearer", bearer: { key: "{{token}}" } };
    assert(after.length <= 16, "fixture must preserve production task cap");
    source.apis.push(api);
  };
  add(
    "numbers",
    "/numbers/{{tenant}}",
    [
      assertion("Code lt", "responseCode", "", "lt", "300"),
      assertion("Code lte", "responseCode", "", "lte", "200"),
      assertion("Header gt", "responseHeader", "X-NUM", "gt", "9"),
      assertion("Header gte", "responseHeader", "x-num", "gte", "10"),
      json("binary conversion", "$.binary", "gte", "3"),
      json("octal conversion", "$.octal", "lte", "8"),
      json("hex conversion", "$.hex", "gt", "15"),
      json("whitespace numeric zero", "$.space", "lte", "0"),
      json("string positive Infinity", "$.inf", "gt", "1e308"),
      json("string negative Infinity", "$.neg", "lt", "-1e308"),
      json("empty is null", "$.empty", "null"),
      json("null is notnull", "$.nil", "notnull"),
      json("null does not exist", "$.nil", "notexist"),
      json("false exists", "$.no", "exist"),
      pick(),
      script(
        "numbers commit",
        'pm.environment.set("derived","derived:"+pm.environment.get("token"));' +
          forge,
      ),
    ],
    [
      script(
        "before",
        'pm.environment.set("beforeProof","committed");pm.environment.set("beforeCount",(pm.environment.get("beforeCount")||0)+1);',
      ),
    ],
  );
  add("collection", "/collection", [
    json("empty list has empty member", "$.empty", "belongscollection", ""),
    json("edge empty members", "$.empty", "belongscollection", ",red,"),
    json(
      "whitespace member exact",
      "$.space",
      "belongscollection",
      "red, blue",
    ),
    json(
      "whitespace is not trimmed",
      "$.space",
      "notbelongscollection",
      "red,blue",
    ),
    json(
      "comma candidate never one member",
      "$.comma",
      "notbelongscollection",
      "one,two",
    ),
    json(
      "quotes are literal characters",
      "$.quoted",
      "belongscollection",
      '\"blue\",red',
    ),
    json(
      "quoted list not CSV",
      "$.plain",
      "notbelongscollection",
      '\"blue\",red',
    ),
    json(
      "quoted comma not CSV",
      "$.comma",
      "notbelongscollection",
      '\"one,two\"',
    ),
    json("false string member", "$.no", "belongscollection", "true,false"),
    json(
      "undefined string member",
      "$.missing",
      "belongscollection",
      "undefined,other",
    ),
    json("missing notexist", "$.missing", "notexist"),
    json("missing string notnull", "$.missing", "notnull"),
    assertion(
      "missing Header notexist",
      "responseHeader",
      "x-absent",
      "notexist",
    ),
    assertion(
      "unary provided value retained",
      "responseHeader",
      "x-absent",
      "notexist",
      "ignored literal",
    ),
  ]);
  add("xml", "/xml", [
    assertion("XML eq", "responseXml", "string(/root/value)", "eq", "Alpha"),
    assertion("XML uneq", "responseXml", "string(/root/value)", "uneq", "Beta"),
    assertion(
      "XML includes",
      "responseXml",
      "string(/root/value)",
      "includes",
      "lph",
    ),
    assertion(
      "XML unincludes",
      "responseXml",
      "string(/root/value)",
      "unincludes",
      "alpha",
    ),
    assertion("XML empty null", "responseXml", "string(/root/empty)", "null"),
    assertion("XML exists", "responseXml", "string(/root/value)", "exist"),
    task("bounded wait", "wait", 10),
  ]);
  add("text", "/text", [
    assertion("Text eq", "responseText", undefined, "eq", " Alpha 雪 "),
    assertion(
      "Text uneq",
      "responseText",
      "{{DIAGNOSTIC_ONLY}}",
      "uneq",
      "Alpha",
    ),
    assertion("Text includes", "responseText", undefined, "includes", "雪"),
    assertion(
      "Text unincludes",
      "responseText",
      undefined,
      "unincludes",
      "alpha",
    ),
    assertion(
      "Text literal collection",
      "responseText",
      undefined,
      "belongscollection",
      "first, Alpha 雪 ,last",
    ),
    assertion("Text exists", "responseText", undefined, "exist"),
    assertion("Time nonnegative", "responseTime", undefined, "gte", "0"),
    assertion(
      "Time bounded transport",
      "responseTime",
      "{{METRIC_DIAGNOSTIC_ONLY}}",
      "lte",
      "20000",
    ),
    assertion(
      "Size counts Unicode bytes",
      "responseSize",
      undefined,
      "eq",
      String(Buffer.byteLength(" Alpha 雪 ")),
    ),
    script("numeric current Text", 'apt.response.setBody("16");'),
    assertion("expected hexadecimal", "responseText", undefined, "gte", "0x10"),
    assertion("expected binary", "responseText", undefined, "lte", "0b10000"),
    assertion("expected octal", "responseText", undefined, "gte", "0o20"),
    assertion("expected whitespace", "responseText", undefined, "gt", " \t "),
    assertion(
      "Size survives current body edit",
      "responseSize",
      undefined,
      "eq",
      String(Buffer.byteLength(" Alpha 雪 ")),
    ),
  ]);
  return source;
}
async function fixture(t, version = "1.1") {
  const root = await mkdtemp(path.join(tmpdir(), "native-comparator-entry-")),
    wire = [],
    responses = [],
    clients = [],
    sessions = new Set();
  const peer = version === "2" ? http2.createServer() : http.createServer();
  peer.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  peer.on("request", (req, res) => {
    wire.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader("x-num", "10");
    res.setHeader("x-choice", "blue");
    if (req.url === "/duplicate") res.setHeader("x-duplicate", ["one", "two"]);
    const body = req.url.startsWith("/numbers/")
      ? JSON.stringify({
          token: "wire-" + req.url.split("/").at(-1),
          binary: "0b11",
          octal: "0o10",
          hex: "0x10",
          space: " ",
          inf: "Infinity",
          neg: "-Infinity",
          empty: "",
          nil: null,
          no: false,
        })
      : req.url === "/collection"
        ? JSON.stringify({
            empty: "",
            space: " blue",
            plain: "blue",
            quoted: '\"blue\"',
            comma: "one,two",
            no: false,
          })
        : req.url === "/xml"
          ? "<root><value>Alpha</value><empty/></root>"
          : req.url === "/soft"
            ? JSON.stringify({ value: "NaN", nil: null, token: "fresh-token" })
            : req.url === "/object"
              ? '{"value":{}}'
              : req.url === "/array"
                ? '{"value":[]}'
                : req.url === "/nonfinite"
                  ? '{"value":1e999}'
                  : req.url === "/malformed"
                    ? "{not-json"
                    : req.url === "/text"
                      ? " Alpha 雪 "
                      : "fixture response";
    res.setHeader(
      "content-type",
      req.url === "/xml" ? "application/xml" : "application/json",
    );
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
    async import(document) {
      const p = await call("/api/projects", {
        name: "Comparator entrypoint fixture",
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
      };
      p.environments.push({
        id: "comparator-other-env",
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
        { name: "native-comparator-entrypoints", version: "1" },
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
        name: "Comparators to Bearer",
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
      failure = Error("Comparator CLI fixture timed out");
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
      Array.isArray(value) ? value.map(({ id, ...entry }) => entry) : value,
    ]),
  );
function unaryShape(requests) {
  let absent = 0,
    provided = 0;
  for (const request of requests)
    for (const entry of request.nativeTasks?.after ?? []) {
      if (
        entry.type !== "assert" ||
        !unary.has(entry.data.expression.compareType)
      )
        continue;
      if (entry.name === "unary provided value retained") {
        assert.equal(entry.data.expression.compareValue, "ignored literal");
        provided++;
      } else {
        assert(
          !Object.hasOwn(entry.data.expression, "compareValue"),
          entry.name,
        );
        absent++;
      }
    }
  assert.equal(absent, 10);
  assert.equal(provided, 1);
}
function successfulRun(run, names) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.equal(run.recordId, run.id);
  assert.equal(run.attemptedRecordId, run.id);
  assert.equal(run.results.length, 4);
  const records = run.results.flatMap((result) => result.assertions);
  for (const name of names)
    assert.equal(
      records.find((entry) => entry.name === name)?.passed,
      true,
      name,
    );
  assert.equal(run.variables.token, "wire-selected");
  assert.equal(run.variables.derived, "derived:wire-selected");
  assert.equal(run.results[3].request.auth.token, "wire-selected");
  assert.equal(run.results[3].response.body, " Alpha 雪 ");
  assert.equal(run.results[3].scriptResponse.body, "16");
  unaryShape(run.snapshot.steps.map((step) => step.request));
}
async function runFlow(client, p, plan) {
  return decode(
    await invoke(client, "localapi_execute_flow", {
      projectId: p.id,
      planId: plan.id,
    }),
  );
}
for (const [version, transport] of [
  ["1.1", "http"],
  ["2", "stdio"],
])
  test(
    `fourteen native comparators and seven sources survive HTTP/${version} official ${transport} SDK, CLI, export and restart`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t, version),
        source = sourceFor(f.base, version),
        untouched = structuredClone(source);
      const names = source.apis.flatMap((api) =>
        (api.request.post_tasks ?? [])
          .filter((entry) => entry.type === "assert")
          .map((entry) => entry.name),
      );
      assert.equal(names.length, 48);
      const comparisons = new Set(
        source.apis.flatMap((api) =>
          (api.request.post_tasks ?? [])
            .filter((entry) => entry.type === "assert")
            .map((entry) => entry.data.expression.compareType),
        ),
      );
      assert.deepEqual(
        [...comparisons].sort(),
        [
          "eq",
          "uneq",
          "includes",
          "unincludes",
          "lt",
          "lte",
          "gt",
          "gte",
          "null",
          "notnull",
          "exist",
          "notexist",
          "belongscollection",
          "notbelongscollection",
        ].sort(),
      );
      const original = await f.seed(source),
        originalBefore = await f.store.get(original.id);
      const exported = await f.call(
        `/api/projects/${original.id}/export?format=apipost`,
        undefined,
        "GET",
      );
      assert.equal(exported.status, 200, JSON.stringify(exported));
      const copy = await f.import(exported.value),
        selected = copy.environments.find(
          (env) => env.variables.tenant === "selected",
        ),
        unselected = copy.environments.find(
          (env) => env.variables.tenant === "other",
        );
      assert(selected && unselected);
      assert.deepEqual(
        copy.requests.map((r) => comparableTasks(r.nativeTasks)),
        original.requests.map((r) => comparableTasks(r.nativeTasks)),
      );
      unaryShape(copy.requests);
      const reader = await f.connect(copy.id, transport, {
        write: false,
        execute: false,
      });
      assert(
        !(await reader.listTools()).tools.some(
          (tool) => tool.name === "localapi_execute_flow",
        ),
      );
      assert.equal(
        (
          await invoke(reader, "localapi_execute_api", {
            projectId: copy.id,
            apiId: copy.requests[0].id,
          })
        ).isError,
        true,
      );
      const client = await f.connect(copy.id, transport),
        plan = await sdkPlan(client, copy, selected.id);
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
      const run = await runFlow(client, copy, plan);
      successfulRun(run, names);
      const expectedWire = [
        { path: "/numbers/selected", authorization: undefined },
        { path: "/collection", authorization: undefined },
        { path: "/xml", authorization: undefined },
        { path: "/text", authorization: "Bearer wire-selected" },
      ];
      assert.deepEqual(f.wire, expectedWire);
      const saved = await f.store.get(copy.id);
      assert.deepEqual(saved.runs[0].results, run.results);
      assert.deepEqual(
        saved.environments.find((env) => env.id === unselected.id),
        unselected,
      );
      // Native export happened before the frozen plan. Later live edits must not
      // change its 14 comparator semantics or unary own-property absence.
      saved.requests[0].nativeTasks.after.find(
        (entry) => entry.name === "binary conversion",
      ).data.expression.compareValue = "999";
      assert.equal(
        (await f.call(`/api/projects/${copy.id}`, saved, "PUT")).status,
        200,
      );
      const command = await cli(f.root, copy.id, plan.id);
      assert.equal(command.code, 0, command.stderr);
      assert.equal(command.signal, null);
      successfulRun(JSON.parse(command.stdout), names);
      assert.deepEqual(f.wire, [...expectedWire, ...expectedWire]);
      const stable = await f.store.get(copy.id),
        backup = await f.call(
          `/api/projects/${copy.id}/export`,
          undefined,
          "GET",
        );
      assert.equal(backup.status, 200);
      const restored = await f.call("/api/restore", { document: backup.value });
      assert.equal(restored.status, 201);
      await f.restart();
      assert.equal(f.wire.length, 8);
      const reread = await new Store(f.root).get(restored.value.id);
      assert.deepEqual(reread.runs, stable.runs);
      unaryShape(reread.plans[0].steps.map((step) => step.request));
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
      successfulRun(JSON.parse(again.stdout), names);
      assert.deepEqual(f.wire, [
        ...expectedWire,
        ...expectedWire,
        ...expectedWire,
      ]);
      const restarted = await new Store(f.root).get(restored.value.id);
      assert.equal(restarted.runs.length, 3);
      assert.deepEqual(restarted.plans[0].steps, plan.steps);
      assert.deepEqual(
        restarted.environments.find((env) => env.id === unselected.id),
        unselected,
      );
      assert.deepEqual(await f.store.get(copy.id), stable);
      assert.deepEqual(await f.store.get(original.id), originalBefore);
      assert.deepEqual(source, untouched);
    },
  );
function softSource(base, activePick = false) {
  const source = sourceFor(base);
  const first = source.apis[1],
    later = structuredClone(source.apis[4]);
  first.url = base + "/soft";
  first.request.post_tasks = [
    script(
      "post pending",
      'pm.environment.set("postPending","new");pm.globals.set("postGlobal","new");',
    ),
    pick(activePick ? 1 : 0),
    ...["lt", "lte", "gt", "gte"].map((op) =>
      json("NaN " + op, "$.value", op, "0"),
    ),
    json("raw null is not empty", "$.nil", "null"),
    json("missing is not empty", "$.missing", "null"),
    json("null notnull asymmetric", "$.nil", "notnull"),
    json("missing notnull asymmetric", "$.missing", "notnull"),
    json("missing notexist", "$.missing", "notexist"),
    json("null does not exist false", "$.nil", "exist"),
    script(
      "after private failure",
      'pm.environment.set("followingTask","yes");pm.environment.set("token","fresh-token");' +
        forge,
    ),
  ];
  later.target_id = "later";
  later.name = "later";
  later.url = base + "/later";
  later.request.pre_tasks = [];
  later.request.post_tasks = [];
  source.apis = [source.apis[0], first, later];
  return source;
}
function softEvidence(run, activePick) {
  assert.equal(run.status, "failed", JSON.stringify(run));
  assert.equal(run.results.length, activePick ? 1 : 2);
  const first = run.results[0];
  assert.equal(first.response.status, 200);
  assert.equal(
    first.response.body,
    JSON.stringify({ value: "NaN", nil: null, token: "fresh-token" }),
  );
  assert.equal(
    first.error,
    activePick
      ? "原生响应提取阶段断言或原始响应状态失败，变量未提交"
      : undefined,
    "numeric NaN completes false assertions; only active pick adds the strict rollback policy error",
  );
  for (const name of [
    "NaN lt",
    "NaN lte",
    "NaN gt",
    "NaN gte",
    "raw null is not empty",
    "missing is not empty",
    "null does not exist false",
  ])
    assert.equal(
      first.assertions.find((entry) => entry.name === name)?.passed,
      false,
      name,
    );
  for (const name of [
    "null notnull asymmetric",
    "missing notnull asymmetric",
    "missing notexist",
  ])
    assert.equal(
      first.assertions.find((entry) => entry.name === name)?.passed,
      true,
      name,
    );
}
for (const activePick of [false, true])
  test(
    `numeric NaN and unary asymmetry keep private false evidence with ${activePick ? "strict active" : "soft disabled"} pick across SDK, CLI and backup`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t),
        p = await f.seed(softSource(f.base, activePick)),
        before = await f.store.get(p.id);
      const client = await f.connect(p.id, activePick ? "stdio" : "http"),
        plan = await sdkPlan(client, p, p.environments[0].id);
      const run = await runFlow(client, p, plan);
      softEvidence(run, activePick);
      assert.equal(run.recordSaved, true);
      const expectedWire = [
        { path: "/soft", authorization: undefined },
        ...(activePick
          ? []
          : [{ path: "/later", authorization: "Bearer fresh-token" }]),
      ];
      assert.deepEqual(f.wire, expectedWire);
      const stored = await f.store.get(p.id),
        vars = stored.environments[0].variables;
      assert.equal(vars.beforeProof, "committed");
      assert.equal(vars.beforeCount, 1);
      assert.equal(vars.token, activePick ? "stale-token" : "fresh-token");
      assert.equal(vars.postPending, activePick ? "old-pending" : "new");
      assert.equal(vars.followingTask, activePick ? undefined : "yes");
      assert.equal(
        stored.globalVariables.postGlobal,
        activePick ? "old-global" : "new",
      );
      assert.deepEqual(stored.environments[1], before.environments[1]);
      assert.deepEqual(stored.runs[0].results, run.results);
      const command = await cli(f.root, p.id, plan.id);
      assert.equal(command.code, 1, command.stderr);
      softEvidence(JSON.parse(command.stdout), activePick);
      assert.deepEqual(f.wire, [...expectedWire, ...expectedWire]);
      const saved = await f.store.get(p.id),
        backup = await f.call(`/api/projects/${p.id}/export`, undefined, "GET");
      assert.equal(backup.status, 200);
      const restored = await f.call("/api/restore", { document: backup.value });
      assert.equal(restored.status, 201);
      await f.restart();
      const reread = await new Store(f.root).get(restored.value.id);
      assert.deepEqual(reread.runs, saved.runs);
      for (const record of reread.runs) softEvidence(record, activePick);
      assert.equal(f.wire.length, expectedWire.length * 2);
    },
  );
const readFailures = [
  {
    name: "duplicate Header",
    route: "/duplicate",
    assertion: assertion(
      "ambiguous Header cannot be absent",
      "responseHeader",
      "x-duplicate",
      "notexist",
    ),
    error: /完整且唯一/,
  },
  {
    name: "missing XML node",
    route: "/xml",
    assertion: assertion(
      "XML reader cannot prove absence",
      "responseXml",
      "string(/root/missing)",
      "notexist",
    ),
    error: /恰好匹配一个节点/,
  },
  {
    name: "malformed JSON",
    route: "/malformed",
    assertion: json("parser failure is not absence", "$.missing", "notexist"),
    error: /严格JSON/,
  },
  {
    name: "object outside primitive domain",
    route: "/object",
    assertion: json("object cannot exist", "$.value", "exist"),
    error: /有限JSON原始值/,
  },
  {
    name: "array outside primitive domain",
    route: "/array",
    assertion: json("array cannot exist", "$.value", "exist"),
    error: /有限JSON原始值/,
  },
  {
    name: "nonfinite JSON number",
    route: "/nonfinite",
    assertion: json("nonfinite cannot compare", "$.value", "gte", "0"),
    error: /有限JSON原始值/,
  },
  {
    name: "own Header accessor",
    route: "/soft",
    prefix: script(
      "owned getter",
      'Object.defineProperty(response.headers,"x-num",{configurable:true,enumerable:true,get(){throw Error("COMPARATOR_HEADER_GETTER_MUST_NOT_RUN");}});',
    ),
    assertion: assertion(
      "getter cannot be absent",
      "responseHeader",
      "x-num",
      "notexist",
    ),
    error: /自有字符串/,
  },
];
test(
  "SDK absence comparisons do not swallow source read errors or widen the finite primitive domain",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    for (const sample of readFailures)
      await t.test(sample.name, async () => {
        const source = softSource(f.base, true),
          first = source.apis[1];
        first.url = f.base + sample.route;
        // Active extraction policy is determined by enabled AFTER tasks, even when
        // its late position is never reached due to an earlier source read error.
        first.request.post_tasks = [
          script("pending", 'pm.environment.set("postPending","new");'),
          ...(sample.prefix ? [sample.prefix] : []),
          sample.assertion,
          pick(),
          script("later marker", 'pm.environment.set("followingTask","yes");'),
        ];
        const p = await f.seed(source),
          before = await f.store.get(p.id),
          client = await f.connect(p.id),
          plan = await sdkPlan(client, p, p.environments[0].id),
          start = f.wire.length;
        const run = await runFlow(client, p, plan);
        assert.equal(run.status, "failed");
        assert.equal(run.recordSaved, true);
        assert.equal(run.results.length, 1);
        assert.match(run.results[0].error, sample.error);
        assert(
          !run.results[0].error.includes(
            "COMPARATOR_HEADER_GETTER_MUST_NOT_RUN",
          ),
        );
        assert.equal(run.results[0].response.status, 200);
        assert(
          !run.results[0].assertions.some(
            (entry) => entry.name === sample.assertion.name,
          ),
          "read errors cannot become completed true/false comparisons",
        );
        assert.deepEqual(f.wire.slice(start), [
          { path: sample.route, authorization: undefined },
        ]);
        const saved = await f.store.get(p.id);
        assert.equal(saved.environments[0].variables.token, "stale-token");
        assert.equal(
          saved.environments[0].variables.postPending,
          "old-pending",
        );
        assert.equal(saved.environments[0].variables.beforeProof, "committed");
        assert.equal(saved.environments[0].variables.followingTask, undefined);
        assert.deepEqual(saved.environments[1], before.environments[1]);
        assert.deepEqual(saved.runs[0].results, run.results);
        await client.close();
      });
  },
);
test(
  "raw comparator import rejects missing binary, templates, regex and invalid operands atomically with no execution",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.seed(softSource(f.base)),
      before = await f.store.get(p.id);
    for (const sample of [
      { name: "binary eq missing", expression: { compareType: "eq" } },
      { name: "binary numeric missing", expression: { compareType: "gte" } },
      {
        name: "binary disabled missing",
        expression: { compareType: "belongscollection" },
        enabled: 0,
      },
      {
        name: "enabled template",
        expression: { compareType: "gt", compareValue: "{{token}}" },
      },
      {
        name: "unary provided template",
        expression: { compareType: "exist", compareValue: "{{token}}" },
      },
      {
        name: "unknown",
        expression: { compareType: "bogus", compareValue: "x" },
      },
      {
        name: "regular expression",
        expression: { compareType: "regularmatch", compareValue: ".*" },
      },
      {
        name: "regex disabled",
        expression: { compareType: "regex", compareValue: "x" },
        enabled: 0,
      },
      {
        name: "object expected",
        expression: { compareType: "eq", compareValue: {} },
      },
      {
        name: "null expected",
        expression: { compareType: "notexist", compareValue: null },
      },
    ]) {
      const document = sourceFor(f.base);
      document.apis[1].request.post_tasks = [
        task(
          sample.name,
          "assert",
          { type: "responseText", expression: sample.expression },
          sample.enabled ?? 1,
        ),
      ];
      const rejected = await f.call(`/api/projects/${p.id}/import`, {
        document,
      });
      assert.equal(
        rejected.status,
        400,
        sample.name + ": " + JSON.stringify(rejected),
      );
      assert.deepEqual(await f.store.get(p.id), before, sample.name);
      assert.deepEqual(f.wire, []);
    }
  },
);
test(
  "private numeric false records survive a real final journal unknown and recover one attempted ID without network replay",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.seed(softSource(f.base)),
      other = await f.store.create("unrelated comparator receipt"),
      otherBefore = await f.store.get(other.id);
    const client = await f.connect(p.id),
      plan = await sdkPlan(client, p, p.environments[0].id),
      before = await f.store.get(p.id);
    const store = f.store,
      originalSave = store.save,
      originalRead = store.readUnlocked;
    const directory = store.directory(p.id),
      history = path.join(directory, "history"),
      kept = path.join(directory, "history-kept"),
      journalFile = path.join(directory, ".transaction.json");
    let attempts = 0,
      readState,
      observed;
    const restore = () => {
      store.save = originalSave;
      store.readUnlocked = originalRead;
    };
    t.after(restore);
    // Only arrange a real, test-owned filesystem obstacle after the original
    // locked read. Store.save, journal publication, apply and its error stay real.
    store.save = async function (value, options) {
      if (value.id !== p.id || !options?.activity)
        return originalSave.call(this, value, options);
      attempts++;
      this.readUnlocked = async function (id) {
        const state = await originalRead.call(this, id);
        readState = structuredClone(state);
        this.readUnlocked = originalRead;
        await rename(history, kept);
        await writeFile(history, "owned comparator record obstacle");
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
    const run = await runFlow(client, p, plan);
    restore();
    softEvidence(run, false);
    assert.equal(run.recordSaved, false);
    assert.equal(run.recordId, null);
    assert.equal(run.attemptedRecordId, run.id);
    assert.deepEqual(run.persistenceOutcome, {
      code: "PROJECT_COMMIT_UNCERTAIN",
      project_id: p.id,
      commit_outcome: "unknown",
      retry_safe: false,
    });
    assert.equal(
      run.results[0].scopeCommit,
      undefined,
      "confirmed post scope is separate from unknown final record persistence",
    );
    assert(observed instanceof ProjectCommitUncertain);
    assert.equal(attempts, 1);
    assert.equal(readState.environments[0].variables.token, "fresh-token");
    assert.equal(readState.environments[0].variables.beforeCount, 1);
    const receipt = JSON.stringify({
      error: run.persistenceError,
      outcome: run.persistenceOutcome,
    });
    for (const hidden of [
      f.root,
      JSON.stringify(f.root).slice(1, -1),
      "ENOTDIR",
      '"cause"',
      "owned comparator record obstacle",
    ])
      assert(!receipt.includes(hidden));
    assert.equal((await stat(history)).isFile(), true);
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    assert.equal(journal.revision, readState.revision + 1);
    assert.equal(journal.configRevision, readState.configRevision);
    assert.equal(journal.runs[0].id, run.attemptedRecordId);
    assert.deepEqual(journal.runs[0].results, run.results);
    softEvidence(journal.runs[0], false);
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "project.json"), "utf8"))
        .revision,
      readState.revision,
    );
    await assert.rejects(
      new Store(f.root).get(p.id),
      (error) => error instanceof ProjectCommitUncertain,
    );
    const expectedWire = [
      { path: "/soft", authorization: undefined },
      { path: "/later", authorization: "Bearer fresh-token" },
    ];
    assert.deepEqual(f.wire, expectedWire);
    assert.deepEqual(await f.store.get(other.id), otherBefore);
    await rm(history);
    await rename(kept, history);
    const recovered = await new Store(f.root).get(p.id);
    assert.equal(recovered.runs.length, before.runs.length + 1);
    assert.equal(recovered.runs[0].id, run.attemptedRecordId);
    assert.deepEqual(recovered.runs[0].results, run.results);
    softEvidence(recovered.runs[0], false);
    assert.equal(recovered.environments[0].variables.token, "fresh-token");
    assert.deepEqual(recovered.environments[1], before.environments[1]);
    await assert.rejects(readFile(journalFile), { code: "ENOENT" });
    await f.restart();
    const reader = await f.connect(p.id, "http", {
      write: false,
      execute: false,
    });
    const reconciled = decode(
      await invoke(reader, "localapi_get_run", {
        projectId: p.id,
        runId: run.attemptedRecordId,
      }),
    );
    softEvidence(reconciled, false);
    assert.equal(reconciled.id, run.attemptedRecordId);
    assert.deepEqual(await f.store.get(p.id), recovered);
    assert.deepEqual(await f.store.get(other.id), otherBefore);
    assert.deepEqual(f.wire, expectedWire);
    assert.equal(attempts, 1);
  },
);
async function inertSource(base) {
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
      script(
        "historical throw",
        'throw Error("historical {{HISTORY}} must not execute")',
      ),
    ];
    // Enabled raw tasks must first satisfy the active structural grammar. The
    // imported source archive then preserves all four omitted unary operands,
    // but none of those historical assertions is authorized to execute.
    step.api_snapshot.request.post_tasks = [
      ...[...unary].map((op) =>
        assertion("historical " + op, "responseText", "{{INERT_PATH}}", op),
      ),
      assertion(
        "historical disabled template",
        "responseText",
        undefined,
        "exist",
        "{{INERT_EXPECTED}}",
        0,
      ),
    ];
  }
  file.text = JSON.stringify(flow);
  return { format: "apipost-offline-directory-v1", files };
}
test(
  "all four operand-omitting unary flow provenance tasks remain inert in SDK, CLI and backup restart",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      document = await inertSource(f.base),
      untouched = structuredClone(document),
      created = await f.call("/api/projects", {
        name: "inert unary provenance",
      });
    assert.equal(created.status, 201);
    const initial = await f.store.get(created.value.id),
      invalid = structuredClone(document),
      file = invalid.files.find(
        (entry) => entry.path === "executions/flows/flow_1792937049044.json",
      ),
      flow = JSON.parse(file.text);
    flow.steps[0].api_snapshot.request.post_tasks[0].data.expression.compareType =
      "eq";
    file.text = JSON.stringify(flow);
    const rejected = await f.call(`/api/projects/${initial.id}/import`, {
      document: invalid,
    });
    assert.equal(rejected.status, 400);
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
    env.variables.INERT_EXPECTED = "not a value to expand";
    assert.equal((await f.call(`/api/projects/${p.id}`, p, "PUT")).status, 200);
    const histories = plan.steps.map((step) =>
      structuredClone(step.request.importedNativeTaskSource),
    );
    for (const [index, step] of plan.steps.entries()) {
      assert.equal(step.request.nativeTasks, undefined);
      assert.equal(step.request.beforeScript, "");
      assert.equal(step.request.afterScript, "");
      const entries = histories[index].after;
      assert.equal(entries.length, 5);
      assert.deepEqual(
        entries.slice(0, 4).map((entry) => entry.data.expression.compareType),
        [...unary],
      );
      for (const entry of entries.slice(0, 4)) {
        assert.equal(entry.enabled, 1);
        assert(!Object.hasOwn(entry.data.expression, "compareValue"));
        assert.equal(entry.data.expression.path, "{{INERT_PATH}}");
      }
      assert.equal(
        entries[4].data.expression.compareValue,
        "{{INERT_EXPECTED}}",
      );
      assert.equal(entries[4].enabled, 0);
    }
    const client = await f.connect(p.id),
      run = await runFlow(client, p, plan);
    const verify = (record) => {
      assert.equal(record.status, "passed", JSON.stringify(record));
      assert.equal(record.variables.token, "unchanged-inert-token");
      assert(
        record.results.every(
          (result) =>
            result.response.body === "fixture response" &&
            result.assertions.length === 0,
        ),
      );
      assert.deepEqual(
        record.snapshot.steps.map(
          (step) => step.request.importedNativeTaskSource,
        ),
        histories,
      );
    };
    verify(run);
    assert.equal(run.recordSaved, true);
    const command = await cli(f.root, p.id, plan.id);
    assert.equal(command.code, 0, command.stderr);
    verify(JSON.parse(command.stdout));
    const expectedWire = Array.from({ length: 4 }, () => ({
      path: "/inert?fixture=original",
      authorization: undefined,
    }));
    assert.deepEqual(f.wire, expectedWire);
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
    assert.deepEqual(reread.runs, saved.runs);
    for (const record of reread.runs) verify(record);
    assert.deepEqual(f.wire, expectedWire);
    assert.deepEqual(await f.store.get(p.id), saved);
    assert.deepEqual(document, untouched);
  },
);
