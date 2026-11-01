// CI-only: imports the production QuickJS engine. Do not run in restricted local review.
import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { runScript } from "../src/scripts.mjs";
import { grpcScriptContext } from "../src/grpc-script-context.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
const definition = {
  id: "echo",
  target: "grpc://127.0.0.1:5000",
  proto:
    'syntax="proto3"; package fixture; message Payload { string text=1; } service Echo { rpc Unary(Payload) returns (Payload); }',
  service: "fixture.Echo",
  method: "Unary",
  timeoutMs: 1000,
};
const step = (before = "", after = "", extra = {}) => ({
  id: "rpc",
  type: "grpc",
  grpc: { definition, messages: [{ text: "{{value}}" }] },
  grpcScripts: { version: 1, before, after },
  ...extra,
});
const http = {
  request: { url: "http://example.invalid/{{value}}", method: "GET" },
};
const result = (messages, code = 0) => ({
  status: { code, details: code ? "denied" : "" },
  messages,
  durationMs: 1,
  metadata: [{ key: "secret", value: "fixture-secret" }],
  trailers: [{ key: "secret", value: "fixture-secret" }],
});
const response = () => ({ status: 200, body: "{}", headers: {}, duration: 0 });
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
      executeGrpc: async (request) => {
        calls.push(request);
        return result(request.messages);
      },
      onScopeChanges: async (changes) => {
        commits.push(changes);
      },
      ...options,
    },
  );
  return { report, calls, urls, commits };
}
test("native PRE local/runtime/env/global values feed RPC and POST atomically without HTTP masquerade", async () => {
  const before = `pm.test('native before',()=>{pm.expect(grpc.phase).to.equal('before');pm.expect(grpc.result).to.equal(undefined);pm.expect(pm.response).to.equal(undefined);pm.expect(apt.response).to.equal(undefined);pm.expect(pm.request).to.equal(undefined);pm.expect(grpc).to.equal(pm.grpc);pm.expect(grpc).to.equal(apt.grpc);pm.expect(Object.isFrozen(grpc.request.messages[0])).to.equal(true);}); pm.variables.set('local','local-value'); apt.setVar('value','pre'); pm.environment.set('env','pre'); pm.globals.set('global','pre');console.log('before-native');`;
  const after = `pm.test('native after',()=>{pm.expect(grpc.phase).to.equal('after');pm.expect(grpc.result.status.code).to.equal(0);pm.expect(grpc.result.messages[0].text).to.equal('pre');pm.expect(pm.variables.get('local')).to.equal('local-value');pm.expect(pm.info.protocol).to.equal('grpc');pm.expect(grpc.request.metadata).to.equal(undefined);});apt.setVar('value','post');pm.environment.set('env','post');pm.globals.set('global','post');console.log('after-native');`;
  const { report, calls, urls, commits } = await run(
    step(before, after, {
      extract: [{ name: "extracted", path: "$[0].text" }],
    }),
  );
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messages[0].text, "pre");
  assert.equal(urls[0], "http://example.invalid/post");
  assert.equal(report.variables.local, undefined);
  assert.equal(report.variables.extracted, "pre");
  assert.equal(commits.length, 2);
  assert.equal(report.results[0].response, undefined);
  assert.deepEqual(report.results[0].grpcResult.metadata, []);
  assert.deepEqual(report.results[0].grpcResult.trailers, []);
  assert.doesNotMatch(JSON.stringify(report), /fixture-secret/);
  assert.deepEqual(
    report.results[0].assertions.map((a) => a.phase),
    ["before", "after"],
  );
});
test("script container preflight rejects malformed and wrong-protocol fields before an earlier HTTP", async () => {
  for (const grpcScripts of [
    null,
    { version: 2 },
    { version: 1, before: [] },
    { version: 1, before: "x".repeat(100001) },
    { version: 1, extra: 1 },
  ]) {
    assert.throws(() =>
      snapshotPlan({ steps: [step("", "", { grpcScripts })] }),
    );
    let invoked = 0;
    await assert.rejects(
      runPlan(
        { steps: [http, step("", "", { grpcScripts })] },
        {},
        async () => invoked++,
      ),
    );
    assert.equal(invoked, 0);
  }
  for (const type of [undefined, "socketio", "protocol"])
    for (const grpcScripts of [undefined, {}, { version: 1 }])
      assert.throws(
        () => snapshotPlan({ steps: [{ ...http, type, grpcScripts }] }),
        /仅可/,
      );
});
test("failed PRE stages discard every scope and perform zero RPC calls", async () => {
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
test("POST and extraction failures retain PRE and actual wire evidence but no staged variables", async () => {
  for (const extra of [
    {
      grpcScripts: {
        version: 1,
        before: "apt.setVar('value','pre');",
        after:
          "apt.setVar('value','leak');pm.environment.set('env','leak');throw Error('post-failure');",
      },
    },
    {
      grpcScripts: {
        version: 1,
        before: "apt.setVar('value','pre');",
        after:
          "apt.setVar('value','leak');pm.test('bad',()=>pm.expect(1).to.equal(2));",
      },
    },
    { assertions: [{ target: "$[0].text", op: "eq", value: "not-pre" }] },
    { expectedStatus: 7 },
    {
      extract: [
        { name: "early", path: "$[0].text" },
        { name: "later", path: "$[0].missing" },
      ],
    },
  ]) {
    const { report, calls, urls } = await run(
      step(
        "apt.setVar('value','pre');",
        "apt.setVar('value','leak');pm.environment.set('env','leak');",
        extra,
      ),
    );
    assert.equal(report.status, "failed", JSON.stringify(report));
    assert.equal(calls.length, 1);
    assert.equal(report.results[0].grpcResult.status.code, 0);
    assert.equal(report.results[0].grpcResult.messages[0].text, "pre");
    assert.deepEqual(report.results[0].extracted, {});
    assert.equal(report.variables.env, undefined);
    assert.equal(report.variables.early, undefined);
    assert.equal(urls[0], "http://example.invalid/pre");
  }
});
test("an explicitly expected native nonzero status reaches POST and is not HTTP strict-200", async () => {
  const { report } = await run(
    step(
      "",
      "pm.test('denied',()=>pm.expect(grpc.result.status.code).to.equal(7));apt.setVar('value','expected-error');",
      { expectedStatus: 7 },
    ),
    { executeGrpc: async () => result([], 7) },
  );
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(report.variables.value, "expected-error");
});
test("native context and old HTTP aliases cannot retarget, mutate evidence or broker extra network", async () => {
  for (const before of [
    "grpc.request.target='grpc://evil.invalid:9';",
    "grpc.request.messages[0].text='changed';",
    "pm.request.url='http://evil.invalid';",
    "pm.setRequestBody('changed');",
    "pm.sendRequest('http://evil.invalid');",
    "apt.setRequestHeader('x','y');",
    "input.allowNetwork=true;__sendRequest('{}',()=>{});",
    "input.allowNetwork=true;await $.ajax({url:'http://example.invalid/'});",
  ]) {
    const { report, calls } = await run(step(before));
    assert.equal(report.status, "failed", JSON.stringify(report));
    assert.equal(calls.length, 0);
    assert.deepEqual(report.results[0].subrequests, []);
  }
  const { report } = await run(
    step("", "grpc.result.status.code=0;", { expectedStatus: 7 }),
    { executeGrpc: async () => result([], 7) },
  );
  assert.equal(report.status, "failed");
  assert.equal(report.results[0].grpcResult.status.code, 7);
  const context = grpcScriptContext(step(), "before", []);
  assert.throws(() => runScript("", { grpcContext: context }), /执行入口/);
  assert.throws(
    () =>
      runScript(
        "",
        { allowNetwork: true },
        { grpcContext: context, requestLimit: 0 },
      ),
    /HTTP/,
  );
  assert.throws(() => runScript("", {}, { grpcContext: context }), /HTTP/);
});
test("explicit executor grant and valid credential bindings are required before PRE", async () => {
  const { report, commits } = await run(
    step("pm.environment.set('shouldNotRun',true);"),
    { executeGrpc: undefined },
  );
  assert.equal(report.status, "failed");
  assert.equal(commits.length, 0);
  let count = 0;
  await assert.rejects(
    runPlan(
      snapshotPlan({
        steps: [step("pm.environment.set('shouldNotRun',true);")],
      }),
      {},
      () => {},
      {
        executeGrpc: () => count++,
        onScopeChanges: () => count++,
        grpcCredentials: { rpc: { target: "grpc://elsewhere:1" } },
      },
    ),
    /临时凭据/,
  );
  assert.equal(count, 0);
});
test("confirmed PRE acknowledgement cancellation retains its whole scope and prevents RPC", async () => {
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
      throw Error(
        "PRE did not reach pending commit: " + JSON.stringify(report),
      );
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
test("RPC cancellation keeps actual status and skips POST and its commit", async () => {
  const controller = new AbortController();
  const { report, commits } = await run(
    step("apt.setVar('value','pre');", "pm.environment.set('env','leak');"),
    {
      signal: controller.signal,
      executeGrpc: async () => {
        controller.abort();
        return result([], 1);
      },
    },
  );
  assert.equal(report.status, "cancelled");
  assert.equal(commits.length, 0);
  assert.equal(report.results[0].grpcResult.status.code, 1);
  assert.equal(report.variables.value, "pre");
  assert.equal(report.variables.env, undefined);
});
test("rejected or uncertain POST persistence never publishes staged runtime or extraction", async () => {
  for (const uncertain of [false, true]) {
    const { report, urls } = await run(
      step(
        "apt.setVar('value','pre');",
        "apt.setVar('value','leak');pm.environment.set('env','leak');",
        { extract: [{ name: "picked", path: "$[0].text" }] },
      ),
      {
        onScopeChanges: async () => {
          throw uncertain
            ? new ProjectCommitUncertain("fixture", Error("fixture"))
            : Error("fixture");
        },
      },
    );
    assert.equal(report.status, "failed");
    assert.equal(report.variables.value, "pre");
    assert.equal(report.variables.env, undefined);
    assert.equal(report.variables.picked, undefined);
    assert.deepEqual(report.results[0].extracted, {});
    assert.equal(report.results[0].grpcResult.status.code, 0);
    if (uncertain) {
      assert.equal(report.results[0].scopeCommit.outcome, "unknown");
      assert.equal(urls.length, 0);
    } else assert.equal(urls[0], "http://example.invalid/pre");
  }
});
test("awaited timers and async assertions retain phase locals but fresh independent runs do not", async () => {
  const first = await run(
    step(
      "await new Promise(r=>setTimeout(r,1));pm.variables.set('temp','private');apt.setVar('value','pre');",
      "pm.test('async',async()=>{await Promise.resolve();pm.expect(pm.variables.get('temp')).to.equal('private');});",
    ),
  );
  assert.equal(first.report.status, "passed", JSON.stringify(first.report));
  const second = await run(
    step(
      "pm.test('isolated',()=>pm.expect(pm.variables.get('temp')).to.equal(undefined));",
    ),
  );
  assert.equal(second.report.status, "passed", JSON.stringify(second.report));
});

test("uncertain PRE persistence stops the plan without RPC or following HTTP", async () => {
  for (const error of [
    new ProjectCommitUncertain("fixture", Error("fixture")),
    Object.assign(Error("wrapped"), { code: "PROJECT_COMMIT_UNCERTAIN" }),
  ]) {
    const { report, calls, urls } = await run(
      step("apt.setVar('value','leak');pm.environment.set('env','leak');"),
      {
        onScopeChanges: async () => {
          throw error;
        },
      },
    );
    assert.equal(report.status, "failed");
    assert.equal(calls.length, 0);
    assert.equal(urls.length, 0);
    assert.equal(report.variables.value, "initial");
    assert.equal(report.variables.env, undefined);
    assert.deepEqual(report.results[0].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
      phase: "before",
    });
  }
});
test("already-started POST acknowledgement cancellation publishes one confirmed complete batch only", async () => {
  const controller = new AbortController(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const pending = run(
    step(
      "apt.setVar('value','pre');",
      "apt.setVar('value','post');pm.environment.set('env','post');",
      { extract: [{ name: "picked", path: "$[0].text" }] },
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
      throw Error(
        "POST did not reach pending commit: " + JSON.stringify(report),
      );
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
test("a pre-cancelled invocation does not run scripts and after-cancellation leaves no phase state", async () => {
  const before = new AbortController();
  before.abort();
  const first = await run(step("apt.setVar('value','leak');"), {
    signal: before.signal,
  });
  assert.equal(first.report.status, "cancelled");
  assert.equal(first.calls.length, 0);
  assert.deepEqual(first.report.results, []);
  const after = new AbortController();
  const second = await run(
    step(
      "apt.setVar('value','pre');",
      "apt.setVar('value','leak');await new Promise(r=>setTimeout(r,1000));",
    ),
    {
      signal: after.signal,
      executeGrpc: async (request) => {
        setTimeout(() => after.abort(), 50);
        return result(request.messages);
      },
    },
  );
  assert.equal(second.report.status, "cancelled");
  assert.equal(second.report.variables.value, "pre");
  assert.equal(second.report.results[0].grpcResult.status.code, 0);
  const fresh = await run(
    step(
      "pm.test('fresh',()=>pm.expect(pm.variables.get('value')).to.equal('initial'));",
    ),
  );
  assert.equal(fresh.report.status, "passed", JSON.stringify(fresh.report));
});

test("bare runPlan accepts a valid scripted gRPC step without optional display identity", async () => {
  const raw = step(
    "apt.setVar('value','raw');",
    "pm.test('raw',()=>pm.expect(grpc.result.messages[0].text).to.equal('raw'));",
  );
  delete raw.id;
  const report = await runPlan(
    { steps: [raw] },
    { value: "initial" },
    () => {
      throw Error("no HTTP");
    },
    { executeGrpc: async (request) => result(request.messages) },
  );
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(report.variables.value, "raw");
});
