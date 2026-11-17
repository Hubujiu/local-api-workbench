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
import { snapshotPlan } from "../src/core.mjs";
import { ProjectCookieJar } from "../src/cookie-jar.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";

const cancelledMessage = "请求已取消 (aborted)";
const timeoutMessage = "请求超时（总时限已到）";
const completedCancellation = {
  phase: "cookie-capture",
  code: "REQUEST_CANCELLED",
  retry_safe: false,
};

function deferred() {
  let resolve;
  const promise = new Promise((accept) => (resolve = accept));
  return { promise, resolve };
}

async function bounded(promise, description, milliseconds = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Fixture deadline: " + description)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "cookie-entrypoints-"));
  const seen = [];
  let beforeReply;
  const origin = createServer((request, response) => {
    seen.push({ url: request.url, cookie: request.headers.cookie || "" });
    Promise.resolve()
      .then(() => beforeReply?.(request))
      .then(() => {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Set-Cookie", "received=origin; Path=/");
        response.end(JSON.stringify({ value: "published-only-when-healthy" }));
      })
      .catch((error) => {
        response.statusCode = 500;
        response.end(error.message);
      });
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const url = `http://127.0.0.1:${origin.address().port}`;
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    origin.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => app.server.close(resolve)),
      new Promise((resolve) => origin.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Cookie entrypoint owner");
  project.globalVariables = { globalGuard: "unchanged" };
  project.environments = [
    { id: "selected", name: "Selected", variables: { envGuard: "unchanged" } },
    { id: "other", name: "Other", variables: { envGuard: "isolated" } },
  ];
  await app.store.save(project);
  const otherProject = await app.store.create("Cookie entrypoint other");
  const jar = new ProjectCookieJar(root, project.id, "selected");
  const otherEnvironmentJar = new ProjectCookieJar(root, project.id, "other");
  const otherProjectJar = new ProjectCookieJar(
    root,
    otherProject.id,
    otherProject.environments[0].id,
  );
  for (const [session, cookie] of [
    [jar, "seed=selected"],
    [otherEnvironmentJar, "seed=other-environment"],
    [otherProjectJar, "seed=other-project"],
  ]) {
    await session.setCookie(url, cookie + "; Path=/", { expectedRevision: 0 });
    await session.configure({ enabled: true, expectedRevision: 1 });
  }
  const otherJarBytes = await Promise.all(
    [otherEnvironmentJar, otherProjectJar].map((session) =>
      readFile(session.file, "utf8"),
    ),
  );
  async function api(route, body, method = "POST") {
    const response = await fetch(app.url + "/api" + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.ok, true, await response.clone().text());
    return response.json();
  }
  async function assertOtherJarsUnchanged() {
    assert.deepEqual(
      await Promise.all(
        [otherEnvironmentJar, otherProjectJar].map((session) =>
          readFile(session.file, "utf8"),
        ),
      ),
      otherJarBytes,
    );
  }
  return {
    root,
    app,
    project,
    jar,
    url,
    seen,
    api,
    assertOtherJarsUnchanged,
    route: "/projects/" + project.id,
    setBeforeReply(value) {
      beforeReply = value;
    },
    async assertIsolation() {
      await assertOtherJarsUnchanged();
      const stored = await new Store(root).get(project.id);
      assert.deepEqual(stored.globalVariables, { globalGuard: "unchanged" });
      assert.deepEqual(stored.environments[0].variables, {
        envGuard: "unchanged",
      });
      assert.deepEqual(stored.environments[1].variables, {
        envGuard: "isolated",
      });
      return stored;
    },
  };
}

// Observe the real owner-created jar without replacing its implementation or
// the HTTP executor. Scope the observation to this test's own selected jar.
function observeJar(t, jar, method, pathname) {
  const entered = deferred();
  const original = ProjectCookieJar.prototype[method];
  t.mock.method(ProjectCookieJar.prototype, method, function (...args) {
    const pending = Reflect.apply(original, this, args);
    if (this.file === jar.file && new URL(args[0]).pathname === pathname)
      entered.resolve({ url: args[0], controls: args.at(-1), pending });
    return pending;
  });
  return entered.promise;
}

function request(url) {
  return {
    name: "Cookie cancellation fixture",
    method: "GET",
    url,
    timeout: 10000,
    assertions: [{ target: "status", op: "eq", value: 200 }],
    extract: [
      { name: "runtimeExtract", path: "$.value", scope: "runtime" },
      { name: "environmentExtract", path: "$.value", scope: "environment" },
      { name: "globalExtract", path: "$.value", scope: "global" },
    ],
    after: [{ type: "set", name: "afterOperation", value: "must-not-run" }],
  };
}

function assertNoPostResponseWork(result, variables) {
  assert.deepEqual(result.extracted, {});
  assert.deepEqual(result.assertions, []);
  assert.deepEqual(result.logs, []);
  for (const key of [
    "runtimeExtract",
    "environmentExtract",
    "globalExtract",
    "afterOperation",
  ])
    assert.equal(Object.hasOwn(variables, key), false, key);
}

test("owner execute cancellation settles while the cookie header lock is held and never reaches the origin", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.jar.file, "utf8");
  const entered = observeJar(t, f.jar, "header", "/blocked-header");
  const release = await acquireFileLock(f.jar.file + ".lock");
  let result;
  try {
    const pending = f.api(f.route + "/execute", {
      request: request(f.url + "/blocked-header"),
      environmentId: "selected",
      runId: "header-cancel",
    });
    const observed = await bounded(entered, "owner header entry");
    assert.equal(observed.url, f.url + "/blocked-header");
    assert.equal(observed.controls.signal.aborted, false);
    assert(Number.isFinite(observed.controls.deadline));
    await f.api("/cancel", { id: "header-cancel" });
    result = await bounded(pending, "owner header cancellation before unlock");
    assert.equal(observed.controls.signal.aborted, true);
    assert.equal(result.outcome, "failed");
    assert.equal(result.error, cancelledMessage);
    assert.equal(result.status, undefined);
    assert.equal(result.failure, undefined);
    assert.equal(f.seen.length, 0);
    assert.equal(await readFile(f.jar.file, "utf8"), before);
  } finally {
    await release();
  }
  // A new lock acquisition is a barrier behind the abandoned queue slot.
  const reopened = new ProjectCookieJar(f.root, f.project.id, "selected");
  assert.equal(await reopened.header(f.url), "seed=selected");
  assert.equal(await readFile(f.jar.file, "utf8"), before);
  const stored = await f.assertIsolation();
  assert.equal(stored.history.length, 1);
  assert.equal(stored.history[0].status, "failed");
  assert.equal(stored.history[0].error, cancelledMessage);
  assertNoPostResponseWork(stored.history[0], result.extracted);
  const healthy = await f.api(f.route + "/execute", {
    request: { url: f.url + "/healthy", timeout: 5000 },
    environmentId: "selected",
    runId: "header-cancel",
  });
  assert.equal(healthy.outcome, "passed");
  assert.equal(healthy.status, 200);
  assert.deepEqual(f.seen, [{ url: "/healthy", cookie: "seed=selected" }]);
  await f.assertIsolation();
});

