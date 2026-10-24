import test from "node:test";
import assert from "node:assert/strict";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";
import { parseApipostFunctionTemplate } from "../public/apipost-function-template.js";

test("source concat stages preserve raw arguments and primitive string coercion", async () => {
  for (const [expression, variables, expected] of [
    ["{{'seed'|concat(-tail)|lconcat(head-)}}", {}, "head-seed-tail"],
    ["{{token|concat( null )}}", { token: false }, "falsenull"],
    ["{{token|concat('literal')}}", { token: null }, "null'literal'"],
    ["{{token|concat()|lconcat}}", { token: -0 }, "0"],
    ["{{'x'|concat(\\n)|upper}}", {}, "X\\N"],
  ])
    assert.equal(
      await resolveApipostFunctionTemplate(expression, [], "body", variables),
      expected,
    );
  for (const expression of [
    "{{'x'|concat(a,b)}}",
    "{{'x'|upper(arg)}}",
    "{{'x'|concat(nested(x))}}",
    "{{'x'|fn_custom(arg)}}",
  ])
    assert.throws(() => parseApipostFunctionTemplate(expression));
});

test("concat stages cannot hide oversized results or replace captured intrinsics", async () => {
  await assert.rejects(
    resolveApipostFunctionTemplate("{{token|concat(x)|length}}", [], "body", {
      token: "x".repeat(65534),
    }),
    /64KiB/,
  );
  const functions = [
    {
      name: "fn_seed",
      kind: "transform",
      body: 'String.prototype.concat=()=>"forged";globalThis.String=()=>"forged";return "seed";',
      apipostSource: { projectId: "fixture", id: "seed", description: "" },
    },
  ];
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{$function.fn_seed(raw)|concat(-tail)}}",
      functions,
      "body",
    ),
    "seed-tail",
  );
});
