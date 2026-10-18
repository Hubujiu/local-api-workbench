import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveDynamicValue,
  resolveDynamicRequest,
} from "../src/dynamic-values.mjs";
import { interpolate, runPlan, snapshotPlan } from "../src/core.mjs";
const functions = [
  { name: "double", kind: "transform", body: "return text * 2;" },
];
test("dynamic values use typed variables, ordered transforms and preserve returned literals", async () => {
  assert.equal(
    await resolveDynamicValue(
      { source: "variable", value: "n", functions: ["double", "double"] },
      { n: 3 },
      functions,
    ),
    12,
  );
  const r = await resolveDynamicRequest(
    {
      query: [
        {
          key: "x",
          value: "",
          dynamic: { source: "fixed", value: "{{untouched}}" },
        },
      ],
    },
    {},
    functions,
    interpolate,
  );
  assert.equal(r.query[0].value, "{{untouched}}");
  assert.equal(r.query[0].dynamic, undefined);
  await assert.rejects(
    resolveDynamicValue(
      { source: "variable", value: "missing" },
      {},
      functions,
    ),
  );
  await assert.rejects(
    resolveDynamicValue(
      { source: "fixed", value: 1, functions: ["missing"] },
      {},
      functions,
    ),
  );
});
test("dynamic request execution uses final pre-script scope and snapshotted functions", async () => {
  const plan = snapshotPlan({
    name: "dynamic",
    functions,
    steps: [
      {
        request: {
          url: "http://example.test",
          beforeScript: "apt.setVar('n', 4);",
          query: [
            {
              key: "n",
              value: "",
              dynamic: {
                source: "variable",
                value: "n",
                functions: ["double"],
              },
            },
          ],
        },
      },
    ],
  });
  let captured;
  const result = await runPlan(plan, { n: 1 }, async (r) => {
    captured = r;
    return { status: 200, body: "{}", headers: {} };
  });
  assert.equal(captured.query[0].value, "8");
  assert.equal(result.results[0].status, "passed");
  plan.steps[0].request.query[0].dynamic.functions = ["gone"];
  let called = false;
  const failed = await runPlan(plan, {}, async () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(failed.results[0].status, "failed");
});
test("disabled dynamic rows skip evaluation and files cannot transform", async () => {
  const request = {
    query: [
      {
        key: "off",
        value: "",
        enabled: false,
        dynamic: { source: "variable", value: "missing" },
      },
    ],
  };
  await resolveDynamicRequest(request, {}, [], interpolate);
  await assert.rejects(
    resolveDynamicRequest(
      { form: [{ type: "file", dynamic: { source: "fixed", value: "x" } }] },
      {},
      [],
      interpolate,
    ),
  );
});

test("dynamic values reject invalid JSON and excessive aggregate work before evaluation", async () => {
  for (const value of [NaN, Infinity, undefined, { nested: undefined }])
    await assert.rejects(
      resolveDynamicValue({ source: "fixed", value }, {}, []),
    );
  await assert.rejects(
    resolveDynamicRequest(
      {
        query: Array.from({ length: 21 }, () => ({
          key: "x",
          value: "",
          dynamic: { source: "fixed", value: 1, functions: ["double"] },
        })),
      },
      {},
      functions,
      interpolate,
    ),
    /最多20/,
  );
  const result = await resolveDynamicRequest(
    {
      query: [
        {
          key: "x",
          value: "{{unused}}",
          dynamic: { source: "fixed", value: 0 },
        },
      ],
    },
    {},
    [],
    interpolate,
  );
  assert.equal(result.query[0].value, "0");
});

test("raw Body dynamic tokens preserve typed JSON and do not interpolate generated strings", async () => {
  const request = {
    body: '{"n":{{@value:one}},"text":{{@value:two}},"v":"{{v}}"}',
    bodyDynamic: {
      one: {
        source: "variable",
        value: "n",
        functions: ["double"],
        format: "json",
      },
      two: { source: "fixed", value: 'a"{{literal}}', format: "json" },
    },
  };
  const result = await resolveDynamicRequest(
    request,
    { n: 3, v: "ok" },
    functions,
    interpolate,
  );
  assert.deepEqual(JSON.parse(result.body), {
    n: 6,
    text: 'a"{{literal}}',
    v: "ok",
  });
  assert.equal(result.bodyDynamic, undefined);
  await assert.rejects(
    resolveDynamicRequest({ body: "{{@value:missing}}" }, {}, [], interpolate),
    /不存在/,
  );
});

test("Mock dynamic sources are seeded, typed and feed transforms without arbitrary evaluation", async () => {
  const spec = {
    source: "mock",
    value: "@integer(7,7)",
    type: "integer",
    seed: 42,
    functions: ["double"],
  };
  assert.equal(await resolveDynamicValue(spec, {}, functions), 14);
  const name = { source: "mock", value: "@cname()", type: "string", seed: 42 };
  assert.equal(
    await resolveDynamicValue(name, {}, []),
    await resolveDynamicValue(name, {}, []),
  );
  await assert.rejects(
    resolveDynamicValue({ ...name, value: "@execute()" }, {}, []),
  );
  await assert.rejects(resolveDynamicValue({ ...name, seed: -1 }, {}, []));
});
