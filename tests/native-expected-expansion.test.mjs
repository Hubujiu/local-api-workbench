import test from "node:test";
import assert from "node:assert/strict";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { normalizeNativeAssertionData } from "../src/native-response-assertions.mjs";
const script = (data) => ({ type: "customScript", enabled: 1, data });
const check = (
  expected,
  comparison = "eq",
  path = "actual",
  type = "envVars",
) => ({
  type: "assert",
  enabled: 1,
  name: comparison,
  data: {
    type,
    expression: {
      path,
      compareType: comparison,
      ...(expected === undefined ? {} : { compareValue: expected }),
    },
  },
});
const phase = (tasks, environment = {}, runtime = {}) =>
  runNativeTaskPhase(tasks, {
    request: {},
    scopes: { globals: {}, environment, runtime },
    response: { status: 200, body: "wire", duration: 1, size: 4 },
  });

test("expected expansion keeps raw definitions inert and moves unsupported builtin rejection to execution", async () => {
  for (const type of [
    "responseJson",
    "responseTime",
    "responseText",
    "envVars",
  ]) {
    const task = check(
      "{{$unsupported}}",
      "eq",
      type === "responseJson" ? "$.value" : "actual",
      type,
    );
    assert.deepEqual(normalizeNativeAssertionData(task.data), task.data);
    // Source first: use variables for the common runtime unsupported marker check.
    await assert.rejects(
      phase([check("{{$unsupported}}", "eq")], { actual: "wire" }),
      /内置或保留/,
    );
    const inert = { ...task, enabled: 0 };
    assert.equal((await phase([inert])).tests.length, 0);
  }
  for (const op of ["exist", "notexist", "null", "notnull"])
    await assert.rejects(
      phase([check("{{$unsupported}}", op)], { actual: "" }),
      /内置或保留/,
    );
  assert.equal(
    (await phase([check(undefined, "notexist")])).tests[0].passed,
    true,
  );
});

test("expected expansion handles exact scalar keys, undefined shadowing and literal replacement text", async () => {
  const rows = [
    ["{{missing}}", "{{missing}}", {}],
    ["{{value}}", "", {}, 'pm.variables.set("value", undefined);'],
    ["{{value}}", "null", { value: null }],
    ["{{value}}", "false", { value: false }],
    ["{{value}}", "0", { value: 0 }],
    [
      "{{ 空格 }}|{{a.b}}|{{a[b]}}|{{汉}}",
      "s|d|b|中",
      { " 空格 ": "s", "a.b": "d", "a[b]": "b", 汉: "中" },
    ],
    ["{{}}", "empty", {}, 'localVariables[""] = "empty";'],
    ["\\{{value}}", "\\$&/$1", { value: "$&/$1" }],
  ];
  for (const [input, actual, values, code] of rows) {
    const result = await phase(
      [...(code ? [script(code)] : []), check(input)],
      { value: "fallback", ...values, actual },
    );
    assert.equal(result.tests[0].passed, true, input);
  }
});

test("expected expansion uses round snapshots, nested cross-piece tokens and exactly nineteen rounds", async () => {
  const rows = [
    ["{{a}}", "final", { a: "{{b}}", b: "final" }],
    ["{{a}}{{b}}", "final", { a: "{{", b: "c}}", c: "final" }],
    ["{{a}}", "{{b}}", { a: "{{b}}", b: "{{a}}" }],
    ["{{x}}", "{{x}}", { x: "{{x}}" }],
  ];
  const chain = {};
  for (let i = 0; i < 19; i++)
    chain[`v${i}`] = i === 18 ? "{{$notVisited}}" : `{{v${i + 1}}}`;
  rows.push(["{{v0}}", "{{$notVisited}}", chain]);
  for (const [input, actual, values] of rows)
    assert.equal(
      (await phase([check(input)], { ...values, actual })).tests[0].passed,
      true,
      input,
    );
});

