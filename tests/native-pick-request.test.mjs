import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import {
  nativeRequestSnapshotInput,
  nativeRequestSnapshotSource,
} from "../src/native-request-snapshot.mjs";
import { normalizeNativeTaskRequest } from "../src/script-database-tasks.mjs";
const pick = (
  source,
  expression,
  name = "picked",
  type = "envVars",
  enabled = 1,
) => ({
  type: "pickVars",
  enabled,
  data: { source, variables: [{ name, type, expression }] },
});
const script = (data) => ({ type: "customScript", enabled: 1, data });
const request = () => ({
  headers: [{ key: "X-A", value: "initial" }],
  bodyType: "json",
  body: '{"x":3}',
});
const phase = (tasks, req = request()) =>
  runNativeTaskPhase(tasks, { request: req });

test("request picks are pre-only with independent response phase guard and inert disabled provenance", async () => {
  const tasks = [
    pick("requestHeader", " X-A ", " h "),
    pick("requestBody", "$.x", " b "),
  ];
  const result = await phase(tasks);
  assert.equal(result.scopes.environment[" h "], "initial");
  assert.equal(result.scopes.environment[" b "], 3);
  assert.doesNotThrow(() =>
    normalizeNativeTaskRequest({
      inheritSharedScripts: false,
      nativeTasks: { version: 1, before: tasks, after: [] },
    }),
  );
  for (const source of ["requestHeader", "requestBody"]) {
    assert.throws(
      () =>
        normalizeNativeTaskRequest({
          inheritSharedScripts: false,
          nativeTasks: { version: 1, before: [], after: [pick(source, "$")] },
        }),
      /前置/,
    );
    assert.throws(
      () =>
        runNativeTaskPhase([pick(source, "$")], {
          request: request(),
          response: { status: 200, body: "{}" },
        }),
      /前置/,
    );
    assert.doesNotThrow(() =>
      normalizeNativeTaskRequest({
        inheritSharedScripts: false,
        nativeTasks: {
          version: 1,
          before: [],
          after: [pick(source, "{{inert}}", " ", "envVars", 0)],
        },
      }),
    );
  }
  for (const source of [
    "responseJson",
    "responseHeader",
    "responseXml",
    "responseText",
    "responseCode",
    "responseTime",
    "responseSize",
  ])
    assert.throws(
      () =>
        phase([pick(source, source === "responseXml" ? "string(/root)" : "$")]),
      /后置/,
    );
});

test("request snapshots precede custom scripts, remain isolated and preserve scoped scalar values", async () => {
  const tasks = [
    script(
      'pm.request.headers.upsert({key:"X-A",value:"before-first-pick"});pm.request.body.update("{\\"x\\":77}");',
    ),
    pick("requestHeader", "x-a", "first"),
    pick("requestBody", "$.x", "number"),
    script(
      'pm.request.headers.upsert({key:"X-A",value:"edited"});pm.request.body.update("{\\"x\\":99}");pm.request.headers.get=()=>{throw Error("public getter")};',
    ),
    pick("requestHeader", "x-a", "second", "globalVars"),
    pick("requestBody", "$.x", "temporary", "tempVars"),
  ];
  const result = await phase(tasks);
  assert.equal(result.scopes.environment.first, "initial");
  assert.equal(result.scopes.environment.number, 3);
  assert.equal(result.scopes.globals.second, "initial");
  assert.equal(result.localVariables.temporary, 3);
  assert.equal(result.request.body, '{"x":99}');
  const fresh = await phase([pick("requestHeader", "x-a")], {
    headers: [{ key: "x-a", value: "fresh" }],
  });
  assert.equal(fresh.scopes.environment.picked, "fresh");
});

test("request source errors stay deferred to their task and unrelated unsupported sources are not parsed", async () => {
  const result = await phase([pick("requestHeader", "x-a")], {
    ...request(),
    bodyType: "binary",
    body: "not-json",
  });
  assert.equal(result.scopes.environment.picked, "initial");
  await assert.rejects(
    async () =>
      phase(
        [
          script('throw Error("ordered before source")'),
          pick("requestBody", "$"),
        ],
        { bodyType: "binary" },
      ),
    /ordered before source/,
  );
  for (const body of [
    "",
    "null",
    "42",
    "{unquoted:1}",
    '{"x":1,}',
    '{"x":1e400}',
    '{"x":"\\ud800"}',
  ])
    await assert.rejects(async () =>
      phase([pick("requestBody", "$")], { bodyType: "raw", body }),
    );
  for (const bodyType of ["none", "binary", "graphql", "msgpack"])
    await assert.rejects(
      async () => phase([pick("requestBody", "$")], { bodyType }),
      /严格JSON/,
    );
});