for (const mode of ["execute", "run"])
  test(`owner ${mode} cancellation preserves completed HTTP evidence without late cookie, extraction or after operations`, async (t) => {
    const f = await fixture(t);
    const before = await readFile(f.jar.file, "utf8");
    const entered = observeJar(t, f.jar, "capture", "/blocked-capture");
    let release;
    f.setBeforeReply(async (incoming) => {
      if (incoming.url === "/blocked-capture")
        release = await acquireFileLock(f.jar.file + ".lock");
    });
    const definition = request(f.url + "/blocked-capture");
    if (mode === "run") {
      const plan = snapshotPlan({
        id: "capture-plan",
        name: "Capture cancellation",
        environmentId: "selected",
        steps: [
          { request: definition },
          { request: { url: f.url + "/must-not-start" } },
        ],
      });
      const project = await f.app.store.get(f.project.id);
      project.plans = [plan];
      await f.app.store.save(project);
    }
    let output;
    try {
      const pending = f.api(f.route + "/" + mode, {
        ...(mode === "run"
          ? { planId: "capture-plan" }
          : { request: definition }),
        environmentId: "selected",
        runId: "capture-cancel",
      });
      const observed = await bounded(
        entered,
        "completed response cookie capture",
      );
      assert.equal(typeof release, "function");
      assert.equal(observed.url, f.url + "/blocked-capture");
      assert.equal(observed.controls.signal.aborted, false);
      assert(Number.isFinite(observed.controls.deadline));
      await f.api("/cancel", { id: "capture-cancel" });
      output = await bounded(
        pending,
        "owner capture cancellation before unlock",
      );
      assert.equal(observed.controls.signal.aborted, true);
      const response = mode === "run" ? output.results[0].response : output;
      assert.equal(response.status, 200);
      assert.deepEqual(response.headers["set-cookie"], [
        "received=origin; Path=/",
      ]);
      assert.equal(
        response.body,
        JSON.stringify({ value: "published-only-when-healthy" }),
      );
      assert.deepEqual(response.failure, completedCancellation);
      assert.equal(output.status, mode === "run" ? "cancelled" : 200);
      if (mode === "run") {
        assert.equal(output.recordSaved, true);
        assert.equal(output.results.length, 1);
        assert.equal(output.results[0].status, "failed");
        assert.equal(output.results[0].error, cancelledMessage);
        assert.deepEqual(output.results[0].failure, completedCancellation);
        assertNoPostResponseWork(output.results[0], output.variables);
      } else {
        assert.equal(output.outcome, "failed");
        assert.equal(output.error, cancelledMessage);
        assert.equal(output.variableWrites.commits, 0);
        assert.deepEqual(output.variableWrites.changes, []);
      }
      assert.deepEqual(f.seen, [
        { url: "/blocked-capture", cookie: "seed=selected" },
      ]);
      assert.equal(await readFile(f.jar.file, "utf8"), before);
    } finally {
      await release?.();
    }
    const reopened = new ProjectCookieJar(f.root, f.project.id, "selected");
    assert.equal(await reopened.header(f.url), "seed=selected");
    assert.equal(await readFile(f.jar.file, "utf8"), before);
    const stored = await f.assertIsolation();
    const record =
      mode === "run" ? stored.runs[0].results[0] : stored.history[0];
    assert.equal(record.status, "failed");
    assert.equal(record.source, mode === "run" ? undefined : "manual");
    assert.equal(record.response.status, 200);
    assert.deepEqual(record.failure, completedCancellation);
    assert.deepEqual(record.response.failure, completedCancellation);
    assertNoPostResponseWork(
      record,
      mode === "run" ? output.variables : output.extracted,
    );
    const healthy = await f.api(f.route + "/execute", {
      request: { url: f.url + "/healthy", timeout: 5000 },
      environmentId: "selected",
      runId: "capture-cancel",
    });
    assert.equal(healthy.outcome, "passed");
    assert.equal(healthy.status, 200);
    assert.equal(f.seen.length, 2);
    assert.deepEqual(f.seen[1], { url: "/healthy", cookie: "seed=selected" });
    assert.equal(
      await reopened.header(f.url),
      "seed=selected; received=origin",
    );
    await f.assertIsolation();

    // Cookie secrets and opt-in grants remain local, even when completed and
    // cancelled HTTP history is exported and restored through the owner API.
    await reopened.setCookie(f.url, "localOnly=never-exported; Path=/", {
      expectedRevision: (await reopened.inspect()).revision,
    });
    const backup = await f.api(f.route + "/export", undefined, "GET");
    assert.equal(JSON.stringify(backup).includes("never-exported"), false);
    const restored = await f.api("/restore", { document: backup });
    assert.notEqual(restored.id, f.project.id);
    const restoredJar = new ProjectCookieJar(f.root, restored.id, "selected");
    assert.deepEqual(await restoredJar.inspect(), {
      enabled: false,
      revision: 0,
      cookies: [],
    });
    assert.equal(await restoredJar.header(f.url), null);
    const restoredStored = await new Store(f.root).get(restored.id);
    const restoredRecord =
      mode === "run"
        ? restoredStored.runs[0].results[0]
        : restoredStored.history.find(
            (item) => item.error === cancelledMessage,
          );
    assert.equal(restoredRecord.response.status, 200);
    assert.deepEqual(restoredRecord.failure, completedCancellation);
    assert.equal(
      await new ProjectCookieJar(f.root, f.project.id, "selected").header(
        f.url,
      ),
      "seed=selected; received=origin; localOnly=never-exported",
    );
    await f.assertIsolation();
  });

