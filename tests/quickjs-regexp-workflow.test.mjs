import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

// Independently authored, valid patterns and a fixed 65-character subject.
// The production worker retains its 250ms activity and 2s wall deadlines.
// These test matching interruption, not regexp compilation interruption.
const interrupt = (expression) => `
  pm.environment.set('marker', 'uncommitted');
  pm.globals.set('globalMarker', 'uncommitted');
  const subject = 'a'.repeat(64) + '!';
  try {
    ${expression};
  } catch (error) {
    pm.environment.set('caughtInterrupt', true);
  }
  pm.environment.set('unexpectedSuccess', true);
`;
const testMatch = interrupt("/(a+)+$/.test(subject)");
const deleteMatch = interrupt("subject.replace(/(a+)+$/g, '')");
const execMatch = interrupt("/(a+)+$/.exec(subject)");
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

test("real regex interruption rolls back failed phases and preserves HTTP, plan, isolation and restart evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quickjs-regexp-workflow-"));
  const seen = [];
  const fixture = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end('{"wire":"unchanged"}');
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await Promise.all([close(app.server), close(fixture)]);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const call = async (project, action, data) => {
    const response = await fetch(
      `${app.url}/api/projects/${project.id}/${action}`,
      {
        method: data === undefined ? "GET" : "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      },
    );
    assert(response.ok, await response.clone().text());
    return response.json();
  };
  const project = await app.store.create("Regex interruption");
  project.environments[0].variables = { marker: "original" };
  project.globalVariables = { globalMarker: "original" };
  await app.store.save(project);
  const other = await app.store.create("Independent regex project");
  other.environments[0].variables = { marker: "isolated" };
  await app.store.save(other);
  const url = `http://127.0.0.1:${fixture.address().port}`;
  const timeoutMessage = /^脚本执行超时$/;
  const interrupted = (result) => {
    assert.equal(result.outcome ?? result.status, "failed");
    assert.match(result.error, timeoutMessage, JSON.stringify(result));
    assert.doesNotMatch(result.error, /out of memory/);
    // The old C matcher reaches the parent wall timeout instead. That is not
    // accepted as evidence that the activity deadline interrupted matching.
    assert.equal(result.scriptStage, "script");
    assert.equal(result.scriptDiagnostics.activityBudgetMs, 250);
    // Async guest functions return a rejected Promise after the engine
    // interrupts. The next charged promise-state operation then reports the
    // exhausted budget before inspecting it. This is not a wall timeout.
    assert.equal(result.scriptDiagnostics.activityOperation, "promise-state");
  };
  const unchangedFailureScope = (saved, marker) => {
    assert.equal(saved.environments[0].variables.marker, marker);
    assert.equal(saved.globalVariables.globalMarker, "original");
    for (const key of ["caughtInterrupt", "unexpectedSuccess"])
      assert.equal(Object.hasOwn(saved.environments[0].variables, key), false);
  };

  const before = await call(project, "execute", {
    request: { url: url + "/must-not-send", beforeScript: testMatch },
  });
  interrupted(before);
  assert.deepEqual(seen, []);
  let saved = await app.store.get(project.id);
  unchangedFailureScope(saved, "original");
  assert.equal(saved.history[0].response, undefined);
  assert.match(saved.history[0].error, timeoutMessage);

  // Empty replacement with a standard global RegExp exercises the engine's
  // separate JS_RegExpDelete call site, not just RegExp.prototype.exec.
  const after = await call(project, "execute", {
    request: {
      url: url + "/post-failure",
      beforeScript: "pm.environment.set('marker','before-committed');",
      afterScript: deleteMatch,
    },
  });
  interrupted(after);
  assert.equal(after.status, 200);
  assert.equal(after.body, '{"wire":"unchanged"}');
  assert.deepEqual(seen, ["/post-failure"]);
  saved = await app.store.get(project.id);
  unchangedFailureScope(saved, "before-committed");
  const postHistory = saved.history.find((item) => item.response);
  assert.equal(postHistory.response.body, after.body);
  assert.equal(postHistory.status, "failed");
  assert.match(postHistory.error, timeoutMessage);
  assert.equal(
    (await call(project, "debug-variables")).variables.marker,
    "before-committed",
  );

  const plan = await call(project, "plans", {
    name: "Regex interruption followed by a fresh runtime",
    steps: [
      {
        request: { url: url + "/plan-must-not-send", beforeScript: execMatch },
      },
      {
        request: {
          url: url + "/plan-recovery",
          beforeScript:
            "pm.test('committed',()=>pm.expect(pm.environment.get('marker')).to.equal('before-committed'));pm.test('normal regex',()=>pm.expect(/^a+$/.test('aaaa')).to.equal(true));",
        },
      },
    ],
  });
  const run = await call(project, "run", { planId: plan.id });
  assert.equal(run.status, "failed");
  assert.equal(run.results.length, 2);
  interrupted(run.results[0]);
  assert.equal(run.results[0].response, undefined);
  assert.equal(run.results[1].status, "passed", JSON.stringify(run.results[1]));
  assert.equal(run.results[1].response.status, 200);
  assert.deepEqual(seen, ["/post-failure", "/plan-recovery"]);
  saved = await app.store.get(project.id);
  unchangedFailureScope(saved, "before-committed");
  assert.equal(saved.runs.find((item) => item.id === run.id).status, "failed");
  assert.equal(
    (await app.store.get(other.id)).environments[0].variables.marker,
    "isolated",
  );
  assert.equal((await app.store.get(other.id)).history.length, 0);

  await close(app.server);
  app = await createApp({ root, port: 0 });
  saved = await app.store.get(project.id);
  unchangedFailureScope(saved, "before-committed");
  assert.equal(saved.history.length, 2);
  assert(
    saved.history.every(
      (item) => item.status === "failed" && timeoutMessage.test(item.error),
    ),
  );
  assert.equal(saved.runs[0].results[0].response, undefined);
  assert.equal(saved.runs[0].results[1].status, "passed");
  const recovered = await call(project, "execute", {
    request: {
      url: url + "/after-restart",
      beforeScript:
        "pm.test('saved',()=>pm.expect(pm.environment.get('marker')).to.equal('before-committed'));pm.test('normal regex after restart',()=>pm.expect('aa'.replace(/a/g,'')).to.equal(''));pm.environment.set('recovered',true);",
    },
  });
  assert.equal(recovered.outcome, "passed", JSON.stringify(recovered));
  assert.equal(
    (await app.store.get(project.id)).environments[0].variables.recovered,
    true,
  );
  assert.equal(
    (await app.store.get(other.id)).environments[0].variables.marker,
    "isolated",
  );
  assert.deepEqual(seen, ["/post-failure", "/plan-recovery", "/after-restart"]);
});
