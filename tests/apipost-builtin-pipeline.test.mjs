import test from "node:test";
import assert from "node:assert/strict";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";
const fn = (body) => ({
  name: "fn_seed",
  kind: "transform",
  body,
  apipostSource: { projectId: "fixture", id: "seed", description: "" },
});
test("bounded source builtins preserve lodash primitive conversion and Unicode size semantics", async () => {
  for (const [input, stage, expected] of [
    ["AbC", "lower", "abc"],
    ["straße", "upper", "STRASSE"],
    ["A😀", "length", 2],
    ["👨‍👩‍👧‍👦", "length", 1],
    [null, "lower", ""],
    [false, "length", 0],
    ["0x10", "number", 16],
    [true, "number", 1],
  ])
    assert.equal(
      await resolveApipostFunctionTemplate(
        "{{$function.fn_seed(raw)|" + stage + "}}",
        [fn("return " + JSON.stringify(input) + ";")],
        "body",
      ),
      expected,
    );
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{$function.fn_seed(raw)|upper|lower}}",
      [fn("return text;")],
      "headers",
    ),
    "raw",
  );
});
test("builtin stages retain finite-value guard and captured operations despite user mutation", async () => {
  await assert.rejects(
    resolveApipostFunctionTemplate(
      "{{$function.fn_seed(raw)|number}}",
      [fn('return "not-a-number";')],
      "body",
    ),
    /有限/,
  );
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{$function.fn_seed(raw)|upper}}",
      [fn('require("lodash").toUpper=()=>"wrong";return "right";')],
      "body",
    ),
    "RIGHT",
  );
});

test("user function metadata cannot masquerade as a trusted builtin stage", async () => {
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{$function.fn_seed(raw)|fn_seed|upper}}",
      [{ ...fn('return text+"x";'), builtin: true }],
      "body",
    ),
    "RAWXX",
  );
});

test("modern import recognizes builtin stages without inventing shared function entries", async () => {
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const { importIntoProject, interpolate } = await import("../src/core.mjs");
  const { resolveDynamicRequest } = await import("../src/dynamic-values.mjs");
  const { environmentVariables, resolveServiceRequest } = await import(
    "../src/environments.mjs"
  );
  const doc = modernApipostFixture();
  doc.global.custom_func = [
    { func_id: "seed", func_name: "fn_seed", func_body: "return text;" },
  ];
  doc.apis[1].request.query.parameter = [
    { key: "q", value: "{{$function.fn_seed(raw)|UPPER}}", is_checked: 1 },
  ];
  const p = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
  importIntoProject(p, doc);
  assert.equal(p.settings.functions.length, 1);
  const env = p.environments[0].id;
  const r = await resolveDynamicRequest(
    resolveServiceRequest(p, p.requests[0], env),
    environmentVariables(p, env),
    p.settings.functions,
    interpolate,
  );
  assert.equal(r.query[0].value, "RAW");
  const bad = structuredClone(doc),
    before = structuredClone(p);
  bad.apis[1].request.query.parameter[0].value =
    "{{$function.fn_seed(raw)|not_allowed}}";
  assert.throws(() => importIntoProject(p, bad));
  assert.deepEqual(p, before);
});
