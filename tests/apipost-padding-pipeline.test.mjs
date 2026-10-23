import test from "node:test";
import assert from "node:assert/strict";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";
import { parseApipostFunctionTemplate } from "../public/apipost-function-template.js";

test("source padding uses lodash Unicode semantics and empty default padding", async () => {
  for (const [expression, variables, expected] of [
    ["{{'x'|padstart(4,ab)}}", {}, "abax"],
    ["{{'x'|padend(4,ab)}}", {}, "xaba"],
    ["{{'x'|padstart(4)}}", {}, "x"],
    ["{{'x'|padend()}}", {}, "x"],
    ["{{'😀'|padend(3,🙂)}}", {}, "😀🙂🙂"],
    ["{{token|padstart(3,0)}}", { token: null }, "000"],
    ["{{token|padstart(3,0)}}", { token: -0 }, "0-0"],
    ["{{'x'|padend(4, a )}}", {}, "x a "],
  ])
    assert.equal(
      await resolveApipostFunctionTemplate(expression, [], "body", variables),
      expected,
    );
});

test("source padding bounds allocation before invocation and captures approved functions", async () => {
  for (const suffix of [
    "padstart(4097,x)",
    "padend(1e9,x)",
    "padstart(-1,x)",
    "padend(3.5,x)",
    "padend(4,x,y)",
    "padstart(4," + "中".repeat(22) + ")",
  ])
    assert.throws(() => parseApipostFunctionTemplate("{{'x'|" + suffix + "}}"));
  const family = "👩‍👩‍👧‍👦";
  await assert.rejects(
    resolveApipostFunctionTemplate(
      "{{'x'|padend(4096," + family + ")|length}}",
      [],
      "body",
    ),
    /64KiB/,
  );
  const functions = [
    {
      name: "fn_seed",
      kind: "transform",
      body: 'require("lodash").padStart=()=>"forged";return "x";',
      apipostSource: { projectId: "fixture", id: "seed", description: "" },
    },
  ];
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{$function.fn_seed(raw)|padstart(3,0)}}",
      functions,
      "body",
    ),
    "00x",
  );
});
