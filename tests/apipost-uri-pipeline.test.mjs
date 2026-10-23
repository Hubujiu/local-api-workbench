import test from "node:test";
import assert from "node:assert/strict";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";
import { parseApipostFunctionTemplate } from "../public/apipost-function-template.js";

test("source URI stages preserve Unicode, coercion and synchronous-error fallback", async () => {
  for (const [value, expected] of [
    ["a /中", "a%20%2F%E4%B8%AD"],
    [null, "null"],
    [false, "false"],
    [-0, "0"],
  ])
    assert.equal(
      await resolveApipostFunctionTemplate(
        "{{token|encodeuricomponent}}",
        [],
        "body",
        { token: value },
      ),
      expected,
    );
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{'%E4%B8%AD%2F'|decodeuricomponent}}",
      [],
      "body",
    ),
    "中/",
  );
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{'%zz'|decodeuricomponent|upper}}",
      [],
      "body",
    ),
    "%ZZ",
  );
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{token|encodeuricomponent|length}}",
      [],
      "body",
      { token: "\ud800" },
    ),
    1,
  );
  assert.throws(() =>
    parseApipostFunctionTemplate("{{'x'|encodeuricomponent(arg)}}"),
  );
});

test("URI stages retain intermediate bounds and Query structural protections", async () => {
  await assert.rejects(
    resolveApipostFunctionTemplate(
      "{{token|encodeuricomponent|length}}",
      [],
      "body",
      { token: "中".repeat(8000) },
    ),
    /64KiB/,
  );
  await assert.rejects(
    resolveApipostFunctionTemplate("{{'a b'|encodeuricomponent}}", [], "query"),
    /分隔符/,
  );
  await assert.rejects(
    resolveApipostFunctionTemplate(
      "{{'%0A'|decodeuricomponent}}",
      [],
      "headers",
    ),
    /分隔符/,
  );
  const functions = [
    {
      name: "fn_seed",
      kind: "transform",
      body: 'globalThis.encodeURIComponent=()=>"forged";return "a b";',
      apipostSource: { projectId: "fixture", id: "seed", description: "" },
    },
  ];
  assert.equal(
    await resolveApipostFunctionTemplate(
      "{{$function.fn_seed(raw)|encodeuricomponent}}",
      functions,
      "body",
    ),
    "a%20b",
  );
});
