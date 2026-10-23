import test from "node:test";
import assert from "node:assert/strict";
import { mergeApipostFunctions } from "../src/apipost-functions.mjs";
import { runScript } from "../src/scripts.mjs";
const source = (body) => [
  {
    func_id: "f",
    func_name: "fn_wrap",
    func_desc: "Source function",
    func_body: body,
  },
];
test("imported named functions run inside the existing VM and preserve source fallback semantics", async () => {
  const functions = mergeApipostFunctions(
    source('return "["+text+"]";'),
    [],
    "p",
    {},
  );
  const result = await runScript('apt.setVar("value",fn_wrap("hello"));', {
    functions,
    variables: {},
  });
  assert.equal(result.variables.value, "[hello]");
  const fallback = await runScript('apt.setVar("value",fn_wrap("input"));', {
    functions: mergeApipostFunctions(
      source('throw Error("source fallback");'),
      [],
      "p",
      {},
    ),
    variables: {},
  });
  assert.equal(fallback.variables.value, "input");
});
test("unsupported source function templates and duplicate names reject without mutation", () => {
  const existing = [{ name: "local", body: "return args[0];" }],
    before = structuredClone(existing);
  assert.throws(
    () =>
      mergeApipostFunctions(source("return text;"), existing, "p", {
        url: "{{$function.fn_wrap(hello)}}",
      }),
    /参数模板/,
  );
  assert.throws(
    () =>
      mergeApipostFunctions(source("return text;"), existing, "p", {
        body: "{{value| fn_wrap}}",
      }),
    /加工链/,
  );
  const duplicate = [
    ...source("return text;"),
    { func_name: "fn_WRAP", func_body: "return text;" },
  ];
  assert.throws(
    () => mergeApipostFunctions(duplicate, existing, "p", {}),
    /重复/,
  );
  assert.deepEqual(existing, before);
});

test("imported function execution keeps VM access and activity limits", async () => {
  const functions = mergeApipostFunctions(
    source("return typeof process;"),
    [],
    "p",
    {},
  );
  const r = await runScript('apt.setVar("value",fn_wrap("hello"));', {
    functions,
    variables: {},
  });
  assert.equal(r.variables.value, "undefined");
  for (const name of ["node:fs", "node:child_process"]) {
    const denied = await runScript('apt.setVar("value",fn_wrap("blocked"));', {
      functions: mergeApipostFunctions(
        source("return require(" + JSON.stringify(name) + ");"),
        [],
        "p",
        {},
      ),
      variables: {},
    });
    assert.equal(denied.variables.value, "blocked");
  }
  await assert.rejects(() =>
    runScript('await fn_wrap("input");', {
      functions: mergeApipostFunctions(
        source('return Promise.reject(Error("async failure"));'),
        [],
        "p",
        {},
      ),
      variables: {},
    }),
  );
  await assert.rejects(() =>
    runScript('fn_wrap("input");', {
      functions: mergeApipostFunctions(source("while(true) {}"), [], "p", {}),
      variables: {},
    }),
  );
  for (const bad of [
    "fn_bad);globalThis.injected=true;//",
    "constructor",
    "fn_",
    "fn_" + "x".repeat(200),
  ])
    assert.throws(() =>
      mergeApipostFunctions(
        [{ func_name: bad, func_body: "return text;" }],
        [],
        "p",
        {},
      ),
    );
  assert.throws(
    () =>
      mergeApipostFunctions(
        [{ ...source("return text;")[0], project_id: "other" }],
        [],
        "p",
        {},
      ),
    /来源/,
  );
});

test("imported source functions reach real HTTP and case snapshots do not follow later library edits", async (t) => {
  const { importIntoProject, runPlan } = await import("../src/core.mjs");
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const { resolveServiceRequest, environmentVariables } = await import(
    "../src/environments.mjs"
  );
  const { executeRequest } = await import("../src/runtime.mjs");
  const http = await import("node:http");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers["x-shared"]);
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const d = modernApipostFixture();
  d.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + server.address().port;
  d.global.custom_func = source('return "["+text+"]";');
  const task = (text) => ({
    type: "customScript",
    id: "function-call",
    name: "Call",
    enabled: 1,
    data: 'pm.setRequestHeader("X-Shared",fn_wrap("' + text + '"));',
  });
  d.apis[1].request.pre_tasks = [task("api")];
  d.samples = [
    {
      sample_id: "case",
      target_id: "api",
      parent_id: "0",
      type: "sample",
      name: "Case",
      method: "GET",
      url: "/case",
      request: {
        auth: { type: "noauth" },
        body: { mode: "none" },
        pre_tasks: [task("case")],
      },
      response: { example: [] },
    },
  ];
  const p = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
  importIntoProject(p, d);
  assert.deepEqual(seen, []);
  const env = p.environments[0].id;
  const run = await runPlan(
    {
      functions: p.settings.functions,
      steps: [{ request: resolveServiceRequest(p, p.requests[0], env) }],
    },
    environmentVariables(p, env),
    executeRequest,
  );
  assert.equal(run.status, "passed", JSON.stringify(run));
  p.settings.functions[0].body = 'return "changed";';
  const stored = p.cases[0];
  const caseRun = await runPlan(
    {
      functions: stored.functions,
      steps: [{ request: resolveServiceRequest(p, stored.request, env) }],
    },
    environmentVariables(p, env),
    executeRequest,
  );
  assert.equal(caseRun.status, "passed", JSON.stringify(caseRun));
  assert.deepEqual(seen, ["[api]", "[case]"]);
  const before = structuredClone(p),
    bad = structuredClone(d);
  bad.apis[1].url = "/{{$function.fn_wrap(unsafe)}}";
  assert.throws(() => importIntoProject(p, bad), /参数模板/);
  assert.deepEqual(p, before);
});

test("source function case snapshot expansion is bounded before target mutation", async () => {
  const { importIntoProject } = await import("../src/core.mjs"),
    { modernApipostFixture } = await import("./fixtures/apipost-modern.mjs");
  const d = modernApipostFixture();
  d.global.custom_func = source("return text;/*" + "x".repeat(100000) + "*/");
  d.samples = Array.from({ length: 50 }, (_, i) => ({
    sample_id: "case" + i,
    target_id: "api",
    parent_id: "0",
    name: "Case " + i,
    type: "sample",
    method: "GET",
    url: "/case",
    request: { auth: { type: "noauth" }, body: { mode: "none" } },
    response: { example: [] },
  }));
  const p = {
      requests: [],
      folders: [],
      environments: [],
      servers: [],
      globalVariables: {},
      settings: { statuses: [] },
    },
    before = structuredClone(p);
  assert.throws(() => importIntoProject(p, d), /函数快照.*4MiB/);
  assert.deepEqual(p, before);
});

test("source dependency scan rejects wide inputs with the explicit node budget before mutation", () => {
  const existing = [{ name: "local", body: "return args[0];" }],
    before = structuredClone(existing);
  assert.throws(
    () =>
      mergeApipostFunctions(
        source("return text;"),
        existing,
        "p",
        Array(200000).fill(null),
      ),
    (error) =>
      error.message === "Apipost共享函数依赖检查超过范围" &&
      !(error instanceof RangeError),
  );
  assert.deepEqual(existing, before);
  assert.equal(
    mergeApipostFunctions(
      source("return text;"),
      [],
      "p",
      Array(99999).fill(null),
    ).length,
    1,
  );
  assert.throws(
    () =>
      mergeApipostFunctions(
        source("return text;"),
        [],
        "p",
        Array(100000).fill(null),
      ),
    /依赖检查超过范围/,
  );
});
