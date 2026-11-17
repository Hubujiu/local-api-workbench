import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveDynamicValue,
  resolveDynamicRequest,
} from "../src/dynamic-values.mjs";
import { interpolate, importIntoProject, runPlan } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const fn = (body) => ({
  name: "fn_wrap",
  kind: "transform",
  body,
  apipostSource: { projectId: "fixture", id: "f", description: "" },
});
const spec = (value) => ({ source: "apipost-function", value, functions: [] });
test("source function templates use raw arguments, case-insensitive lookup and distinct exception fallback", async () => {
  for (const arg of ["abc", '"abc"', "a,b"]) {
    const input = "{{$function.fn_WRAP(" + arg + ")}}";
    assert.equal(
      await resolveDynamicValue(spec(input), {}, [fn('return "["+text+"]";')]),
      "[" + arg + "]",
    );
    assert.equal(
      await resolveDynamicValue(spec(input), {}, [
        fn('throw Error("source failure");'),
      ]),
      input,
    );
  }
  assert.equal(
    await resolveDynamicValue(spec("{{$function.fn_wrap(x)}}"), {}, [
      fn('return "{{untouched}}";'),
    ]),
    "{{untouched}}",
  );
  for (const body of [
    'return Promise.resolve("x");',
    "return {};",
    "return NaN;",
    "return undefined;",
    "while(true){}",
    'Promise.resolve().then(()=>apt.setVar("functionTemplateResult", "late"));return "early";',
  ])
    await assert.rejects(
      resolveDynamicValue(spec("{{$function.fn_wrap(x)}}"), {}, [fn(body)]),
    );
  await assert.rejects(
    resolveDynamicValue(spec("{{$function.fn_missing(x)}}"), {}, [
      fn("return text;"),
    ]),
  );
  await assert.rejects(
    resolveDynamicValue(
      { ...spec("{{$function.fn_wrap(x)}}"), functions: ["fn_wrap"] },
      {},
      [fn("return text;")],
    ),
  );
});
test("query function templates resolve once and reject unverified combinations before transport", async () => {
  const request = {
    url: "http://example.test",
    query: [{ key: "q", value: "", dynamic: spec("{{$function.fn_wrap(x)}}") }],
  };
  const resolved = await resolveDynamicRequest(
    request,
    { untouched: "wrong" },
    [fn('return "{{untouched}}";')],
    interpolate,
  );
  assert.equal(resolved.query[0].value, "{{untouched}}");
  for (const change of [
    { beforeScript: 'apt.setRequestQuery("q","override");' },
    { scriptURLMode: "sdk" },
    { bodyDynamic: { x: { source: "fixed", value: "x", format: "text" } } },
    { headers: [{ key: "h", dynamic: { source: "fixed", value: 1 } }] },
  ]) {
    let sent = false;
    const outcome = await runPlan(
      {
        steps: [{ request: { ...request, ...change } }],
        functions: [fn("return text;")],
      },
      {},
      async () => {
        sent = true;
        return { status: 200, body: "", headers: {} };
      },
    );
    assert.equal(sent, false);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.variables.bad, undefined);
  }
});
test("modern import maps only exact enabled API Query templates atomically without execution", () => {
  const d = modernApipostFixture();
  d.global.custom_func = [
    { func_id: "f", func_name: "fn_wrap", func_body: 'return "["+text+"]";' },
  ];
  d.apis[1].request.query.parameter[0].value = "{{$function.fn_wrap(a,b)}}";
  const p = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
  importIntoProject(p, d);
  assert.deepEqual(
    p.requests[0].query[0].dynamic,
    spec("{{$function.fn_wrap(a,b)}}"),
  );
  for (const change of [
    (x) => {
      x.global.custom_func = [];
    },
    (x) => (x.apis[1].url = "/{{$function.fn_wrap(x)}}"),
    (x) =>
      (x.apis[1].request.query.parameter[0].value =
        "prefix {{$function.fn_wrap(x)}}"),
    (x) =>
      (x.apis[1].request.query.parameter[0].value =
        "{{$function.fn_missing(x)}}"),
    (x) =>
      (x.apis[1].request.pre_tasks = [
        {
          type: "wait",
          id: "s",
          name: "unsupported task",
          enabled: 1,
          data: "1",
        },
      ]),
  ]) {
    const bad = structuredClone(d),
      before = structuredClone(p);
    change(bad);
    assert.throws(() => importIntoProject(p, bad));
    assert.deepEqual(p, before);
  }
});

