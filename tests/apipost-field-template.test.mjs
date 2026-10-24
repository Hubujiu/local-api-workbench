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
