// CI-only: this file imports the production QuickJS runtime. Never run locally.
import test from "node:test";
import assert from "node:assert/strict";
import {
  snapshotPlan,
  runPlan,
  normalizeRequest,
  toCurl,
  exportOpenAPI,
} from "../src/core.mjs";
import { runScript } from "../src/scripts.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";

const definition = { id: "echo", type: "tcp", url: "127.0.0.1", port: 4000 };
const step = (before = "", after = "", extra = {}) => ({
  id: "wire",
  type: "protocol",
  protocol: { definition, message: "{{value}}", duration: 1000 },
  protocolScripts: { version: 1, before, after },
  ...extra,
});
const http = {
  request: { method: "GET", url: "http://example.invalid/{{value}}" },
};
const response = () => ({ status: 200, body: "{}", headers: {}, duration: 0 });
const result = (body = "pre", status = "completed") => ({
  type: "tcp",
  status,
  durationMs: 1,
  result: {
    body,
    base64: Buffer.from(body).toString("base64"),
    size: Buffer.byteLength(body),
    timedOut: status === "partial",
    partial: status === "partial",
  },
});
async function run(s, options = {}, following = true) {
  const calls = [],
    urls = [],
    commits = [];
  const plan = snapshotPlan({
    statusPolicy: "strict200",
    steps: [s, ...(following ? [http] : [])],
  });
  const report = await runPlan(
    plan,
    { value: "initial" },
    async (request) => {
      urls.push(request.url);
      return response();
    },
    {
      executeProtocol: async (request) => {
        calls.push(request);
        return result(
          typeof request.message === "string" ? request.message : "encoded",
        );
      },
      onScopeChanges: async (changes) => commits.push(changes),
      ...options,
    },
  );
  return { report, calls, urls, commits };
}

test("wire scripts expose deeply frozen native aliases and commit PRE then POST plus extraction", async () => {
  const before = `pm.test('native before',()=>{pm.expect(wire).to.equal(pm.wire);pm.expect(wire).to.equal(apt.wire);pm.expect(wire.protocol).to.equal('tcp');pm.expect(wire.phase).to.equal('before');pm.expect(wire.result).to.equal(undefined);pm.expect(wire.request.message).to.equal('{{value}}');pm.expect(wire.request.completion).to.equal('end');pm.expect(Object.isFrozen(wire.request)).to.equal(true);pm.expect(pm.request).to.equal(undefined);pm.expect(pm.response).to.equal(undefined);pm.expect(apt.request).to.equal(undefined);pm.expect(apt.response).to.equal(undefined);pm.expect(pm.cookies).to.equal(undefined);});pm.variables.set('local','private');apt.setVar('value','pre');pm.environment.set('env','pre');pm.globals.set('global','pre');console.log('wire-before');`;
  const after = `pm.test('native after',()=>{pm.expect(wire.phase).to.equal('after');pm.expect(wire.request.message).to.equal('pre');pm.expect(wire.result.status).to.equal('completed');pm.expect(wire.result.result.body).to.equal('pre');pm.expect(Object.isFrozen(wire.result.result)).to.equal(true);pm.expect(pm.variables.get('local')).to.equal('private');pm.expect(pm.info.protocol).to.equal('tcp');pm.expect(wire.request.headers).to.equal(undefined);pm.expect(wire.request.tls).to.equal(undefined);});apt.setVar('value','post');pm.environment.set('env','post');pm.globals.set('global','post');apt.setVar('picked','script-value');console.log('wire-after');`;
  const { report, calls, urls, commits } = await run(
    step(before, after, {
      assertions: [{ target: "$.body", op: "eq", value: "pre" }],
      extract: [
        { name: "picked", path: "$.body" },
        { name: "pickedEnv", path: "$.body", scope: "environment" },
        { name: "pickedGlobal", path: "$.body", scope: "global" },
      ],
    }),
  );
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, "pre");
  assert.equal(urls[0], "http://example.invalid/post");
  assert.equal(commits.length, 2);
  assert.equal(report.variables.local, undefined);
  assert.equal(
    report.variables.picked,
    "pre",
    "declarative extraction wins same-name POST changes",
  );
  assert.equal(report.variables.env, "post");
  assert.equal(report.variables.global, "post");
  assert.equal(report.variables.pickedEnv, "pre");
  assert.equal(report.variables.pickedGlobal, "pre");
  assert.equal(report.results[0].response, undefined);
  assert.deepEqual(
    report.results[0].assertions.map((a) => a.phase),
    ["before", "response", "after"],
  );
});

