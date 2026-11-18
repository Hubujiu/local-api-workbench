import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import {
  normalizeRequest,
  snapshotPlan,
  importIntoProject,
} from "../src/core.mjs";
import {
  exportFrozenTaskSource,
  verifyFrozenTaskSource,
} from "../src/apipost-flow-task-source-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";

const task = (id, type, data, enabled = 1) => ({
  id,
  name: id,
  type,
  data,
  enabled,
});
const source = () => ({
  version: 1,
  before: [
    task(
      "source-script",
      "customScript",
      'throw Error("INERT BEFORE MUST NOT EXECUTE")',
    ),
    task("source-wait", "wait", 1000),
    task("source-disabled-wait", "wait", "{{unresolved}}", -1),
  ],
  after: [
    task(
      "source-script",
      "customScript",
      'throw Error("INERT AFTER MUST NOT EXECUTE")',
    ),
    task("source-pick", "pickVars", {
      source: "responseJson",
      variables: [
        { name: "forbidden", expression: "$.value", type: "envVars" },
      ],
    }),
    task("source-assert", "assert", {
      type: "responseCode",
      expression: { path: "", compareType: "eq", compareValue: "599" },
    }),
  ],
});
function fixture(url) {
  const request = normalizeRequest({
    id: "api",
    name: "Frozen",
    url,
    method: "GET",
    inheritSharedScripts: false,
    scriptDialect: "apipost8",
    beforeScript: 'apt.setRequestHeader("x-step","explicit");',
    afterScript: 'apt.environment.set("stepResult",apt.response.json().value);',
    importedNativeTaskSource: source(),
  });
  return {
    id: "project",
    name: "Source round trip",
    settings: {},
    environments: [{ id: "env", name: "E", variables: {} }],
    requests: [],
    plans: [
      snapshotPlan({
        id: "plan",
        name: "Frozen plan",
        environmentId: "env",
        statusPolicy: "strict200",
        steps: [{ id: "step", request }],
      }),
    ],
  };
}

test("frozen mixed API task provenance stays inert across directory generations, owner export, restore and restart", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, step: req.headers["x-step"] });
    res.setHeader("content-type", "application/json");
    res.end('{"value":"step-only"}');
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-flow-source-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const input = fixture(
    "http://127.0.0.1:" + upstream.address().port + "/step",
  );
  const before = structuredClone(input);
  const document = exportApipostDirectory(input);
  assert.deepEqual(input, before);
  assert.equal(seen.length, 0);
  const flow = JSON.parse(
    document.files.find((f) => /executions\/flows\/flow/.test(f.path)).text,
  );
  assert.deepEqual(
    flow.steps[0].api_snapshot.request.pre_tasks,
    source().before,
  );
  assert.deepEqual(
    flow.steps[0].api_snapshot.request.post_tasks,
    source().after,
  );
  const p = await app.store.create("Imported");
  importIntoProject(p, document);
  assert.deepEqual(p.requests, []);
  await app.store.save(p);
  const url =
    app.url + "/api/projects/" + p.id + "/export?format=apipost-directory";
  assert.equal((await fetch(url)).status, 403);
  const response = await fetch(url, {
    headers: { "x-local-token": app.token },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const q = await app.store.create("Again");
  importIntoProject(q, await response.json());
  assert.deepEqual(q.requests, []);
  await app.store.save(q);
  const restored = await app.store.restore(q);
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
  app = await createApp({ root, port: 0 });
  assert.equal(seen.length, 0);
  for (const current of [p, q, restored]) {
    const loaded = await app.store.get(current.id);
    const request = loaded.plans[0].steps[0].request;
    assert.deepEqual(request.importedNativeTaskSource, source());
    assert.equal(request.nativeTasks, undefined);
    assert.equal(request.importedScriptTasks, undefined);
    const result = await fetch(
      app.url + "/api/projects/" + current.id + "/run",
      {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ planId: loaded.plans[0].id }),
      },
    );
    const run = await result.json();
    assert.equal(result.status, 200, JSON.stringify(run));
    assert.equal(run.status, "passed", JSON.stringify(run));
    const saved = await app.store.get(current.id);
    const env = saved.environments.find(
      (e) => e.id === loaded.plans[0].environmentId,
    );
    assert.equal(env.variables.stepResult, "step-only");
    assert.equal(env.variables.forbidden, undefined);
    assert.deepEqual(
      saved.plans[0].steps[0].request.importedNativeTaskSource,
      source(),
    );
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 3 }, () => ({ url: "/step", step: "explicit" })),
  );
});

test("unrepresentable provenance still rejects atomically and never becomes an executable task pipeline", () => {
  for (const mutate of [
    (r) => {
      r.importedNativeTaskSource.before[0].origin = {
        scope: "project",
        id: "source",
      };
    },
    (r) => {
      r.importedNativeTaskSource.before.push(
        task("database", "database", {
          connectionId: "connection",
          query: "SELECT 1",
          variables: [],
          isConsoleOutput: -1,
        }),
      );
    },
    (r) => {
      r.importedNativeTaskSource.before = [task("script", "customScript", "0")];
      r.importedNativeTaskSource.after = [];
    },
    (r) => {
      r.importedNativeTaskSource.before[1].data = 2000;
    },
    (r) => {
      r.importedScriptTasks = { version: 1, before: [], after: [] };
    },
    (r) => {
      delete r.importedNativeTaskSource.before[0].id;
    },
  ]) {
    const project = fixture("http://127.0.0.1:1/never");
    mutate(project.plans[0].steps[0].request);
    const before = structuredClone(project);
    assert.throws(() => exportApipostDirectory(project));
    assert.deepEqual(project, before);
  }
});

test("source exporter never invokes getters and readback detects dropped, reordered or activated provenance", () => {
  let called = 0;
  for (const key of ["importedNativeTaskSource", "importedScriptTasks", "id"]) {
    const request = { id: "request", importedNativeTaskSource: source() };
    Object.defineProperty(request, key, {
      enumerable: true,
      get() {
        called++;
        return source();
      },
    });
    assert.throws(() => exportFrozenTaskSource(request), /访问器/);
    assert.equal(called, 0);
  }
  const expected = source();
  const altered = structuredClone(expected);
  altered.before.reverse();
  assert.throws(() => verifyFrozenTaskSource(expected, altered));
  assert.throws(() => verifyFrozenTaskSource(expected, undefined));
  const activated = structuredClone(expected);
  activated.before[2].enabled = 1;
  assert.throws(() => verifyFrozenTaskSource(expected, activated));
  verifyFrozenTaskSource(expected, structuredClone(expected));
});