function invokeCLI(t, root, projectId) {
  const child = spawn(
    process.execPath,
    [
      "scripts/run-plan.mjs",
      "--project",
      projectId,
      "--plan",
      "cli-cookie-plan",
      "--environment",
      "selected",
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, LOCAL_API_DATA: root },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  return once(child, "close").then(([code, signal]) => ({
    code,
    signal,
    stdout,
    stderr,
  }));
}

test("actual CLI request timeout interrupts a parent-held cross-process cookie lock and persists truthful failure before unlock", async (t) => {
  const f = await fixture(t);
  const project = await f.app.store.get(f.project.id);
  project.plans = [
    snapshotPlan({
      id: "cli-cookie-plan",
      name: "CLI cookie deadline",
      environmentId: "selected",
      steps: [{ request: { ...request(f.url + "/cli"), timeout: 1000 } }],
    }),
  ];
  await f.app.store.save(project);
  const before = await readFile(f.jar.file, "utf8");
  const release = await acquireFileLock(f.jar.file + ".lock");
  let failed;
  try {
    failed = await bounded(
      invokeCLI(t, f.root, f.project.id),
      "CLI failure while parent still holds lock",
    );
    assert.equal(failed.code, 1, failed.stderr + "\n" + failed.stdout);
    assert.equal(failed.signal, null);
    const evidence = JSON.parse(failed.stdout);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.recordSaved, true);
    assert.equal(evidence.results.length, 1);
    assert.equal(evidence.results[0].status, "failed");
    assert.equal(evidence.results[0].error, timeoutMessage);
    assert.equal(evidence.results[0].response, undefined);
    assert.equal(evidence.results[0].failure, undefined);
    assertNoPostResponseWork(evidence.results[0], evidence.variables);
    assert.equal(f.seen.length, 0);
    assert.equal(await readFile(f.jar.file, "utf8"), before);
    const stored = await f.assertIsolation();
    assert.equal(stored.runs.length, 1);
    assert.equal(stored.runs[0].source, "cli");
    assert.equal(stored.runs[0].status, "failed");
    assert.equal(stored.runs[0].results[0].error, timeoutMessage);
  } finally {
    await release();
  }
  const reopened = new ProjectCookieJar(f.root, f.project.id, "selected");
  assert.equal(await reopened.header(f.url), "seed=selected");
  assert.equal(await readFile(f.jar.file, "utf8"), before);
  const healthy = await bounded(
    invokeCLI(t, f.root, f.project.id),
    "healthy CLI after unlock",
  );
  assert.equal(healthy.code, 0, healthy.stderr + "\n" + healthy.stdout);
  const evidence = JSON.parse(healthy.stdout);
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.recordSaved, true);
  assert.equal(evidence.results[0].response.status, 200);
  assert.equal(
    evidence.results[0].extracted.runtimeExtract,
    "published-only-when-healthy",
  );
  assert.equal(evidence.variables.afterOperation, "must-not-run");
  assert.deepEqual(f.seen, [{ url: "/cli", cookie: "seed=selected" }]);
  assert.equal(await reopened.header(f.url), "seed=selected; received=origin");
  const stored = await new Store(f.root).get(f.project.id);
  assert.deepEqual(stored.runs.map((run) => [run.source, run.status]).sort(), [
    ["cli", "failed"],
    ["cli", "passed"],
  ]);
  assert.equal(
    stored.environments[0].variables.environmentExtract,
    "published-only-when-healthy",
  );
  assert.equal(
    stored.globalVariables.globalExtract,
    "published-only-when-healthy",
  );
  assert.equal(stored.environments[1].variables.environmentExtract, undefined);
  await f.assertOtherJarsUnchanged();
});
