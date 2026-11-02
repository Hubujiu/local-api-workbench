import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";

// These are real application/QuickJS/HTTP workflows for ordinary CI. They are
// not source-only tests and must not be used as local static verification.
const close = async (server) => {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const owner = async (app, path, body) => {
  const response = await fetch(app.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-local-token": app.token,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.ok, true, await response.clone().text());
  return response.json();
};
const projectPath = (project, action) =>
  "/api/projects/" + project.id + "/" + action;
const echoFixture = async (seen) => {
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const record = {
        path: request.url,
        method: request.method,
        contentType: request.headers["content-type"],
        body: raw ? JSON.parse(raw) : null,
      };
      seen.push(record);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(record));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ fixtureError: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: "http://127.0.0.1:" + server.address().port,
  };
};
const expectedGenerated = (lane) => ({
  number: 7,
  rows: [
    { side: "left" },
    { side: "right" },
    { side: "left" },
    { side: "right" },
  ],
  selected: "selected-value",
  sequence: [false, null],
  lane,
  unicode: "中文🙂",
});

const generateBefore = `
  if (typeof globalThis.__scriptMockPhase !== 'undefined') throw Error('PRE inherited a previous VM');
  globalThis.__scriptMockPhase = 'PRE';
  const template = {
    'number|7-7': 0,
    'rows|2': [{side:'left'},{side:'right'}],
    'selected|1': ['selected-value'],
    'sequence|1-1': [false,null],
    lane: pm.environment.get('lane'),
    unicode: '中文🙂'
  };
  const original = JSON.stringify(template);
  const generated = Mock.mock(template);
  pm.test('PRE generated without template mutation', () => {
    pm.expect(JSON.stringify(template)).to.equal(original);
    pm.expect(generated.number).to.equal(7);
    pm.expect(generated.rows.length).to.equal(4);
    pm.expect(generated.selected).to.equal('selected-value');
    pm.expect(generated.sequence).to.deep.equal([false,null]);
  });
  pm.environment.set('generatedNumber', generated.number);
  pm.variables.set('requestOnly', 'not-persisted');
  apt.setRequestBody(generated);
`;
const checkAfter = `
  if (typeof globalThis.__scriptMockPhase !== 'undefined') throw Error('POST inherited PRE state');
  globalThis.__scriptMockPhase = 'POST';
  const response = pm.response.json();
  const evidence = Mock.mock({phase:'POST','status|200-200':0,lane:response.body.lane});
  pm.test('POST checks the actual HTTP body', () => {
    pm.expect(pm.response.code).to.equal(evidence.status);
    pm.expect(response.path).to.equal('/generate');
    pm.expect(response.body.number).to.equal(7);
    pm.expect(response.body.rows).to.deep.equal([{side:'left'},{side:'right'},{side:'left'},{side:'right'}]);
    pm.expect(response.body.unicode).to.equal('中文🙂');
  });
  pm.environment.set('checkedLane', evidence.lane);
  pm.environment.set('checkedPhase', evidence.phase);
`;