test("wire script markers preflight the complete graph including disabled wrong-type descendants", async () => {
  const invalid = [
    step("", "", { protocolScripts: null }),
    step("", "", { protocolScripts: { version: 2 } }),
    step("", "", { protocolScripts: { version: 1, before: [] } }),
    step("", "", {
      protocolScripts: { version: 1, after: "x".repeat(100001) },
    }),
    step("", "", { protocolScripts: { version: 1, unknown: true } }),
    ...[undefined, "http", "grpc", "socketio"].map((type) => ({
      ...http,
      type,
      enabled: false,
      protocolScripts: undefined,
    })),
    {
      type: "repeat",
      count: 1,
      steps: [http],
      protocolScripts: { version: 1 },
      enabled: false,
    },
    {
      type: "repeat",
      count: 1,
      steps: [{ ...http, protocolScripts: { version: 1 }, enabled: false }],
      enabled: false,
    },
  ];
  for (const bad of invalid) {
    assert.throws(() => snapshotPlan({ steps: [http, bad] }));
    let invoked = 0;
    await assert.rejects(
      runPlan({ steps: [http, bad] }, {}, async () => invoked++, {
        executeProtocol: async () => invoked++,
        onScopeChanges: async () => invoked++,
      }),
    );
    assert.equal(invoked, 0);
  }
});

test("wire PRE failures discard candidate scopes and cannot start transport", async () => {
  for (const failure of [
    "throw Error('pre-failure');",
    "pm.test('bad',()=>pm.expect(1).to.equal(2));",
    "while(true){}",
    "const a={};a.self=a;pm.variables.set('cycle',a);",
    "pm.variables.set('huge','x'.repeat(1048576));",
  ]) {
    const { report, calls, urls, commits } = await run(
      step(
        "apt.setVar('value','leak');pm.environment.set('env','leak');pm.globals.set('global','leak');" +
          failure,
      ),
    );
    assert.equal(report.status, "failed", JSON.stringify(report));
    assert.equal(calls.length, 0);
    assert.equal(commits.length, 0);
    assert.equal(urls[0], "http://example.invalid/initial");
    assert.equal(report.variables.env, undefined);
    assert.equal(report.variables.global, undefined);
    assert.equal(report.results[0].scriptPhase, "before");
  }
});

test("wire POST tests status and complete extraction failures preserve only confirmed PRE", async () => {
  for (const extra of [
    {
      protocolScripts: {
        version: 1,
        before: "apt.setVar('value','pre');pm.environment.set('env','pre');",
        after:
          "apt.setVar('value','leak');pm.environment.set('env','leak');throw Error('post-failure');",
      },
    },
    {
      protocolScripts: {
        version: 1,
        before: "apt.setVar('value','pre');pm.environment.set('env','pre');",
        after:
          "apt.setVar('value','leak');pm.test('bad',()=>pm.expect(1).to.equal(2));",
      },
    },
    { assertions: [{ target: "$.body", op: "eq", value: "wrong" }] },
    { expectedStatus: "partial" },
    {
      extract: [
        { name: "early", path: "$.body" },
        { name: "later", path: "$.missing" },
      ],
    },
  ]) {
    const { report, calls, urls, commits } = await run(
      step(
        "apt.setVar('value','pre');pm.environment.set('env','pre');",
        "apt.setVar('value','leak');pm.environment.set('env','leak');",
        extra,
      ),
    );
    assert.equal(report.status, "failed", JSON.stringify(report));
    assert.equal(calls.length, 1);
    assert.equal(commits.length, 1);
    assert.equal(report.results[0].protocolResult.result.body, "pre");
    assert.deepEqual(report.results[0].extracted, {});
    assert.equal(report.variables.env, "pre");
    assert.equal(report.variables.early, undefined);
    assert.equal(urls[0], "http://example.invalid/pre");
  }
});

