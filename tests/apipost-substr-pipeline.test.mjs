import test from "node:test";
import assert from "node:assert/strict";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";
import { parseApipostFunctionTemplate } from "../public/apipost-function-template.js";

test("source substr stages use start and length with omitted length zero", async () => {
  for (const [suffix, expected] of [
    ["substr(1,3)", "bcd"],
    ["substr(-2,2)", "ef"],
    ["substr(2)", ""],
    ["substr()", ""],
    ["substr(0,-1)", ""],
    ["substr( 1 , 2 )", "bc"],
  ])
    assert.equal(
      await resolveApipostFunctionTemplate(
        "{{'abcdef'|" + suffix + "}}",
        [],
        "body",
      ),
      expected,
    );
  assert.equal(
    await resolveApipostFunctionTemplate("{{token|substr(0,2)}}", [], "body", {
      token: null,
    }),
    "nu",
  );
  for (const suffix of [
    "substr(1,2,3)",
    "substr(1.5,2)",
    "substr(1e3,2)",
    "substr(0,65537)",
    "substr(-65537,2)",
    "substr(0x10,2)",
  ])
    assert.throws(() =>
      parseApipostFunctionTemplate("{{'abcdef'|" + suffix + "}}"),
    );
});

test("source substr counts UTF-16 units and captures intrinsics before custom functions", async () => {
  assert.equal(
    await resolveApipostFunctionTemplate("{{'😀x'|substr(0,2)}}", [], "body"),
    "😀",
  );
  const functions = [
    {
      name: "fn_seed",
      kind: "transform",
      body: 'String.prototype.substr=()=>"forged";globalThis.String=()=>"forged";return "abcdef";',
      apipostSource: { projectId: "fixture", id: "seed", description: "" },
    },
  ];
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{$function.fn_seed(raw)|substr(1,3)}}",
      functions,
      "body",
    ),
    "bcd",
  );
});

test("modern substr templates import without executing or requiring custom functions", async () => {
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const { importIntoProject } = await import("../src/core.mjs");
  const doc = modernApipostFixture();
  doc.global.custom_func = [];
  doc.apis[1].request.query.parameter[0].value = "{{'abcdef'|substr(1,3)}}";
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
    project.requests[0].query[0].dynamic.value,
    "{{'abcdef'|substr(1,3)}}",
  );
  assert.equal(
    await resolveApipostFunctionTemplate(
      project.requests[0].query[0].dynamic.value,
      project.settings.functions,
    ),
    "bcd",
  );
});
