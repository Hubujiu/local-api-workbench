import test from "node:test";
import assert from "node:assert/strict";
import {
  importIntoProject,
  interpolate,
  runPlan,
  toCurl,
  exportOpenAPI,
} from "../src/core.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const expression = "{{$function.fn_body(raw)}}";
const spec = {
  source: "apipost-body-function",
  value: expression,
  functions: [],
  format: "text",
};
const request = {
  bodyType: "json",
  body: "{{@value:apipost_body}}",
  bodyDynamic: { apipost_body: spec },
};
const fn = (body) => ({
  name: "fn_body",
  kind: "transform",
  body,
  apipostSource: { projectId: "fixture", id: "body-fn", description: "" },
});
test("raw-body templates occupy the whole body and insert function output literally", async () => {
  const body = '{"literal":"{{literal}}","price":"$5"}';
  const resolved = await resolveDynamicRequest(
    request,
    { literal: "wrong" },
    [fn("return " + JSON.stringify(body) + ";")],
    interpolate,
  );
  assert.equal(resolved.body, body);
  for (const change of [
    { body: "prefix " + request.body },
    { bodyType: "binary" },
    { bodyDynamic: { apipost_body: { ...spec, format: "json" } } },
    { beforeScript: 'apt.setVar("bad",1);' },
  ])
    await assert.rejects(
      resolveDynamicRequest(
        { ...request, ...change },
        {},
        [fn('return "x";')],
        interpolate,
      ),
    );
  await assert.rejects(
    resolveDynamicRequest(request, {}, [fn('return "x";')], interpolate, {
      body: "override",
    }),
    /正文/,
  );
  await assert.rejects(
    resolveDynamicRequest(
      {
        ...request,
        query: Array.from({ length: 20 }, (_, i) => ({
          key: "q" + i,
          dynamic: {
            source: "apipost-function",
            value: expression,
            functions: [],
          },
        })),
      },
      {},
      [fn('return "x";')],
      interpolate,
    ),
    /最多20/,
  );
});
test("modern whole JSON and plain body templates import atomically and reach real HTTP", async (t) => {
  const http = await import("node:http");
  const { executeRequest } = await import("../src/runtime.mjs");
  const { environmentVariables, resolveServiceRequest } = await import(
    "../src/environments.mjs"
  );
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      body: Buffer.concat(chunks).toString(),
      contentType: req.headers["content-type"],
    });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const expected = '{"input":"raw","literal":"{{literal}}","price":"$5"}';
  for (const mode of ["json", "plain"]) {
    const d = modernApipostFixture();
    d.global.envs[0].server_list[0].uri =
      "http://127.0.0.1:" + server.address().port;
    d.global.custom_func = [
      {
        func_id: "body-fn",
        func_name: "fn_body",
        func_body:
          'return JSON.stringify({input:text,literal:"{{literal}}",price:"$5"});',
      },
    ];
    d.apis[1].method = "POST";
    d.apis[1].request.body = { mode, raw: expression };
    const p = {
      requests: [],
      folders: [],
      environments: [],
      servers: [],
      globalVariables: {},
      settings: { statuses: [] },
    };
    const count = seen.length;
    importIntoProject(p, d);
    assert.equal(seen.length, count);
    assert.deepEqual(p.requests[0].bodyDynamic, { apipost_body: spec });
    assert.equal(p.requests[0].body, request.body);
    assert.throws(() => toCurl(p.requests[0]), /函数模板/);
    assert.throws(() => exportOpenAPI(p), /函数模板/);
    const env = p.environments[0].id;
    const run = await runPlan(
      {
        functions: p.settings.functions,
        steps: [{ request: resolveServiceRequest(p, p.requests[0], env) }],
      },
      { ...environmentVariables(p, env), literal: "wrong" },
      executeRequest,
    );
    assert.equal(run.status, "passed", JSON.stringify(run));
    for (const raw of [
      "prefix " + expression,
      '{"nested":"' + expression + '"}',
    ]) {
      const bad = structuredClone(d),
        before = structuredClone(p);
      bad.apis[1].request.body.raw = raw;
      assert.throws(() => importIntoProject(p, bad));
      assert.deepEqual(p, before);
    }
  }
  assert.deepEqual(
    seen.map((x) => x.body),
    [expected, expected],
  );
  assert.match(seen[0].contentType, /application\/json/);
  assert.match(seen[1].contentType, /text\/plain/);
});