test("wire expected partial and failed statuses reach POST but scripts cannot launder unexpected evidence", async () => {
  for (const status of ["partial", "failed"]) {
    const native =
      status === "partial"
        ? result("capture", status)
        : {
            type: "tcp",
            status,
            durationMs: 1,
            result: { error: "fixture failure" },
          };
    for (const expectedStatus of ["completed", status]) {
      const { report, urls } = await run(
        step(
          "apt.setVar('value','pre');",
          `console.log(wire.result.status);pm.test('status',()=>pm.expect(wire.result.status).to.equal('${status}'));apt.setVar('value','accepted');`,
          { expectedStatus },
        ),
        {
          executeProtocol: async () => native,
        },
      );
      assert.equal(
        report.status,
        expectedStatus === status ? "passed" : "failed",
        JSON.stringify(report),
      );
      assert.deepEqual(report.results[0].protocolResult, native);
      assert.equal(
        urls[0],
        "http://example.invalid/" +
          (expectedStatus === status ? "accepted" : "pre"),
      );
      assert(
        report.results[0].logs.some(
          (log) => log.phase === "after" && log.message === status,
        ),
      );
    }
  }
});

test("wire scripts cannot retarget edit evidence or enable HTTP cookie database or network capabilities", async () => {
  for (const before of [
    "wire.request.host='evil.invalid';",
    "wire.request.message='changed';",
    "pm.request.url='http://evil.invalid';",
    "pm.setRequestBody('changed');",
    "apt.setRequestHeader('x','y');",
    "pm.cookies.set('x','y');",
    "pm.sendRequest('http://evil.invalid');",
    "input.allowNetwork=true;__sendRequest('{}',()=>{});",
    "input.allowNetwork=true;await $.ajax({url:'http://example.invalid/'});",
  ]) {
    const { report, calls } = await run(step(before));
    assert.equal(report.status, "failed", JSON.stringify(report));
    assert.equal(calls.length, 0);
    assert.deepEqual(report.results[0].subrequests, []);
  }
  const { report } = await run(
    step("", "wire.result.status='completed';", { expectedStatus: "partial" }),
    { executeProtocol: async () => result("capture", "partial") },
  );
  assert.equal(report.status, "failed");
  assert.equal(report.results[0].protocolResult.status, "partial");
});

test("wire host options alone select native mode and reject mixed or HTTP bindings", () => {
  const wireContext = {
    protocol: "tcp",
    phase: "before",
    request: {
      host: "127.0.0.1",
      port: 4000,
      duration: 1000,
      completion: "end",
      message: "",
    },
  };
  const grpcContext = {
    protocol: "grpc",
    phase: "before",
    request: {
      target: "grpc://127.0.0.1:4000",
      service: "fixture.Echo",
      method: "Unary",
      timeoutMs: 1000,
      messages: [],
    },
  };
  assert.throws(() => runScript("", { wireContext }), /执行入口|上下文/);
  assert.throws(() => runScript("", {}, { wireContext }));
  assert.throws(() =>
    runScript("", {}, { wireContext, grpcContext, requestLimit: 0 }),
  );
  assert.throws(() =>
    runScript("", {}, { wireContext, cookieSession: {}, requestLimit: 0 }),
  );
  for (const input of [
    { allowNetwork: true },
    { response: {} },
    { finalBody: "changed" },
    { responseWire: {} },
    { responseOriginals: {} },
    { request: { scriptDialect: "apipost8" } },
    { request: { scriptURLMode: "sdk" } },
    { request: { url: "http://example.invalid" } },
    { grpcContext },
  ])
    assert.throws(() => runScript("", input, { wireContext, requestLimit: 0 }));
});

