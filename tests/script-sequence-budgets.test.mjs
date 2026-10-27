import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runScriptSequence } from "../src/scripts.mjs";

const stages = (code) => [{ name: "request", code }];

test("script sequences validate explicit budgets even without runnable stages", async () => {
  for (const options of [
    { activityBudgetMs: 251 },
    { activityBudgetMs: 0 },
    { wallBudgetMs: 2001 },
    { wallBudgetMs: NaN },
    { requestLimit: 11 },
    { requestLimit: -1 },
    { timerLimit: 101 },
    { timerLimit: 0.5 },
    { fakerLimit: 1001 },
    { jobLimit: 10001 },
    { assertionLimit: 1001 },
  ]) {
    await assert.rejects(
      runScriptSequence([], { variables: {} }, options),
      /预算/,
    );
  }
});

test("script sequences honor smaller activity and wall budgets rather than resetting defaults", async () => {
  await assert.rejects(
    runScriptSequence(
      stages('throw Error("budget-probe")'),
      { variables: {} },
      { activityBudgetMs: 37 },
    ),
    (error) => {
      assert.equal(error.scriptDiagnostics.activityBudgetMs, 37);
      return true;
    },
  );
  await assert.rejects(
    runScriptSequence(
      stages("await new Promise(r=>setTimeout(r,100))"),
      { variables: {} },
      { wallBudgetMs: 1 },
    ),
    /超时/,
  );
});

test("script sequence zero quotas reject work before issuing HTTP or scheduling operations", async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const input = { variables: {}, allowNetwork: true };
  for (const [options, code, message] of [
    [
      { requestLimit: 0 },
      `await pm.sendRequest("http://127.0.0.1:${server.address().port}/")`,
      /最多10次/,
    ],
    [{ timerLimit: 0 }, "setTimeout(()=>{},0)", /最多100次/],
    [
      { fakerLimit: 0 },
      'pm.variables.replaceIn("{{$randomFirstName}}")',
      /最多1000次/,
    ],
    [{ assertionLimit: 0 }, 'pm.test("one",()=>{})', /最多1000条/],
    [{ jobLimit: 0 }, "await Promise.resolve()", /微任务最多10000/],
  ]) {
    await assert.rejects(
      runScriptSequence(stages(code), input, options),
      message,
    );
  }
  assert.equal(requests, 0);
});

test("lower sequence quotas are cumulative across fresh script scopes", async () => {
  for (const [options, code, message] of [
    [{ timerLimit: 1 }, "await new Promise(r=>setTimeout(r,0))", /最多100次/],
    [
      { fakerLimit: 1 },
      'pm.variables.replaceIn("{{$randomFirstName}}")',
      /最多1000次/,
    ],
    [{ assertionLimit: 1 }, 'pm.test("one",()=>{})', /最多1000条/],
  ]) {
    await assert.rejects(
      runScriptSequence(
        [
          { name: "project", code },
          { name: "request", code },
        ],
        { variables: {} },
        options,
      ),
      (error) => {
        assert.equal(error.scriptScope, "request");
        assert.match(error.message, message);
        assert.equal(error.sequenceActivity.length, 1);
        return true;
      },
    );
  }
});

test("reported sequence activity uses the requested initial budget", async () => {
  const result = await runScriptSequence(
    stages('pm.variables.set("saved",7)'),
    { variables: {} },
    { activityBudgetMs: 120 },
  );
  assert.equal(result.localVariables.saved, 7);
  assert.ok(result.activityMs >= 0 && result.activityMs <= 120);
  const empty = await runScriptSequence(
    [],
    { variables: {} },
    { activityBudgetMs: 120 },
  );
  assert.equal(empty.activityMs, 0);
});

test("a reduced network quota covers the entire sequence and retains completed request evidence", async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const code = `await pm.sendRequest("http://127.0.0.1:${server.address().port}/")`;
  await assert.rejects(
    runScriptSequence(
      [
        { name: "project", code },
        { name: "request", code },
      ],
      { variables: {}, allowNetwork: true },
      { requestLimit: 1 },
    ),
    (error) => {
      assert.match(error.message, /最多10次/);
      assert.equal(error.scriptScope, "request");
      assert.equal(error.networkRequests.length, 1);
      assert.equal(error.networkRequests[0].status, "completed");
      assert.equal(error.networkRequests[0].scope, "project");
      return true;
    },
  );
  assert.equal(requests, 1);
});
