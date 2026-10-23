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
const expression = "{{$function.fn_form(raw)}}";
const spec = {
  source: "apipost-form-function",
  value: expression,
  functions: [],
};
const fn = (body) => ({
  name: "fn_form",
  kind: "transform",
  body,
  apipostSource: { projectId: "fixture", id: "form-fn", description: "" },
});
test("form templates preserve literal body characters and stay out of files and raw bodies", async () => {
  const value = "&+=#%\n{{literal}}";
  assert.equal(
    await resolveDynamicValue(spec, {}, [
      fn("return " + JSON.stringify(value) + ";"),
    ]),
    value,
  );
  for (const bodyType of ["urlencoded", "form-data"]) {
    const r = await resolveDynamicRequest(
      { bodyType, form: [{ key: "payload", type: "text", dynamic: spec }] },
      { literal: "wrong" },
      [fn("return " + JSON.stringify(value) + ";")],
      interpolate,
    );
    assert.equal(r.form[0].value, value);
    await assert.rejects(
      resolveDynamicRequest(
        { bodyType, form: [{ key: "file", type: "file", dynamic: spec }] },
        {},
        [fn("return text;")],
        interpolate,
      ),
      /文件|位置/,
    );
  }
  await assert.rejects(
    resolveDynamicRequest(
      { bodyType: "raw", form: [{ key: "x", dynamic: spec }] },
      {},
      [fn("return text;")],
      interpolate,
    ),
    /表单/,
  );
  assert.equal(
    await resolveDynamicValue(spec, {}, [fn('return "$&";')]),
    expression,
  );
});
test("modern text-form templates preserve literal values over real urlencoded and multipart HTTP", async (t) => {
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
      type: req.headers["content-type"],
      body: Buffer.concat(chunks).toString(),
    });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const value = "&+=#%\n{{literal}}";
  for (const mode of ["urlencoded", "form-data"]) {
    const d = modernApipostFixture();
    d.global.envs[0].server_list[0].uri =
      "http://127.0.0.1:" + server.address().port;
    d.global.custom_func = [
      {
        func_id: "form-fn",
        func_name: "fn_form",
        func_body: "return " + JSON.stringify(value) + ";",
      },
    ];
    d.apis[1].method = "POST";
    d.apis[1].request.body = {
      mode,
      parameter: [
        {
          key: "payload",
          value: expression,
          is_checked: 1,
          field_type: "String",
        },
      ],
    };
    const p = {
      requests: [],
      folders: [],
      environments: [],
      servers: [],
      globalVariables: {},
      settings: { statuses: [] },
    };
    const before = seen.length;
    importIntoProject(p, d);
    assert.equal(seen.length, before);
    assert.deepEqual(p.requests[0].form[0].dynamic, spec);
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
  }
  assert.equal(new URLSearchParams(seen[0].body).get("payload"), value);
  assert.match(seen[1].type, /multipart\/form-data/);
  assert(seen[1].body.includes('name="payload"\r\n\r\n' + value + "\r\n"));
});

test("file and inactive source modes cannot discard function dependencies during import", () => {
  const base = modernApipostFixture();
  base.global.custom_func = [
    { func_id: "form-fn", func_name: "fn_form", func_body: "return text;" },
  ];
  for (const [mode, type] of [
    ["form-data", "file"],
    ["urlencoded", "File"],
    ["none", "text"],
    ["raw", "text"],
  ]) {
    const d = structuredClone(base);
    d.apis[1].request.body = {
      mode,
      parameter: [{ key: "payload", value: expression, is_checked: 1, type }],
    };
    const p = {
        requests: [],
        folders: [],
        environments: [],
        servers: [],
        globalVariables: {},
        settings: { statuses: [] },
      },
      before = structuredClone(p);
    assert.throws(() => importIntoProject(p, d), /模板/);
    assert.deepEqual(p, before);
  }
});
test("form source snapshots retain mode and participate in the shared transformation budget", async () => {
  const { parseDynamicEdits, dynamicEditor } = await import(
    "../public/dynamic-editor.js"
  );
  const parsed = parseDynamicEdits({
    enabled: true,
    source: "apipost-form-function",
    value: expression,
    functions: "",
  });
  assert.deepEqual(parsed, spec);
  assert.match(
    dynamicEditor(parsed),
    /<option selected>apipost-form-function<\/option>/,
  );
  await assert.rejects(
    resolveDynamicRequest(
      {
        bodyType: "urlencoded",
        query: Array.from({ length: 20 }, (_, i) => ({
          key: "q" + i,
          dynamic: { ...spec, source: "apipost-function" },
        })),
        form: [{ key: "payload", dynamic: spec }],
      },
      {},
      [fn("return text;")],
      interpolate,
    ),
    /最多20/,
  );
});

test("native field_type File is never flattened into text and unimplemented per-part dependencies reject atomically", () => {
  const d = modernApipostFixture();
  d.apis[1].method = "POST";
  d.apis[1].request.body = {
    mode: "form-data",
    parameter: [
      {
        key: "upload",
        value: "/never-read/private.txt",
        field_type: "File",
        is_checked: 1,
      },
    ],
  };
  const p = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
  importIntoProject(p, d);
  assert.equal(p.requests[0].form[0].type, "file");
  assert.equal(p.requests[0].form[0].requiresFile, true);
  assert.equal(p.requests[0].form[0].filename, "private.txt");
  assert.equal(p.requests[0].form[0].value, "");
  assert.match(p.requests[0].importNotes.join("\n"), /重新选择文件/);
  const before = structuredClone(p);
  for (const change of [
    (x) => (x.apis[1].request.body.parameter[0].file_base64 = "aGVsbG8="),
    (x) => {
      x.apis[1].request.body.parameter[0].field_type = "String";
      x.apis[1].request.body.parameter[0].type = "file";
      x.apis[1].request.body.parameter[0].file_base64 = "aGVsbG8=";
    },
    (x) => {
      x.global.global_param.body.parameter = [
        {
          key: "inherited-file",
          value: "/never-read/global.txt",
          field_type: "File",
          is_checked: 1,
        },
      ];
    },
    (x) => {
      x.apis[1].request.body.parameter[0].field_type = "String";
      x.apis[1].request.body.parameter[0].content_type = "application/json";
    },
    (x) => {
      x.global.custom_func = [
        { func_id: "form-fn", func_name: "fn_form", func_body: "return text;" },
      ];
      x.apis[1].request.body.parameter[0].value = expression;
    },
  ]) {
    const bad = structuredClone(d);
    change(bad);
    assert.throws(() => importIntoProject(p, bad));
    assert.deepEqual(p, before);
  }
});
