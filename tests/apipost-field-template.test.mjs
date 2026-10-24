import test from "node:test";
import assert from "node:assert/strict";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";
import {
  parseApipostFunctionTemplate,
  validateApipostTemplateRequest,
} from "../public/apipost-function-template.js";
const fn = (body) => ({
  name: "fn_f",
  kind: "transform",
  body,
  apipostSource: { projectId: "fixture", id: "f", description: "" },
});

test("single embedded field expressions preserve literal prefixes and suffixes", async () => {
  assert.equal(
    await resolveApipostFunctionTemplate(
      "Bearer {{token|upper}}",
      [],
      "headers",
      { token: "abc" },
    ),
    "Bearer ABC",
  );
  assert.equal(
    await resolveApipostFunctionTemplate(
      '{"token":{"value":"{{token|upper}}"}}',
      [],
      "body",
      { token: "abc" },
    ),
    '{"token":{"value":"ABC"}}',
  );
  assert.equal(
    await resolveApipostFunctionTemplate("x{{token|number}}y", [], "form", {
      token: "42",
    }),
    "x42y",
  );
  const expression = "{{$function.fn_f(raw)}}",
    field = "prefix " + expression + " suffix";
  const replacement = "$`|$&|$'|$$|$1|{{literal}}";
  assert.equal(
    await resolveApipostFunctionTemplate(
      field,
      [fn("return " + JSON.stringify(replacement) + ";")],
      "body",
    ),
    field.replace(expression, replacement),
  );
  assert.equal(
    await resolveApipostFunctionTemplate(
      field,
      [fn('throw Error("fixture");')],
      "body",
    ),
    field,
  );
});

test("embedded templates keep Query and multiple-expression boundaries and bound replacement expansion", async () => {
  const value = "prefix {{token|upper}}";
  await assert.rejects(
    resolveApipostFunctionTemplate(value, [], "query", { token: "x" }),
    /Query/,
  );
  assert.throws(
    () =>
      validateApipostTemplateRequest({
        query: [
          {
            key: "q",
            dynamic: { source: "apipost-function", value, functions: [] },
          },
        ],
      }),
    /Query/,
  );
  for (const expression of [
    "{{token|upper}} {{token|lower}}",
    "prefix {{plain}}",
    "{{broken prefix {{token|upper}}",
  ])
    assert.throws(() => parseApipostFunctionTemplate(expression));
  await assert.rejects(
    resolveApipostFunctionTemplate(
      "x".repeat(100) + "{{$function.fn_f(raw)}}",
      [fn('return "$`".repeat(1000);')],
      "body",
    ),
    /64KiB/,
  );
});

test("modern Header and body prefixes import passively while Query prefixes stay atomic failures", async () => {
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const { importIntoProject } = await import("../src/core.mjs");
  const doc = modernApipostFixture();
  doc.global.custom_func = [];
  doc.apis[1].request.header.parameter[0].value = "Bearer {{shared|upper}}";
  doc.apis[1].request.body = {
    mode: "plain",
    raw: "prefix {{shared|upper}} suffix",
  };
  const project = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
  importIntoProject(project, doc);
  assert.equal(
    project.requests[0].headers.find((r) => r.key.toLowerCase() === "x-test")
      .dynamic.value,
    "Bearer {{shared|upper}}",
  );
  assert.equal(
    project.requests[0].bodyDynamic.apipost_body.value,
    "prefix {{shared|upper}} suffix",
  );
  const before = structuredClone(project);
  doc.apis[1].request.query.parameter[0].value = "prefix {{shared|upper}}";
  assert.throws(() => importIntoProject(project, doc));
  assert.deepEqual(project, before);
});

test("unchanged embedded fallback still checks complete serialized field bounds", async () => {
  await assert.rejects(
    resolveApipostFunctionTemplate(
      '"'.repeat(40000) + "{{$function.fn_f(raw)}}",
      [fn('throw Error("fixture");')],
      "body",
    ),
    /64KiB/,
  );
});

test("embedded Header and both form encodings use updated pre-script scope over real HTTP", async (t) => {
  const http = await import("node:http");
  const { runPlan, normalizeRequest } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      header: req.headers["x-token"],
      type: req.headers["content-type"],
      body: Buffer.concat(chunks).toString(),
    });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dynamic = (source, value) => ({ source, value, functions: [] });
  for (const bodyType of ["urlencoded", "form-data"]) {
    const request = normalizeRequest({
      method: "POST",
      url: `http://127.0.0.1:${server.address().port}/`,
      bodyType,
      beforeScript:
        'apt.setVar("token","actual");apt.setVar("payload","&+=%中\\n");',
      headers: [
        {
          key: "x-token",
          enabled: true,
          value: "",
          dynamic: dynamic(
            "apipost-header-function",
            "Bearer {{token|upper}}!",
          ),
        },
      ],
      form: [
        {
          key: "payload",
          type: "text",
          enabled: true,
          value: "",
          dynamic: dynamic(
            "apipost-form-function",
            "prefix:{{payload|concat(end)}}:suffix",
          ),
        },
      ],
    });
    const run = await runPlan(
      { steps: [{ request }] },
      { token: "stale", payload: "stale" },
      executeRequest,
    );
    assert.equal(run.status, "passed", JSON.stringify(run));
  }
  assert.equal(seen.length, 2);
  for (const row of seen) assert.equal(row.header, "Bearer ACTUAL!");
  const value = "prefix:&+=%中\nend:suffix";
  assert.equal(new URLSearchParams(seen[0].body).get("payload"), value);
  assert.match(seen[1].type, /multipart\/form-data/);
  assert(seen[1].body.includes('name="payload"\r\n\r\n' + value + "\r\n"));
  const bad = normalizeRequest({
    method: "GET",
    url: `http://127.0.0.1:${server.address().port}/`,
    headers: [
      {
        key: "x-token",
        value: "",
        enabled: true,
        dynamic: dynamic("apipost-header-function", "Bearer {{token|upper}}!"),
      },
    ],
  });
  const run = await runPlan(
    { steps: [{ request: bad }] },
    { token: "bad\r\nInjected: yes" },
    executeRequest,
  );
  assert.equal(run.status, "failed");
  assert.equal(seen.length, 2, "invalid Header must not reach transport");
});