test("persisted script Mock PRE to HTTP to POST to consumer survives frozen definitions, isolated environments and backup restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "script-mock-chain-"));
  const copyRoot = await mkdtemp(join(tmpdir(), "script-mock-copy-"));
  const seen = [];
  const fixture = await echoFixture(seen);
  const app = await createApp({ root, port: 0 });
  let copyApp;
  t.after(async () => {
    await Promise.all([
      close(app.server),
      close(copyApp?.server),
      close(fixture.server),
    ]);
    await Promise.all(
      [root, copyRoot].map((directory) =>
        rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        }),
      ),
    );
  });

  const project = await app.store.create("Script Mock frozen workflow");
  const primary = project.environments[0].id;
  project.environments[0].variables = { lane: "primary" };
  project.environments.push({
    id: "secondary",
    name: "Secondary",
    variables: { lane: "secondary" },
  });
  project.requests = [
    normalizeRequest({
      id: "generate",
      name: "Generate with script Mock",
      url: fixture.url + "/generate",
      method: "POST",
      bodyType: "json",
      body: "{}",
      beforeScript: generateBefore,
      afterScript: checkAfter,
    }),
    normalizeRequest({
      id: "consume",
      name: "Consume POST variables",
      url: fixture.url + "/consume",
      method: "POST",
      bodyType: "json",
      body: '{"number":{{generatedNumber}},"lane":"{{checkedLane}}","phase":"{{checkedPhase}}"}',
      afterScript: `
        pm.test('consumer receives committed PRE and POST values',()=>{
          const body=pm.response.json().body;
          pm.expect(body.number).to.equal(7);
          pm.expect(body.phase).to.equal('POST');
          pm.expect(body.lane).to.equal(pm.environment.get('lane'));
        });
      `,
    }),
  ];
  await app.store.save(project);
  const other = await app.store.create("Unrelated script Mock project");
  other.environments[0].variables = { lane: "unrelated", untouched: true };
  await app.store.save(other);
  const unrelatedBefore = await app.store.get(other.id);

  const plan = await owner(app, projectPath(project, "plans"), {
    name: "Frozen Mock generation and consumer",
    environmentId: primary,
    statusPolicy: "strict200",
    steps: project.requests.map((request) => ({ request })),
  });
  assert.equal(seen.length, 0, "saving a template does not generate or send");
  assert.equal(plan.steps[0].request.beforeScript, generateBefore);
  const edited = await app.store.get(project.id);
  edited.requests[0].beforeScript =
    "throw Error('live-only change must not run');";
  edited.requests[0].body = '{"live":"changed"}';
  await app.store.save(edited);

  const runAndCheck = async (targetApp, target, environmentId, lane) => {
    const start = seen.length;
    const run = await owner(targetApp, projectPath(target, "run"), {
      planId: plan.id,
      environmentId,
    });
    assert.equal(run.status, "passed", JSON.stringify(run.results));
    assert.equal(run.recordSaved, true);
    assert.equal(typeof run.id, "string");
    assert.notEqual(run.id, "");
    assert.equal(run.planId, plan.id);
    assert.match(run.planHash, /^[0-9a-f]{64}$/);
    assert.equal(run.results.length, 2);
    assert(run.results.every((result) => result.status === "passed"));
    assert.equal(run.results[0].response.status, 200);
    assert.deepEqual(
      JSON.parse(run.results[0].response.body).body,
      expectedGenerated(lane),
    );
    assert.deepEqual(seen.slice(start), [
      {
        path: "/generate",
        method: "POST",
        contentType: "application/json",
        body: expectedGenerated(lane),
      },
      {
        path: "/consume",
        method: "POST",
        contentType: "application/json",
        body: { number: 7, lane, phase: "POST" },
      },
    ]);
    const saved = await targetApp.store.get(target.id);
    const variables = saved.environments.find(
      (env) => env.id === environmentId,
    ).variables;
    assert.equal(variables.generatedNumber, 7);
    assert.equal(variables.checkedLane, lane);
    assert.equal(variables.checkedPhase, "POST");
    assert.equal(Object.hasOwn(variables, "requestOnly"), false);
    const record = saved.runs.find((item) => item.id === run.id);
    assert.ok(record, "the returned run ID must exist in the stored run list");
    assert.equal(record.status, "passed");
    assert.equal(record.source, "manual");
    assert.equal(record.planHash, run.planHash);
    assert.deepEqual(run.snapshot, saved.plans[0]);
    const expectedHash = createHash("sha256")
      .update(JSON.stringify(saved.plans[0]))
      .digest("hex");
    assert.equal(run.planHash, expectedHash);
    assert.equal(record.planHash, expectedHash);
    assert.deepEqual(record.results, run.results);
    assert.equal(saved.plans[0].steps[0].request.beforeScript, generateBefore);
    assert.equal(saved.plans[0].steps[0].request.body, "{}");
    const disk = await new Store(targetApp === app ? root : copyRoot).get(
      target.id,
    );
    assert.deepEqual(
      disk.runs.find((item) => item.id === run.id),
      record,
    );
    assert.deepEqual(disk.environments, saved.environments);
    return run;
  };

  const firstRun = await runAndCheck(app, project, primary, "primary");
  let saved = await app.store.get(project.id);
  assert.deepEqual(
    saved.environments.find((env) => env.id === "secondary").variables,
    { lane: "secondary" },
  );
  const secondRun = await runAndCheck(app, project, "secondary", "secondary");
  saved = await app.store.get(project.id);
  assert.equal(
    saved.environments.find((env) => env.id === primary).variables.checkedLane,
    "primary",
  );
  assert.deepEqual(await app.store.get(other.id), unrelatedBefore);

  const wireCount = seen.length;
  const backup = await owner(app, projectPath(project, "export"));
  const backupBefore = structuredClone(backup);
  copyApp = await createApp({ root: copyRoot, port: 0 });
  const restored = await owner(copyApp, "/api/restore", { document: backup });
  assert.notEqual(restored.id, project.id);
  assert.equal(
    seen.length,
    wireCount,
    "backup and restore must not execute scripts",
  );
  assert.deepEqual(backup, backupBefore);
  assert.deepEqual(restored.plans, backup.plans);
  assert.deepEqual(restored.runs, backup.runs);
  assert.equal(restored.runs.length, 2);
  assert(restored.runs.some((run) => run.id === firstRun.id));
  assert(restored.runs.some((run) => run.id === secondRun.id));
  const freshStore = new Store(copyRoot);
  assert.deepEqual((await freshStore.get(restored.id)).runs, backup.runs);

  await close(copyApp.server);
  copyApp = await createApp({ root: copyRoot, port: 0 });
  await runAndCheck(copyApp, restored, primary, "primary");
  assert.equal((await copyApp.store.get(restored.id)).runs.length, 3);
  assert.equal((await app.store.get(project.id)).runs.length, 2);
  assert.deepEqual(await app.store.get(other.id), unrelatedBefore);
});