test("request Header rejects missing ambiguous invalid and unsupported values without getter coercion", async () => {
  for (const headers of [
    [
      { key: "x-a", value: "a" },
      { key: "X-A", value: "b" },
    ],
    [{ key: "a b", value: "x" }],
    [{ key: "constructor", value: "x" }],
    [{ key: "x-a", value: 42 }],
    [{ key: "x-a", value: "\ud800" }],
    Array.from({ length: 257 }, (_, i) => ({ key: `x-${i}`, value: "v" })),
  ])
    await assert.rejects(async () =>
      phase([pick("requestHeader", "x-a")], { headers }),
    );
  await assert.rejects(
    async () => phase([pick("requestHeader", "absent")]),
    /不存在/,
  );
  let calls = 0;
  const header = { key: "x-a" };
  Object.defineProperty(header, "value", {
    enumerable: true,
    get() {
      calls++;
      return "forged";
    },
  });
  assert.throws(
    () => phase([pick("requestHeader", "x-a")], { headers: [header] }),
    /访问器/,
  );
  assert.equal(calls, 0);
  const envelope = { headers: [] };
  Object.defineProperty(envelope, "body", {
    enumerable: true,
    get() {
      calls++;
      return "unsafe";
    },
  });
  assert.throws(
    () => phase([pick("requestHeader", "x-a")], envelope),
    /访问器/,
  );
  assert.equal(calls, 0);
  const inherited = Object.create({ key: "x-a", value: "inherited" });
  assert.throws(
    () =>
      nativeRequestSnapshotInput({ headers: [inherited] }, ["requestHeader"]),
    /普通数据/,
  );
});

test("request Body supports unique enabled text forms and strict JSON values with bounded depth before parse", async () => {
  for (const bodyType of ["urlencoded", "form-data"]) {
    const result = await phase([pick("requestBody", "$.x")], {
      bodyType,
      form: [
        { key: "x", value: "text", type: "text" },
        { key: "x", value: "ignored", enabled: false },
      ],
    });
    assert.equal(result.scopes.environment.picked, "text");
    for (const form of [
      [
        { key: "x", value: "1" },
        { key: "x", value: "2" },
      ],
      [{ key: "x", value: "file", type: "file" }],
      [{ key: "__proto__", value: "x" }],
    ])
      await assert.rejects(() =>
        phase([pick("requestBody", "$")], { bodyType, form }),
      );
  }
  for (const [body, expression, expected] of [
    ['{"x":null}', "$.x", null],
    ['{"x":false}', "$.x", false],
    ['{"x":0}', "$.x", 0],
    ["[1,2]", "$[1]", 2],
  ])
    assert.equal(
      (
        await phase([pick("requestBody", expression)], {
          bodyType: "json",
          body,
        })
      ).scopes.environment.picked,
      expected,
    );
  await assert.rejects(
    async () =>
      phase([pick("requestBody", "$")], {
        bodyType: "json",
        body: "[".repeat(65) + "0" + "]".repeat(65),
      }),
    /预检/,
  );
  const context = vm.createContext({});
  vm.runInContext(
    `var parsed=0;JSON.parse=()=>{parsed++;return {}};var read=(${nativeRequestSnapshotSource})({bodyType:'json',body:'['.repeat(65)+'0'+']'.repeat(65)},['requestBody']);`,
    context,
  );
  assert.throws(() => vm.runInContext("read('requestBody')", context), /预检/);
  assert.equal(context.parsed, 0);
  const result = await phase([pick("requestBody", "$.x")], {
    bodyType: "json",
    body: '{"x":"[[[\\\"}]]"}',
  });
  assert.equal(result.scopes.environment.picked, '[[["}]]');
});

test("request snapshot arrays reject holes masked by extra keys and array-prototype impostors", () => {
  const sparse = new Array(1);
  sparse.extra = { key: "x", value: "lost" };
  const extra = [{ key: "x", value: "valid" }];
  extra.extra = { key: "y", value: "extra" };
  const impostor = Object.create(Array.prototype);
  impostor.key = "x";
  impostor.value = "fake";
  for (const rows of [sparse, extra, [impostor]]) {
    assert.throws(
      () => nativeRequestSnapshotInput({ headers: rows }, ["requestHeader"]),
      /数组|普通数据/,
    );
    assert.throws(
      () =>
        nativeRequestSnapshotInput({ bodyType: "urlencoded", form: rows }, [
          "requestBody",
        ]),
      /数组|普通数据/,
    );
  }
});
