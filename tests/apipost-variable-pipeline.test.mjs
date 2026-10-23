import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveDynamicValue,
  resolveDynamicRequest,
} from "../src/dynamic-values.mjs";
import { interpolate } from "../src/core.mjs";
const spec = (value) => ({
  source: "apipost-body-function",
  value,
  functions: [],
  format: "text",
});
test("source pipelines can start from own primitive variables or raw quoted literals", async () => {
  for (const [value, variables, expected] of [
    ["{{token|upper}}", { token: "hello" }, "HELLO"],
    ["{{count|number}}", { count: "0x10" }, 16],
    ["{{flag|number}}", { flag: false }, 0],
    ["{{negative|lower}}", { negative: -0 }, "-0"],
    ["{{missing|upper}}", {}, "{{MISSING}}"],
    ['{{"a\\nb"|upper}}', {}, "A\\NB"],
    ["{{'AbC'|lower}}", {}, "abc"],
    ["{{token|length}}", { token: "A😀" }, 2],
  ])
    assert.equal(
      await resolveDynamicValue(spec(value), variables, []),
      expected,
    );
  const request = {
    bodyType: "raw",
    body: "{{@value:source}}",
    bodyDynamic: { source: spec("{{token|lower}}") },
  };
  assert.equal(
    (
      await resolveDynamicRequest(
        request,
        { token: "{{LITERAL}}", literal: "wrong" },
        [],
        interpolate,
      )
    ).body,
    "{{literal}}",
  );
});
test("variable pipelines reject structured inputs, unsafe names and excess transforms without evaluating getters", async () => {
  for (const value of [{ a: 1 }, [1], Infinity])
    await assert.rejects(
      resolveDynamicValue(spec("{{token|upper}}"), { token: value }, []),
    );
  for (const value of [
    "{{__proto__|upper}}",
    "{{constructor|upper}}",
    "{{token.path|upper}}",
  ])
    await assert.rejects(resolveDynamicValue(spec(value), {}, []));
  let reads = 0;
  const variables = {};
  Object.defineProperty(variables, "token", {
    get() {
      reads++;
      return "secret";
    },
    enumerable: true,
  });
  await assert.rejects(
    resolveDynamicValue(spec("{{token|upper}}"), variables, []),
  );
  assert.equal(reads, 0);
});

test("modern variable and literal pipelines import without a function registry and use selected environment values over real HTTP", async (t) => {
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const { importIntoProject, runPlan } = await import("../src/core.mjs");
  const { environmentVariables, resolveServiceRequest } = await import(
    "../src/environments.mjs"
  );
  const { executeRequest } = await import("../src/runtime.mjs");
  const http = await import("node:http");
  let seen;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen = {
      q: new URL(req.url, "http://fixture").searchParams.get("q"),
      body,
    };
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const doc = modernApipostFixture();
  doc.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + server.address().port;
  doc.global.envs[0].env_var_list.shared = {
    value: "environment",
    current_value: "env-value",
  };
  doc.apis[1].request.query.parameter[0].value = "{{shared|upper}}";
  doc.apis[1].method = "POST";
  doc.apis[1].request.body = { mode: "raw", raw: "{{'raw\\ntext'|upper}}" };
  const p = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
  importIntoProject(p, doc);
  assert.equal(seen, undefined);
  assert.deepEqual(p.settings.functions, []);
  assert.equal(p.requests[0].query[0].dynamic.value, "{{shared|upper}}");
  const env = p.environments[0].id;
  const r = await runPlan(
    {
      functions: p.settings.functions,
      steps: [{ request: resolveServiceRequest(p, p.requests[0], env) }],
    },
    environmentVariables(p, env),
    executeRequest,
  );
  assert.equal(r.status, "passed", JSON.stringify(r));
  assert.deepEqual(seen, { q: "ENV-VALUE", body: "RAW\\NTEXT" });
  for (const extra of [
    "prefix {{shared|upper}}",
    "{{shared.path|upper}}",
    "{{shared|fn_missing}}",
  ]) {
    const bad = structuredClone(doc),
      before = structuredClone(p);
    bad.apis[1].request.query.parameter[0].value = extra;
    assert.throws(() => importIntoProject(p, bad));
    assert.deepEqual(p, before);
  }
  const bad = structuredClone(doc),
    before = structuredClone(p);
  bad.global.global_vars.unsupported = {
    value: "{{shared|upper}}",
    current_value: "{{shared|upper}}",
  };
  assert.throws(() => importIntoProject(p, bad));
  assert.deepEqual(p, before);
});
test("native variable pipelines preserve total transform caps and custom-stage lookup", async () => {
  const functions = [
    {
      name: "fn_wrap",
      kind: "transform",
      body: 'return "["+text+"]";',
      apipostSource: { projectId: "fixture", id: "wrap", description: "" },
    },
  ];
  assert.equal(
    await resolveDynamicValue(
      spec("{{token|fn_wrap|upper}}"),
      { token: "value" },
      functions,
    ),
    "[VALUE]",
  );
  const { validateApipostTemplateRequest } = await import(
    "../public/apipost-function-template.js"
  );
  const value = "{{token" + "|upper".repeat(10) + "}}";
  assert.doesNotThrow(() =>
    validateApipostTemplateRequest({
      query: Array.from({ length: 2 }, (_, i) => ({
        key: "q" + i,
        dynamic: { source: "apipost-function", value, functions: [] },
      })),
    }),
  );
  assert.throws(
    () =>
      validateApipostTemplateRequest({
        query: Array.from({ length: 3 }, (_, i) => ({
          key: "q" + i,
          dynamic: { source: "apipost-function", value, functions: [] },
        })),
      }),
    /最多20/,
  );
});

test("builtin pipeline text returned by a function stays inert during import and resolution", async () => {
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const { importIntoProject } = await import("../src/core.mjs");
  const doc = modernApipostFixture();
  doc.global.custom_func = [
    {
      func_id: "literal",
      func_name: "fn_literal",
      func_body: 'return "{{data|upper}}";',
    },
  ];
  doc.apis[1].request.query.parameter[0].value =
    "{{$function.fn_literal(raw)}}";
  const p = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
  importIntoProject(p, doc);
  assert.equal(
    await resolveDynamicValue(
      spec("{{$function.fn_literal(raw)}}"),
      { data: "wrong" },
      p.settings.functions,
    ),
    "{{data|upper}}",
  );
});