test("script Mock refusal sends no PRE request and preserves POST wire evidence without publishing failed-phase variables", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "script-mock-failure-"));
  const seen = [];
  const fixture = await echoFixture(seen);
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await Promise.all([close(app.server), close(fixture.server)]);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const project = await app.store.create("Script Mock phase failures");
  project.environments[0].variables = { marker: "original" };
  project.globalVariables = { globalMarker: "original" };
  await app.store.save(project);
  const invalid = `
    pm.environment.set('marker','failed-phase');
    pm.globals.set('globalMarker','failed-phase');
    Mock.mock({value:'@missing(globalThis.__templateExecuted=true)'});
    pm.environment.set('unexpectedSuccess',true);
  `;
  const failed = (result) => {
    assert.equal(result.outcome, "failed");
    assert.equal(result.error, "Mock模板: 暂不支持占位符或含@字符串");
    assert.doesNotMatch(result.error, /not defined|is not a function/);
    assert.equal(result.scriptStage, "script");
  };
  const before = await owner(app, projectPath(project, "execute"), {
    request: { url: fixture.url + "/must-not-send", beforeScript: invalid },
  });
  failed(before);
  assert.deepEqual(seen, []);
  assert.equal(before.variableWrites.commits, 0);
  let saved = await app.store.get(project.id);
  assert.equal(saved.environments[0].variables.marker, "original");
  assert.equal(saved.globalVariables.globalMarker, "original");
  assert.equal(Object.hasOwn(saved.history[0], "response"), false);
  assert.equal(saved.history[0].status, "failed");
  assert.equal(saved.history[0].requestUnresolved, true);
  assert.equal(saved.history[0].source, "manual");
  assert.equal(saved.history[0].error, "Mock模板: 暂不支持占位符或含@字符串");

  const after = await owner(app, projectPath(project, "execute"), {
    request: {
      url: fixture.url + "/post-failure",
      method: "POST",
      bodyType: "json",
      body: "{}",
      beforeScript: `
        const body=Mock.mock({'number|9-9':0,phase:'PRE'});
        apt.setRequestBody(body);
        pm.environment.set('marker','confirmed-PRE');
      `,
      afterScript: invalid,
    },
  });
  failed(after);
  assert.equal(after.status, 200);
  assert.equal(after.variableWrites.commits, 1);
  assert.deepEqual(JSON.parse(after.body).body, { number: 9, phase: "PRE" });
  assert.deepEqual(
    seen.map((item) => item.path),
    ["/post-failure"],
  );
  saved = await app.store.get(project.id);
  assert.equal(saved.environments[0].variables.marker, "confirmed-PRE");
  assert.equal(saved.globalVariables.globalMarker, "original");
  assert.equal(
    Object.hasOwn(saved.environments[0].variables, "unexpectedSuccess"),
    false,
  );
  const postHistory = saved.history.find((item) => item.response);
  assert.ok(postHistory, "POST failure must keep a real stored HTTP response");
  assert.equal(postHistory.status, "failed");
  assert.equal(postHistory.source, "manual");
  assert.equal(postHistory.response.body, after.body);
  assert.equal(postHistory.error, "Mock模板: 暂不支持占位符或含@字符串");
  const historyBefore = structuredClone(saved.history);

  await close(app.server);
  app = await createApp({ root, port: 0 });
  saved = await app.store.get(project.id);
  assert.deepEqual(saved.history, historyBefore);
  const recovery = await owner(app, projectPath(project, "execute"), {
    request: {
      url: fixture.url + "/fresh-recovery",
      method: "POST",
      bodyType: "json",
      body: "{}",
      beforeScript: `
        if(typeof globalThis.__templateExecuted!=='undefined')throw Error('template code leaked');
        apt.setRequestBody(Mock.mock({ok:true}));
        pm.test('confirmed PRE survived',()=>pm.expect(pm.environment.get('marker')).to.equal('confirmed-PRE'));
      `,
    },
  });
  assert.equal(recovery.outcome, "passed", JSON.stringify(recovery));
  assert.deepEqual(JSON.parse(recovery.body).body, { ok: true });
  assert.deepEqual(
    seen.map((item) => item.path),
    ["/post-failure", "/fresh-recovery"],
  );
});

