import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveDynamicValue,
  resolveDynamicRequest,
} from "../src/dynamic-values.mjs";
import {
  importIntoProject,
  interpolate,
  runPlan,
  toCurl,
  exportOpenAPI,
} from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const fn = (body) => ({
  name: "fn_header",
  kind: "transform",
  body,
  apipostSource: { projectId: "fixture", id: "h", description: "" },
});
const spec = (value) => ({
  source: "apipost-header-function",
  value,
  functions: [],
});
const expression = "{{$function.fn_HEADER(abc)}}";
test("Header source functions retain header literals without adopting Query URL substitution", async () => {
  const value = "Bearer abc+/=%#?&";
  assert.equal(
    await resolveDynamicValue(spec(expression), {}, [
      fn("return " + JSON.stringify(value) + ";"),
    ]),
    value,
  );
  assert.equal(
    await resolveDynamicValue(spec(expression), {}, [
      fn('throw Error("fallback");'),
    ]),
    expression,
  );
  for (const value of ["line\r\nInjected: yes"])
    await assert.rejects(
      resolveDynamicValue(spec(expression), {}, [
        fn("return " + JSON.stringify(value) + ";"),
      ]),
    );
  assert.equal(
    await resolveDynamicValue(spec(expression), {}, [fn('return "$&";')]),
    expression,
  );
  assert.equal(
    await resolveDynamicValue(spec(expression), {}, [fn('return "$5";')]),
    "$5",
  );
  await assert.rejects(
    resolveDynamicRequest(
      { query: [{ key: "q", dynamic: spec(expression) }] },
      {},
      [fn("return text;")],
      interpolate,
    ),
    /Header|位置|参数/,
  );
  await assert.rejects(
    resolveDynamicRequest(
      {
        headers: [{ key: "x", dynamic: spec(expression) }],
        beforeScript: 'apt.setVar("side",1);',
      },
      {},
      [fn("return text;")],
      interpolate,
    ),
    /脚本/,
  );
});
test("modern Header templates import without execution and reach actual HTTP unchanged", async (t) => {
  const http = await import("node:http");
  const { executeRequest } = await import("../src/runtime.mjs");
  const { environmentVariables, resolveServiceRequest } = await import(
    "../src/environments.mjs"
  );
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers["x-test"]);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const d = modernApipostFixture();
  d.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + server.address().port;
  d.global.custom_func = [
    {
      func_id: "h",
      func_name: "fn_header",
      func_body: 'return "Bearer "+text+"+/=%#?&";',
    },
  ];
  d.apis[1].request.header.parameter[0].value = expression;
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
  assert.deepEqual(p.requests[0].headers[0].dynamic, spec(expression));
  assert.throws(() => toCurl(p.requests[0]), /函数模板/);
  assert.throws(() => exportOpenAPI(p), /函数模板/);
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
  assert.deepEqual(seen, ["Bearer abc+/=%#?&"]);
  const bad = structuredClone(d),
    before = structuredClone(p);
  bad.apis[1].request.header.parameter[0].value = "prefix " + expression;
  assert.throws(() => importIntoProject(p, bad));
  assert.deepEqual(p, before);
});

test("Header and Query sources share budgets and stay distinct in snapshot editing", async () => {
  const { parseDynamicEdits, dynamicEditor } = await import(
    "../public/dynamic-editor.js"
  );
  const parsed = parseDynamicEdits({
    enabled: true,
    source: "apipost-header-function",
    value: expression,
    functions: "",
  });
  assert.deepEqual(parsed, spec(expression));
  assert.match(
    dynamicEditor(parsed),
    /<option selected>apipost-header-function<\/option>/,
  );
  await assert.rejects(
    resolveDynamicRequest(
      {
        body: "{{@value:x}}",
        bodyDynamic: { x: { ...spec(expression), format: "text" } },
      },
      {},
      [fn("return text;")],
      interpolate,
    ),
    /Query\/Header/,
  );
  await assert.rejects(
    resolveDynamicRequest(
      {
        query: Array.from({ length: 20 }, (_, i) => ({
          key: "q" + i,
          dynamic: {
            source: "apipost-function",
            value: expression,
            functions: [],
          },
        })),
        headers: [{ key: "x", dynamic: spec(expression) }],
      },
      {},
      [fn("return text;")],
      interpolate,
    ),
    /最多20/,
  );
  const value = "{{literal}}";
  const r = await resolveDynamicRequest(
    { headers: [{ key: "x", dynamic: spec(expression) }] },
    { literal: "wrong" },
    [fn("return " + JSON.stringify(value) + ";")],
    interpolate,
  );
  assert.equal(r.headers[0].value, value);
});