test("imported Query templates survive normalization and snapshots, reach real HTTP literally, and never execute during export", async (t) => {
  const { normalizeRequest, snapshotPlan, toCurl, exportOpenAPI } =
    await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const { environmentVariables, resolveServiceRequest } = await import(
    "../src/environments.mjs"
  );
  const http = await import("node:http");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(new URL(req.url, "http://fixture").searchParams.get("q"));
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const d = modernApipostFixture();
  d.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + server.address().port;
  d.global.custom_func = [
    { func_id: "f", func_name: "fn_wrap", func_body: 'return "{{literal}}";' },
  ];
  d.apis[1].request.query.parameter[0].value = '{{$function.fn_wrap("a,b")}}';
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
  const restored = JSON.parse(JSON.stringify(p));
  restored.requests[0] = normalizeRequest(restored.requests[0]);
  assert.deepEqual(
    restored.requests[0].query[0].dynamic,
    spec('{{$function.fn_wrap("a,b")}}'),
  );
  assert.throws(() => toCurl(restored.requests[0]), /函数模板/);
  assert.throws(() => exportOpenAPI(restored), /函数模板/);
  const env = restored.environments[0].id;
  const plan = snapshotPlan({
    functions: restored.settings.functions,
    steps: [
      { request: resolveServiceRequest(restored, restored.requests[0], env) },
    ],
  });
  restored.settings.functions[0].body = 'return "changed";';
  const result = await runPlan(
    plan,
    { ...environmentVariables(restored, env), literal: "wrong" },
    executeRequest,
  );
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.deepEqual(seen, ["{{literal}}"]);
});
test("Query template budgets, disabled values, VM authority and editor preservation are explicit", async () => {
  const { parseDynamicEdits, dynamicEditor } = await import(
    "../public/dynamic-editor.js"
  );
  const input = "{{$function.fn_wrap(unchanged)}}";
  const parsed = parseDynamicEdits({
    enabled: true,
    source: "apipost-function",
    value: input,
    functions: "",
  });
  assert.deepEqual(parsed, spec(input));
  assert.match(
    dynamicEditor(parsed),
    /<option selected>apipost-function<\/option>/,
  );
  assert.throws(
    () =>
      parseDynamicEdits({
        enabled: true,
        source: "apipost-function",
        value: input,
        functions: "fn_wrap",
      }),
    /加工链/,
  );
  await assert.rejects(
    resolveDynamicRequest(
      {
        body: "{{@value:x}}",
        bodyDynamic: { x: { ...spec(input), format: "text" } },
      },
      {},
      [fn("return text;")],
      interpolate,
    ),
    /仅支持Query/,
  );
  const disabled = await resolveDynamicRequest(
    { query: [{ key: "q", enabled: false, dynamic: spec(input) }] },
    {},
    [],
    interpolate,
  );
  assert.equal(disabled.query[0].dynamic, undefined);
  await assert.rejects(
    resolveDynamicRequest(
      {
        query: Array.from({ length: 21 }, (_, i) => ({
          key: "q" + i,
          dynamic: spec(input),
        })),
      },
      {},
      [fn("return text;")],
      interpolate,
    ),
    /最多20/,
  );
  assert.equal(
    await resolveDynamicValue(spec(input), {}, [fn("return typeof process;")]),
    "undefined",
  );
  assert.equal(
    await resolveDynamicValue(spec(input), {}, [
      fn('return require("node:fs");'),
    ]),
    input,
  );
  await assert.rejects(
    resolveDynamicValue(spec(input), {}, [fn('return "中".repeat(30000);')]),
  );
  for (const bad of [
    "{{$function.fn_wrap(a)|fn_wrap(arg)}}",
    "{{$function.fn_wrap({{a}})}}",
    "prefix " + input,
  ])
    await assert.rejects(
      resolveDynamicValue(spec(bad), {}, [fn("return text;")]),
    );
});

test("Query template results refuse ambiguous URL substitution and empty-equal semantics", async () => {
  const input = "{{$function.fn_wrap(x)}}";
  for (const output of [
    "a&other=b",
    "#fragment",
    "%2f",
    "a+b",
    "a=b",
    "?q",
    "$&",
    "$'",
    "line\nnext",
  ])
    await assert.rejects(
      resolveDynamicValue(spec(input), {}, [
        fn("return " + JSON.stringify(output) + ";"),
      ]),
      /分隔符或替换符/,
    );
  await assert.rejects(
    resolveDynamicRequest(
      { queryAddEqual: false, query: [{ key: "q", dynamic: spec(input) }] },
      {},
      [fn('return "";')],
      interpolate,
    ),
    /省略等号/,
  );
  const r = await resolveDynamicRequest(
    { queryAddEqual: true, query: [{ key: "q", dynamic: spec(input) }] },
    {},
    [fn('return "";')],
    interpolate,
  );
  assert.equal(r.query[0].value, "");
});