test("concurrent script Mock requests keep source templates, guest state and project writes isolated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "script-mock-concurrent-"));
  const seen = [];
  const fixture = await echoFixture(seen);
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await Promise.all([close(app.server), close(fixture.server)]);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const projects = await Promise.all([
    app.store.create("Mock concurrency left"),
    app.store.create("Mock concurrency right"),
  ]);
  const outputs = await Promise.all(
    projects.map((project, index) =>
      owner(app, projectPath(project, "execute"), {
        request: {
          url: fixture.url + "/concurrent-" + index,
          method: "POST",
          bodyType: "json",
          body: "{}",
          beforeScript: `
            if(typeof globalThis.__privateMockRun!=='undefined')throw Error('shared guest');
            globalThis.__privateMockRun=${index};
            const template={'id|${index}-${index}':0,owner:${JSON.stringify(project.id)}};
            const first=Mock.mock(template);
            first.owner='changed-output';
            const second=Mock.mock(template);
            if(template.owner!==${JSON.stringify(project.id)}||second.owner!==${JSON.stringify(project.id)})throw Error('template mutated');
            apt.setRequestBody(second);
            pm.environment.set('mockOwner',second.owner);
          `,
        },
      }),
    ),
  );
  for (const [index, output] of outputs.entries()) {
    assert.equal(output.outcome, "passed", JSON.stringify(output));
    assert.equal(output.variableWrites.commits, 1);
    assert.deepEqual(JSON.parse(output.body).body, {
      id: index,
      owner: projects[index].id,
    });
    const saved = await app.store.get(projects[index].id);
    assert.equal(saved.environments[0].variables.mockOwner, projects[index].id);
    assert.equal(saved.history.length, 1);
    assert.equal(saved.history[0].status, "passed");
  }
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((item) => item.path).sort(), [
    "/concurrent-0",
    "/concurrent-1",
  ]);
});