test("wire executor authority and whole credential maps are validated before any PRE", async () => {
  const denied = await run(step("pm.environment.set('mustNotRun',true);"), {
    executeProtocol: undefined,
  });
  assert.equal(denied.report.status, "failed");
  assert.equal(denied.commits.length, 0);
  for (const credentials of [
    { wire: { headers: { Authorization: "secret" } } },
    { wire: { url: "http://elsewhere.invalid" } },
    { missing: {} },
  ]) {
    let invoked = 0;
    await assert.rejects(
      runPlan(
        snapshotPlan({
          steps: [http, step("pm.environment.set('mustNotRun',true);")],
        }),
        {},
        async () => invoked++,
        {
          executeProtocol: async () => invoked++,
          onScopeChanges: async () => invoked++,
          protocolCredentials: credentials,
        },
      ),
    );
    assert.equal(invoked, 0);
  }
});

test("wire invalid resolved encoded payload keeps confirmed PRE but never starts transport", async () => {
  const { report, calls, commits } = await run(
    step(
      "apt.setVar('hex','not-hex');pm.environment.set('confirmed','pre');",
      "apt.setVar('leak',true);",
      {
        protocol: { definition, message: { encoding: "hex", data: "{{hex}}" } },
      },
    ),
  );
  assert.equal(report.status, "failed");
  assert.equal(calls.length, 0);
  assert.equal(commits.length, 1);
  assert.equal(report.variables.confirmed, "pre");
  assert.equal(report.variables.leak, undefined);
  assert.equal(report.results[0].protocolResult, undefined);
});

test("wire executor exceptions without returned evidence cannot invent a POST result", async () => {
  const { report } = await run(
    step("apt.setVar('value','pre');", "apt.setVar('leak',true);"),
    {
      executeProtocol: async () => {
        throw Error("fixture executor exception");
      },
    },
  );
  assert.equal(report.status, "failed");
  assert.equal(report.variables.value, "pre");
  assert.equal(report.variables.leak, undefined);
  assert.equal(report.results[0].protocolResult, undefined);
  assert.match(report.results[0].error, /fixture executor exception/);
});

