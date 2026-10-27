import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

// Ordinary guest-owned buffers, bounded at twenty MiB. The old engine accepted
// all of these because cumulative payload bytes were not accounted for.
const exhaust = `
  pm.environment.set('marker', 'uncommitted');
  pm.globals.set('globalMarker', 'uncommitted');
  const held = [];
  for (let i = 0; i < 20; i++) held.push(new ArrayBuffer(1024 * 1024));
  pm.environment.set('unexpectedSuccess', held.length);
`;
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

test("real debug and plan OOM preserve phase commits, history, project isolation and recovery after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quickjs-heap-workflow-"));
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
  const project = await app.store.create("Heap failure");
  project.environments[0].variables = { marker: "original" };
  project.globalVariables = { globalMarker: "original" };
  await app.store.save(project);
  const other = await app.store.create("Separate project");
  other.environments[0].variables = { marker: "isolated" };
  await app.store.save(other);
  const url = `http://127.0.0.1:${fixture.address().port}`;
  const oom = (result) => {
    assert.equal(result.outcome ?? result.status, "failed");
    assert.match(result.error, /out of memory/);
    assert.equal(result.scriptStage, "script");
    assert.equal(result.scriptDiagnostics.activityBudgetMs, 250);
  };
  const before = await call(project, "execute", {
    request: { url: url + "/must-not-send", beforeScript: exhaust },
  });
  oom(before);
  assert.deepEqual(seen, []);
  let saved = await app.store.get(project.id);
  assert.equal(saved.environments[0].variables.marker, "original");
  assert.equal(saved.globalVariables.globalMarker, "original");
  assert.equal(saved.history[0].response, undefined);
  assert.match(saved.history[0].error, /out of memory/);

  const after = await call(project, "execute", {
    request: {
      url: url + "/post-failure",
      beforeScript: "pm.environment.set('marker','before-committed');",
      afterScript: exhaust,
    },
  });
  oom(after);
  assert.equal(after.status, 200);
  assert.equal(after.body, '{"wire":"unchanged"}');
  assert.deepEqual(seen, ["/post-failure"]);
  saved = await app.store.get(project.id);
  assert.equal(saved.environments[0].variables.marker, "before-committed");
  assert.equal(saved.globalVariables.globalMarker, "original");
  assert.equal(
    Object.hasOwn(saved.environments[0].variables, "unexpectedSuccess"),
    false,
  );
  const postHistory = saved.history.find((item) => item.response);
  assert.equal(postHistory.response.body, after.body);
  assert.equal(postHistory.status, "failed");
  assert.match(postHistory.error, /out of memory/);
  assert.equal(
    (await call(project, "debug-variables")).variables.marker,
    "before-committed",
  );

  // Plans must retain the failed step and let a later ordinary request use a
  // fresh runtime, not the exhausted instance or partially written variables.
  const plan = await call(project, "plans", {
    name: "Heap rollback and next step",
    steps: [
      { request: { url: url + "/plan-must-not-send", beforeScript: exhaust } },
      {
        request: {
          url: url + "/plan-recovery",
          beforeScript:
            "pm.test('committed',()=>pm.expect(pm.environment.get('marker')).to.equal('before-committed'));",
        },
      },
    ],
  });
  const run = await call(project, "run", { planId: plan.id });
  assert.equal(run.status, "failed");
  assert.equal(run.results.length, 2);
  oom(run.results[0]);
  assert.equal(run.results[0].response, undefined);
  assert.equal(run.results[1].status, "passed", JSON.stringify(run.results[1]));
  assert.equal(run.results[1].response.status, 200);
  assert.deepEqual(seen, ["/post-failure", "/plan-recovery"]);
  saved = await app.store.get(project.id);
  assert.equal(saved.runs.find((item) => item.id === run.id).status, "failed");
  assert.equal(
    (await app.store.get(other.id)).environments[0].variables.marker,
    "isolated",
  );
  assert.equal((await app.store.get(other.id)).history.length, 0);

  await close(app.server);
  app = await createApp({ root, port: 0 });
  saved = await app.store.get(project.id);
  assert.equal(saved.history.length, 2);
  assert(
    saved.history.every(
      (item) => item.status === "failed" && /out of memory/.test(item.error),
    ),
  );
  assert.equal(saved.runs[0].results[0].response, undefined);
  assert.equal(saved.runs[0].results[1].status, "passed");
  const recovered = await call(project, "execute", {
    request: {
      url: url + "/after-restart",
      beforeScript:
        "pm.test('saved',()=>pm.expect(pm.environment.get('marker')).to.equal('before-committed'));pm.environment.set('recovered',true);",
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
