import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";

const policy = { mode: "same-origin", maxHops: 3 };

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "redirect-owner-"));
  const seen = [],
    foreignSeen = [];
  const foreign = createServer((request, response) => {
    foreignSeen.push(request.url);
    response.end("must not reach foreign origin");
  });
  foreign.listen(0, "127.0.0.1");
  await once(foreign, "listening");
  const foreignURL = `http://127.0.0.1:${foreign.address().port}`;
  const origin = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url });
    if (request.url === "/start?seed=once") {
      response.writeHead(302, { Location: "/final?next=only" });
      response.end("local redirect");
    } else if (request.url === "/blocked") {
      response.writeHead(302, {
        Location: foreignURL + "/credential-boundary",
        "Content-Type": "application/json",
      });
      response.end('{"value":"must-not-extract"}');
    } else {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ value: request.url }));
    }
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const url = `http://127.0.0.1:${origin.address().port}`;
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await Promise.all([close(app.server), close(origin), close(foreign)]);
    await rm(root, { recursive: true, force: true });
  });
  async function api(route, data, method = "POST") {
    const response = await fetch(app.url + "/api" + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await response.text();
    assert.equal(response.ok, true, text);
    return JSON.parse(text);
  }
  const project = await api("/projects", { name: "Redirect round trip" });
  project.environments = [
    { id: "selected", name: "Selected", variables: { guard: "selected" } },
    { id: "other", name: "Other", variables: { guard: "other" } },
  ];
  project.globalVariables = { globalGuard: "unchanged" };
  const route = "/projects/" + project.id;
  await api(route, project, "PUT");
  return {
    root,
    url,
    seen,
    foreignSeen,
    project,
    route,
    api,
    async restart() {
      await close(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}

function definition(url, id = "redirect-api") {
  return {
    id,
    name: "Redirect API",
    method: "GET",
    url,
    redirect: policy,
    timeout: 10000,
  };
}

async function cli(t, root, projectId, planId, output) {
  const args = [
    "scripts/run-plan.mjs",
    "--project",
    projectId,
    "--plan",
    planId,
    "--environment",
    "selected",
    "--output",
    output,
  ];
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, LOCAL_API_DATA: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let timer;
  try {
    const [code, signal] = await Promise.race([
      once(child, "close"),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(Error("redirect CLI fixture deadline"));
        }, 15000);
      }),
    ]);
    assert.equal(signal, null, stderr);
    const run = JSON.parse(stdout);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), run);
    return { code, run, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function assertFollowed(response, url) {
  assert.equal(response.status, 200);
  assert.equal(response.effectiveUrl, url + "/final?next=only");
  assert.equal(response.request.url, url + "/final?next=only");
  assert.equal(JSON.parse(response.body).value, "/final?next=only");
  assert.deepEqual(
    response.redirectTrace.map((hop) => [hop.status, hop.url]),
    [
      [302, url + "/start?seed=once"],
      [200, url + "/final?next=only"],
    ],
  );
}

// Every definition in this file is script-free; declarative extraction/after
// operations are deliberately used only to prove failure skips post-work.
test("owner redirect definitions survive saved case/plan freezing, real CLI, backup restore and app restart without replay", async (t) => {
  const f = await fixture(t);
  let project = await f.api(f.route, undefined, "GET");
  const request = {
    ...definition(f.url + "/start"),
    query: [{ key: "seed", value: "once", enabled: true }],
  };
  project.requests = [request];
  await f.api(f.route, project, "PUT");
  project = await f.api(f.route, undefined, "GET");
  assert.deepEqual(project.requests[0].redirect, policy);
  const direct = await f.api(f.route + "/execute", {
    request: project.requests[0],
    environmentId: "selected",
  });
  assert.equal(direct.outcome, "passed");
  assertFollowed(direct, f.url);

  const { item } = await f.api(f.route + "/cases", {
    id: "frozen-case",
    name: "Frozen redirect case",
    sourceRequestId: request.id,
    request: project.requests[0],
  });
  assert.deepEqual(item.request.redirect, policy);
  const plan = await f.api(f.route + "/plans", {
    id: "frozen-plan",
    name: "Frozen redirect plan",
    environmentId: "selected",
    steps: [{ request: item.request }],
  });
  assert.deepEqual(plan.steps[0].request.redirect, policy);

  project = await f.api(f.route, undefined, "GET");
  project.requests[0].url = f.url + "/live-changed";
  delete project.requests[0].redirect;
  await f.api(f.route, project, "PUT");
  project = await f.api(f.route, undefined, "GET");
  assert.equal(project.requests[0].redirect, undefined);
  assert.deepEqual(project.cases[0].request.redirect, policy);
  assert.deepEqual(project.plans[0].steps[0].request.redirect, policy);
  const caseRun = await f.api(f.route + "/execute", {
    request: project.cases[0].request,
    environmentId: "selected",
  });
  assert.equal(caseRun.outcome, "passed");
  assertFollowed(caseRun, f.url);
  const cliRun = await cli(
    t,
    f.root,
    project.id,
    "frozen-plan",
    path.join(f.root, "cli.json"),
  );
  assert.equal(cliRun.code, 0, cliRun.stderr);
  assert.equal(cliRun.run.recordSaved, true);
  assert.equal(cliRun.run.status, "passed");
  assertFollowed(cliRun.run.results[0].response, f.url);
  assert.deepEqual(cliRun.run.snapshot.steps[0].request.redirect, policy);

  const count = f.seen.length;
  assert.equal(count, 6);
  const backup = await f.api(f.route + "/export", undefined, "GET");
  const restored = await f.api("/restore", { document: backup });
  assert.notEqual(restored.id, project.id);
  assert.equal(f.seen.length, count, "export and restore never execute HTTP");
  await f.restart();
  const reopened = await f.api("/projects/" + restored.id, undefined, "GET");
  assert.equal(f.seen.length, count, "reopening stored evidence never replays");
  assert.deepEqual(reopened.cases[0].request.redirect, policy);
  assert.deepEqual(reopened.plans[0].steps[0].request.redirect, policy);
  const recorded = reopened.runs.find((run) => run.id === cliRun.run.id);
  assertFollowed(recorded.results[0].response, f.url);
  assert.deepEqual(recorded.snapshot.steps[0].request.redirect, policy);
  const resumed = await f.api("/projects/" + restored.id + "/run", {
    planId: "frozen-plan",
    environmentId: "selected",
  });
  assert.equal(resumed.status, "passed");
  assertFollowed(resumed.results[0].response, f.url);
  assert.equal(f.seen.length, count + 2);
  assert.equal(
    f.seen.some((entry) => entry.url.startsWith("/live-changed")),
    false,
  );
  assert.deepEqual(f.foreignSeen, []);
  const original = await new Store(f.root).get(project.id);
  assert.equal(
    original.runs.length,
    1,
    "restored run is isolated from original",
  );
  assert.deepEqual(
    original.environments.map((environment) => environment.variables),
    [{ guard: "selected" }, { guard: "other" }],
  );
  assert.deepEqual(original.globalVariables, { globalGuard: "unchanged" });
});

test("owner and actual CLI retain blocked redirect 302 evidence, skip post-work and following steps, and preserve it through restore", async (t) => {
  const f = await fixture(t);
  const request = {
    ...definition(f.url + "/blocked", "blocked-api"),
    expectedStatus: 302,
    assertions: [{ target: "status", op: "eq", value: 302 }],
    extract: [{ name: "mustNotExtract", path: "$.value", scope: "global" }],
    after: [{ type: "set", name: "mustNotRunAfter", value: "bad" }],
  };
  let project = await f.api(f.route, undefined, "GET");
  project.requests = [request];
  await f.api(f.route, project, "PUT");
  const direct = await f.api(f.route + "/execute", {
    request,
    environmentId: "selected",
  });
  assert.equal(direct.outcome, "failed");
  assert.equal(direct.status, 302);
  assert.equal(direct.redirectFailure.reason, "origin");
  assert.equal(direct.redirectFailure.retry_safe, false);
  assert.equal(direct.redirectFailure.responseComplete, true);
  assert.equal(direct.request.url, f.url + "/blocked");
  assert.deepEqual(direct.assertions, []);
  assert.equal(direct.extracted.mustNotExtract, undefined);
  assert.equal(direct.extracted.mustNotRunAfter, undefined);
  await f.api(f.route + "/plans", {
    id: "blocked-plan",
    name: "Blocked redirect plan",
    environmentId: "selected",
    steps: [
      { request, expectedStatus: 302 },
      { request: { url: f.url + "/must-not-follow" } },
    ],
  });
  const failed = await cli(
    t,
    f.root,
    f.project.id,
    "blocked-plan",
    path.join(f.root, "failed.json"),
  );
  assert.equal(failed.code, 1, failed.stderr);
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.recordSaved, true);
  assert.equal(failed.run.results.length, 1);
  const record = failed.run.results[0];
  assert.equal(record.status, "failed");
  assert.equal(record.response.status, 302);
  assert.equal(record.redirectFailure.reason, "origin");
  assert.deepEqual(record.assertions, []);
  assert.deepEqual(record.extracted, {});
  assert.equal(failed.run.variables.mustNotExtract, undefined);
  assert.equal(failed.run.variables.mustNotRunAfter, undefined);
  assert.deepEqual(
    f.seen.map((entry) => entry.url),
    ["/blocked", "/blocked"],
  );
  assert.deepEqual(f.foreignSeen, []);
  const backup = await f.api(f.route + "/export", undefined, "GET");
  const restored = await f.api("/restore", { document: backup });
  await f.restart();
  project = await f.api("/projects/" + restored.id, undefined, "GET");
  assert.deepEqual(
    f.seen.map((entry) => entry.url),
    ["/blocked", "/blocked"],
  );
  assert.deepEqual(f.foreignSeen, []);
  assert.equal(project.history[0].response.status, 302);
  assert.equal(project.history[0].redirectFailure.reason, "origin");
  assert.equal(project.runs[0].results[0].response.status, 302);
  assert.deepEqual(
    project.runs[0].results[0].redirectFailure,
    record.redirectFailure,
  );
  assert.deepEqual(project.globalVariables, { globalGuard: "unchanged" });
  assert.deepEqual(
    project.environments.map((environment) => environment.variables),
    [{ guard: "selected" }, { guard: "other" }],
  );
});