test("wire confirmed PRE acknowledgement cancellation keeps scopes without transport", async () => {
  const controller = new AbortController(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const pending = run(
    step(
      "apt.setVar('value','pre');pm.environment.set('env','pre');",
      "apt.setVar('value','post');",
    ),
    {
      signal: controller.signal,
      onScopeChanges: async () => {
        entered.resolve();
        await release.promise;
      },
    },
  );
  await Promise.race([
    entered.promise,
    pending.then(({ report }) => {
      throw Error("PRE commit not entered: " + JSON.stringify(report));
    }),
  ]);
  controller.abort();
  release.resolve();
  const { report, calls, urls } = await pending;
  assert.equal(report.status, "cancelled");
  assert.equal(calls.length, 0);
  assert.equal(urls.length, 0);
  assert.equal(report.variables.value, "pre");
  assert.equal(report.variables.env, "pre");
});

test("wire confirmed POST acknowledgement cancellation keeps one complete batch without later work", async () => {
  const controller = new AbortController(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const pending = run(
    step(
      "apt.setVar('value','pre');",
      "apt.setVar('value','post');pm.environment.set('env','post');",
      { extract: [{ name: "picked", path: "$.body" }] },
    ),
    {
      signal: controller.signal,
      onScopeChanges: async () => {
        entered.resolve();
        await release.promise;
      },
    },
  );
  await Promise.race([
    entered.promise,
    pending.then(({ report }) => {
      throw Error("POST commit not entered: " + JSON.stringify(report));
    }),
  ]);
  controller.abort();
  release.resolve();
  const { report, calls, urls } = await pending;
  assert.equal(report.status, "cancelled");
  assert.equal(calls.length, 1);
  assert.equal(urls.length, 0);
  assert.equal(report.variables.value, "post");
  assert.equal(report.variables.env, "post");
  assert.equal(report.variables.picked, "pre");
  assert.deepEqual(report.results[0].extracted, { picked: "pre" });
});

test("wire transport cancellation keeps actual error-only evidence and skips POST", async () => {
  const controller = new AbortController();
  const native = {
    type: "tcp",
    status: "cancelled",
    durationMs: 1,
    result: { error: "cancelled" },
  };
  const { report, commits, urls } = await run(
    step("apt.setVar('value','pre');", "pm.environment.set('leak',true);"),
    {
      signal: controller.signal,
      executeProtocol: async () => {
        controller.abort();
        return native;
      },
    },
  );
  assert.equal(report.status, "cancelled");
  assert.deepEqual(report.results[0].protocolResult, native);
  assert.equal(report.variables.value, "pre");
  assert.equal(report.variables.leak, undefined);
  assert.equal(commits.length, 0);
  assert.equal(urls.length, 0);
});

test("wire returned cancellation without an aborted signal still forbids POST and extraction", async () => {
  const native = {
    type: "tcp",
    status: "cancelled",
    durationMs: 1,
    result: { error: "executor cancelled" },
  };
  const { report, commits } = await run(
    step(
      "apt.setVar('value','pre');",
      "apt.setVar('leak',true);pm.environment.set('env','leak');",
      { extract: [{ name: "picked", path: "$.error" }] },
    ),
    { executeProtocol: async () => native },
  );
  assert.equal(report.status, "failed");
  assert.deepEqual(report.results[0].protocolResult, native);
  assert.deepEqual(report.results[0].extracted, {});
  assert.equal(report.variables.value, "pre");
  assert.equal(report.variables.leak, undefined);
  assert.equal(report.variables.env, undefined);
  assert.equal(report.variables.picked, undefined);
  assert.equal(commits.length, 0);
});

test("wire PRE and POST uncertain commits stop later work without publishing or replay", async () => {
  for (const phase of ["before", "after"])
    for (const error of [
      Error("definite rejection"),
      new ProjectCommitUncertain("fixture", Error("fixture")),
      Object.assign(Error("wrapped"), { code: "PROJECT_COMMIT_UNCERTAIN" }),
    ]) {
      let attempts = 0;
      const uncertain = error.code === "PROJECT_COMMIT_UNCERTAIN";
      const { report, calls, urls } = await run(
        step(
          phase === "before"
            ? "apt.setVar('value','leak');pm.environment.set('env','leak');"
            : "apt.setVar('value','pre');",
          "apt.setVar('value','leak');pm.environment.set('env','leak');",
          { extract: [{ name: "picked", path: "$.body" }] },
        ),
        {
          onScopeChanges: async () => {
            attempts++;
            throw error;
          },
        },
      );
      assert.equal(report.status, "failed");
      assert.equal(attempts, 1);
      assert.equal(calls.length, phase === "before" ? 0 : 1);
      assert.equal(
        report.variables.value,
        phase === "before" ? "initial" : "pre",
      );
      assert.equal(report.variables.env, undefined);
      assert.equal(report.variables.picked, undefined);
      assert.deepEqual(report.results[0].extracted, {});
      if (uncertain) {
        assert.equal(urls.length, 0);
        assert.deepEqual(report.results[0].scopeCommit, {
          outcome: "unknown",
          retrySafe: false,
          phase,
        });
      } else assert.equal(urls.length, 1);
    }
});

test("wire context independent 2 MiB ceiling fails POST without truncating valid transport evidence", async () => {
  const body = "x".repeat(1024 * 1024),
    native = result(body);
  const { report, commits, urls } = await run(
    step(
      "apt.setVar('value','pre');",
      "apt.setVar('value','leak');pm.environment.set('env','leak');",
    ),
    { executeProtocol: async () => native },
  );
  assert.equal(report.status, "failed");
  assert.equal(report.results[0].scriptPhase, "after");
  assert.match(report.results[0].error, /上下文|超限/);
  assert.deepEqual(report.results[0].protocolResult, native);
  assert.equal(report.results[0].protocolResult.result.size, 1024 * 1024);
  assert.equal(report.variables.env, undefined);
  assert.equal(commits.length, 0);
  assert.equal(urls[0], "http://example.invalid/pre");
});

test("wire absent and empty scripts preserve ordinary execution while raw display identity remains optional", async () => {
  for (const protocolScripts of [
    undefined,
    { version: 1 },
    { version: 1, before: " ", after: "" },
  ]) {
    const s = step("", "", { protocolScripts });
    if (protocolScripts === undefined) delete s.protocolScripts;
    const { report, calls } = await run(s);
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, "initial");
    assert.equal(report.results[0].scriptPhase, undefined);
  }
  const raw = step(
    "apt.setVar('value','raw');",
    "pm.test('raw',()=>pm.expect(wire.result.result.body).to.equal('raw'));",
  );
  delete raw.id;
  const report = await runPlan(
    { steps: [raw] },
    { value: "initial" },
    () => {
      throw Error("no HTTP");
    },
    { executeProtocol: async (request) => result(request.message) },
  );
  assert.equal(report.status, "passed", JSON.stringify(report));
});

test("wire execution snapshots remain frozen across live edits and concurrent VM phase locals stay isolated", async () => {
  const plans = ["one", "two"].map((value) =>
    snapshotPlan({
      steps: [
        step(
          `pm.variables.set('private','${value}');apt.setVar('value','${value}');`,
          `pm.test('isolation',async()=>{await Promise.resolve();pm.expect(pm.variables.get('private')).to.equal('${value}');pm.expect(wire.result.result.body).to.equal('${value}');});`,
        ),
      ],
    }),
  );
  const seen = [];
  const reports = await Promise.all(
    plans.map((plan) => {
      const pending = runPlan(
        plan,
        { value: "initial" },
        () => {
          throw Error("no HTTP");
        },
        {
          executeProtocol: async (request) => {
            seen.push(request);
            return result(request.message);
          },
        },
      );
      plan.steps[0].protocol.definition.url = "evil.invalid";
      plan.steps[0].protocol.message = "changed";
      plan.steps[0].protocolScripts.after = "throw Error('changed');";
      return pending;
    }),
  );
  for (const report of reports) {
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.variables.private, undefined);
  }
  assert.deepEqual(seen.map((request) => request.message).sort(), [
    "one",
    "two",
  ]);
  assert(seen.every((request) => request.definition.url === "127.0.0.1"));
});

test("wire script semantics cannot disappear through HTTP definition exporters but business JSON is not scanned", () => {
  const request = {
    method: "POST",
    url: "http://example.invalid",
    bodyType: "raw",
    body: '{"protocolScripts":{"version":1}}',
  };
  const poisoned = {
    ...request,
    protocolScripts: { version: 1, before: "apt.setVar('x',1);" },
  };
  assert.throws(() => normalizeRequest(poisoned));
  assert.throws(() => toCurl(poisoned));
  assert.throws(() => exportOpenAPI({ name: "bad", requests: [poisoned] }));
  assert.equal(normalizeRequest(request).body, request.body);
  assert.match(toCurl(request), /protocolScripts/);
  assert.doesNotThrow(() =>
    exportOpenAPI({ name: "business", requests: [request] }),
  );
});
