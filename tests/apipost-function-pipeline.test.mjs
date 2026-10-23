import test from "node:test";
import assert from "node:assert/strict";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";
import {
  validateApipostTemplateRequest,
  parseApipostFunctionTemplate,
} from "../public/apipost-function-template.js";
const fn = (name, body) => ({
  name,
  kind: "transform",
  body,
  apipostSource: { projectId: "fixture", id: name, description: "" },
});
test("exact source function pipelines pass typed output forward and retain synchronous failure input", async () => {
  const functions = [
    fn("fn_seed", 'return text+"-seed";'),
    fn("fn_upper", "return text.toUpperCase();"),
    fn("fn_fail", 'throw Error("fixture");'),
    fn("fn_length", "return text.length;"),
    fn("fn_typed", 'return typeof text+":"+text;'),
  ];
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{$function.fn_seed(raw)|fn_upper|fn_fail}}",
      functions,
      "headers",
    ),
    "RAW-SEED",
  );
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{$function.fn_seed(raw)|fn_length|fn_typed}}",
      functions,
      "body",
    ),
    "number:8",
  );
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{$function.fn_fail(raw)|fn_fail}}",
      functions,
      "body",
    ),
    "{{$function.fn_fail(raw)}}",
  );
});
test("source pipelines stay bounded and reject unsupported expressions before running", () => {
  for (const value of [
    "{{$function.fn_seed(raw)|unknown}}",
    "{{$function.fn_seed(raw)|fn_upper(arg)}}",
    "{{value.path|fn_upper}}",
    "{{$function.fn_seed(raw)|fn_upper|}}",
  ])
    assert.throws(() => parseApipostFunctionTemplate(value));
  const value = "{{$function.fn_seed(raw)|fn_a|fn_b|fn_c}}";
  assert.throws(
    () =>
      validateApipostTemplateRequest({
        query: Array.from({ length: 6 }, (_, i) => ({
          key: "q" + i,
          dynamic: { source: "apipost-function", value, functions: [] },
        })),
      }),
    /最多20/,
  );
});

test("pipeline stages cannot hide oversized or asynchronous intermediates behind later shrinking functions", async () => {
  for (const body of [
    'return "中".repeat(30000);',
    'JSON.stringify=()=>"";return "中".repeat(30000);',
    "Number.isFinite=()=>true;return Infinity;",
    "return Promise.resolve(text);",
    "return {value:text};",
  ])
    await assert.rejects(
      resolveApipostFunctionTemplate(
        "{{$function.fn_seed(raw)|fn_shrink}}",
        [fn("fn_seed", body), fn("fn_shrink", 'return "small";')],
        "body",
      ),
    );
  assert.throws(
    () =>
      parseApipostFunctionTemplate(
        "{{$function.fn_seed(raw)" + "|fn_seed".repeat(10) + "}}",
      ),
    /最多10/,
  );
});
test("modern custom pipelines import passively, preserve definitions and reach real HTTP", async (t) => {
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const { importIntoProject, runPlan } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const { environmentVariables, resolveServiceRequest } = await import(
    "../src/environments.mjs"
  );
  const http = await import("node:http");
  let hits = 0,
    received;
  const server = http.createServer((req, res) => {
    hits++;
    received = new URL(req.url, "http://fixture").searchParams.get("pipeline");
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const doc = modernApipostFixture();
  doc.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + server.address().port;
  doc.global.custom_func = [
    {
      func_id: "seed",
      func_name: "fn_seed",
      func_body: 'return text+"-seed";',
    },
    {
      func_id: "upper",
      func_name: "fn_upper",
      func_body: "return text.toUpperCase();",
    },
  ];
  const value = "{{$function.fn_seed(raw)|fn_upper}}";
  doc.apis[1].request.query.parameter = [
    { key: "pipeline", value, is_checked: 1 },
  ];
  const project = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
  importIntoProject(project, doc);
  assert.equal(hits, 0);
  assert.equal(project.requests[0].query[0].dynamic.value, value);
  const env = project.environments[0].id;
  const result = await runPlan(
    {
      functions: project.settings.functions,
      steps: [
        { request: resolveServiceRequest(project, project.requests[0], env) },
      ],
    },
    environmentVariables(project, env),
    executeRequest,
  );
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(received, "RAW-SEED");
  assert.equal(hits, 1);
  const bad = structuredClone(doc),
    before = structuredClone(project);
  bad.apis[1].request.query.parameter[0].value = value.replace(
    "fn_upper",
    "fn_missing",
  );
  assert.throws(() => importIntoProject(project, bad), /不存在/);
  assert.deepEqual(project, before);
});

test("empty parentheses in source pipeline stages preserve no-argument semantics", async () => {
  for (const expression of [
    "{{token|upper()|length()}}",
    "{{'hello'|upper()|length()}}",
    "{{$function.fn_seed(hello)|upper()|length()}}",
  ]) {
    assert.equal(
      await resolveApipostFunctionTemplate(
        expression,
        [fn("fn_seed", "return text;")],
        "body",
        { token: "hello" },
      ),
      5,
    );
  }
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{'hello'|fn_tail()|upper()}}",
      [fn("fn_tail", 'return text+"!";')],
      "body",
    ),
    "HELLO!",
  );
  for (const expression of [
    "{{token|upper(arg)}}",
    "{{token|upper(())}}",
    "{{token|upper(}}",
    "{{token|upper)}}",
    "{{token|unknown()}}",
    "{{token" + "|upper()".repeat(11) + "}}",
  ])
    assert.throws(() => parseApipostFunctionTemplate(expression));
});