test("expected expansion captures intrinsic scanner and private current stores without public helpers", async () => {
  const result = await phase(
    [
      script(`pm.variables.replaceIn=()=>{throw Error("public helper called")};
      pm.variables.get=()=>{throw Error("public getter called")};
      String.prototype.replace=()=>{throw Error("replace called")};
      RegExp.prototype[Symbol.replace]=()=>{throw Error("symbol replace called")};
      RegExp.prototype.exec=()=>{throw Error("exec called")};
      pm.variables.set("value", "first");`),
      check("{{value}}"),
      script(
        'pm.variables.set("value", "second"); pm.environment.set("actual", "second");',
      ),
      check("{{value}}"),
    ],
    { actual: "first" },
  );
  assert(result.tests.every((x) => x.passed));
  await assert.rejects(
    phase(
      [
        script(
          'Object.defineProperty(localVariables,"value",{get(){throw Error("getter invoked")},enumerable:true});',
        ),
        check("{{value}}"),
      ],
      { actual: "x" },
    ),
    /自有数据/,
  );
});

test("expected expansion rejects unsafe scalars and reserved names, and shares its token quota across tasks", async () => {
  for (const name of [
    "$random",
    "__proto__",
    "constructor",
    "toString",
    "prototype",
  ])
    await assert.rejects(
      phase([check(`{{${name}}}`)], { actual: "x" }),
      /内置或保留/,
    );
  for (const expression of [
    "({x:1})",
    "[1]",
    "(()=>1)",
    "NaN",
    "Infinity",
    'Symbol("x")',
    "1n",
  ])
    await assert.rejects(
      phase(
        [
          script(`pm.variables.set("value",${expression});`),
          check("{{value}}"),
        ],
        { actual: "x" },
      ),
      /有限原始值|JSON|serialize|BigInt|Symbol/,
    );
  await assert.rejects(
    phase([check("{{" + "x".repeat(1001) + "}}")], { actual: "x" }),
    /1000字符/,
  );
  const fiveHundred = "{{missing}}".repeat(500);
  const result = await phase([check(fiveHundred), check(fiveHundred)], {
    actual: fiveHundred,
  });
  assert(result.tests.every((x) => x.passed));
  await assert.rejects(
    phase([check(fiveHundred), check(fiveHundred + "{{missing}}")], {
      actual: fiveHundred,
    }),
    /最多1000次/,
  );
});

test("expected expansion bounds each Unicode value and append before growth; regex checks expanded patterns", async () => {
  await assert.rejects(
    phase(
      [script('pm.variables.set("v", "汉".repeat(22000));'), check("{{v}}")],
      { actual: "x" },
    ),
    /64KiB/,
  );
  await assert.rejects(
    phase(
      [
        script('pm.variables.set("v", "x".repeat(40000));'),
        check("{{v}}{{v}}"),
      ],
      { actual: "x" },
    ),
    /64KiB/,
  );
  await assert.rejects(
    phase([script('pm.variables.set("v", "\\ud800");'), check("{{v}}")], {
      actual: "x",
    }),
    /Unicode/,
  );
  for (const value of ["", "x".repeat(1025)])
    await assert.rejects(
      phase([check("{{pattern}}", "regularmatch")], {
        actual: "x",
        pattern: value,
      }),
      /展开后/,
    );
  await assert.rejects(
    phase([check("{{pattern}}", "regularmatch")], {
      actual: "x",
      pattern: "[",
    }),
    /Syntax|invalid|unterminated|unexpected/i,
  );
  assert.equal(
    (
      await phase([check("{{pattern}}", "regularmatch")], {
        actual: "x",
        pattern: "///",
      })
    ).tests[0].passed,
    true,
  );
});

test("expected expansion applies to every comparison, including supplied unary operands", async () => {
  const rows = [
    ["eq", "10", "10"],
    ["uneq", "10", "11"],
    ["includes", "abc", "b"],
    ["unincludes", "abc", "z"],
    ["lt", 10, "11"],
    ["lte", 10, "10"],
    ["gt", 10, "9"],
    ["gte", 10, "10"],
    ["null", "", "ignored"],
    ["notnull", "x", "ignored"],
    ["exist", "x", "ignored"],
    ["notexist", null, "ignored"],
    ["belongscollection", "b", "a,b,c"],
    ["notbelongscollection", "z", "a,b,c"],
    ["regularmatch", "abc", "^abc$"],
  ];
  const environment = {},
    tasks = [];
  rows.forEach(([op, actual, value], i) => {
    environment[`actual${i}`] = actual;
    environment[`expected${i}`] = value;
    tasks.push(check(`{{expected${i}}}`, op, `actual${i}`));
  });
  const result = await phase(tasks, environment);
  assert.equal(result.tests.length, 15);
  assert(
    result.tests.every((x) => x.passed),
    JSON.stringify(result.tests),
  );
});
