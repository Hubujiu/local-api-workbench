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
  restoreProject,
} from "../src/core.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
function example() {
  return {
    name: "OK",
    status: 200,
    headers: { "content-type": "application/json", "x-example": "fixture" },
    body: "",
    delayMs: 0,
  };
}
function fixture(url) {
  const schema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };
  const request = normalizeRequest({
    id: "api",
    name: "HTTP",
    url,
    method: "POST",
    bodyType: "json",
    body: '{"value":"{{stepValue}}"}',
    inheritSharedScripts: false,
    scriptDialect: "apipost8",
    examples: [example()],
    responses: [
      {
        status: "200",
        description: "OK",
        schema,
        content: { "application/json": { schema } },
      },
    ],
  });
  const source = {
    version: 1,
    before: [
      {
        id: "inert",
        name: "API source",
        type: "customScript",
        enabled: 1,
        data: 'throw Error("API sentinel must not run")',
      },
    ],
    after: [
      {
        id: "disabled",
        name: "Disabled",
        type: "customScript",
        enabled: -1,
        data: 'throw Error("disabled source")',
      },
    ],
  };
  const steps = ["one", "two"].map((value, i) => ({
    id: "step" + i,
    request: {
      ...request,
      importedScriptTasks: structuredClone(source),
      beforeScript: `apt.environment.set("stepValue","${value}");apt.setRequestHeader("x-step","${value}");`,
      afterScript: 'apt.environment.set("last",apt.response.json().value);',
    },
  }));
  return {
    id: "project",
    name: "Directory",
    settings: {},
    environments: [
      { id: "env", name: "E", variables: { stepValue: "initial" } },
    ],
    requests: [
      { ...request, url: url + "/edited-live", body: '{"live":true}' },
    ],
    plans: [
      snapshotPlan({
        id: "plan",
        name: "Frozen",
        statusPolicy: "strict200",
        environmentId: "env",
        steps,
      }),
    ],
  };
}
test("directory export preserves independent frozen HTTP steps, inert sources and responses through real execution, restore and restart", async (t) => {
  const seen = [],
    upstream = http.createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      seen.push({
        url: req.url,
        step: req.headers["x-step"],
        body: JSON.parse(body),
      });
      res.setHeader("content-type", "application/json");
      res.end(body);
    });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-export-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const original = fixture(
      `http://127.0.0.1:${upstream.address().port}/frozen`,
    ),
    before = structuredClone(original),
    document = exportApipostDirectory(original);
  assert.deepEqual(original, before);
  assert.equal(seen.length, 0);
  const flow = JSON.parse(
    document.files.find((f) => /flows\/flow/.test(f.path)).text,
  );
  assert.notEqual(flow.steps[0].target_id, flow.steps[1].target_id);
  assert.equal(
    flow.steps[0].api_snapshot.request.pre_tasks[0].data,
    original.plans[0].steps[0].request.importedScriptTasks.before[0].data,
  );
  assert.match(flow.steps[0].pre_script, /"one"/);
  assert.equal(flow.steps[0].api_snapshot.response.is_check_result, -1);
  const p = await app.store.create("Imported");
  importIntoProject(p, document);
  await app.store.save(p);
  assert.equal(p.requests[0].url, original.requests[0].url);
  assert.deepEqual(p.requests[0].examples, original.requests[0].examples);
  assert.deepEqual(p.requests[0].responses, original.requests[0].responses);
  const storedBeforeExport = await app.store.get(p.id);
  const endpoint =
    app.url + "/api/projects/" + p.id + "/export?format=apipost-directory";
  assert.equal((await fetch(endpoint)).status, 403);
  const exported = await fetch(endpoint, {
    headers: { "x-local-token": app.token },
  });
  assert.equal(exported.status, 200);
  const exportedDocument = await exported.json();
  assert.equal(exportedDocument.format, "apipost-offline-directory-v1");
  assert.deepEqual(await app.store.get(p.id), storedBeforeExport);
  const again = exportedDocument;
  const second = await app.store.create("Again");
  importIntoProject(second, again);
  await app.store.save(second);
  const restored = restoreProject(p);
  await app.store.save(restored);
  for (const current of [p, second, restored]) {
    const response = await fetch(
      app.url + "/api/projects/" + current.id + "/run",
      {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ planId: current.plans[0].id }),
      },
    );
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.status, "passed", JSON.stringify(result));
  }
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
  app = await createApp({ root, port: 0 });
  const reopened = await app.store.get(p.id),
    response = await fetch(app.url + "/api/projects/" + p.id + "/run", {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ planId: reopened.plans[0].id }),
    });
  assert.equal((await response.json()).status, "passed");
  assert.equal(seen.length, 8);
  assert(
    seen.every(
      (x, i) =>
        x.url === "/frozen" &&
        x.step === (i % 2 ? "two" : "one") &&
        x.body.value === x.step,
    ),
  );
  assert.equal(
    (await app.store.get(p.id)).environments.find(
      (e) => e.id === p.plans[0].environmentId,
    ).variables.last,
    "two",
  );
  assert.deepEqual(original, before);
  const other = exportApipostDirectory({ ...original, id: "other-project" });
  const ids = (d) =>
    d.files
      .filter(
        (f) =>
          /^apis\/[^/]+\.json$/.test(f.path) && !f.path.endsWith("index.json"),
      )
      .map((f) => JSON.parse(f.text).target_id);
  assert(ids(document).every((id) => !ids(other).includes(id)));
});
test("native directory export rejects unrepresentable execution semantics and response ambiguity without changing input", () => {
  for (const change of [
    (p) => (p.plans[0].statusPolicy = "assertions"),
    (p) => (p.plans[0].steps[0].type = "unknown"),
    (p) => (p.plans[0].steps[0].enabled = false),
    (p) =>
      (p.plans[0].steps[0].request.assertions = [
        { target: "status", op: "eq", value: 200 },
      ]),
    (p) =>
      (p.plans[0].steps[0].request.importedScriptTasks.before[0].origin = {
        scope: "project",
        id: "original",
      }),
    (p) => (p.requests[0].responses[0].description = "different"),
    (p) =>
      (p.requests[0].responses[0].content["application/json"].schema = false),
    (p) =>
      (p.requests[0].responses[0].content["application/json"].schema = {
        $ref: "#/components/schemas/X",
      }),
    (p) =>
      p.requests[0].examples.push(structuredClone(p.requests[0].examples[0])),
    (p) => (p.plans[0].environmentId = "missing"),
  ]) {
    const p = fixture("http://127.0.0.1:1/");
    change(p);
    const before = structuredClone(p);
    assert.throws(() => exportApipostDirectory(p));
    assert.deepEqual(p, before);
  }
});
test("native JSON response interchange retains empty bodies, delay, headers and inline schema without enabling assertions", () => {
  const p = fixture("http://127.0.0.1:1/");
  p.plans = [];
  const output = exportApipost(p),
    target = { requests: [], environments: [], settings: {} };
  assert.equal(output.apis[0].response.is_check_result, -1);
  importIntoProject(target, output);
  assert.deepEqual(target.requests[0].examples, p.requests[0].examples);
  assert.deepEqual(target.requests[0].responses, p.requests[0].responses);
  assert.deepEqual(target.requests[0].assertions, []);
});

test("response-only examples with duplicate status/media or reference aliases reject before emitting a partial document", () => {
  const p = fixture("http://127.0.0.1:1/");
  p.plans = [];
  p.requests[0].responses = [];
  p.requests[0].examples.push(structuredClone(p.requests[0].examples[0]));
  assert.throws(() => exportApipost(p), /重复/);
  const q = fixture("http://127.0.0.1:1/");
  q.plans = [];
  q.requests[0].responses[0].schema = { ref: "#/models/X" };
  q.requests[0].responses[0].content["application/json"].schema = {
    ref: "#/models/X",
  };
  assert.throws(() => exportApipost(q), /模型引用/);
});

test("response media whitelist cannot be satisfied by inherited object properties", () => {
  for (const media of ["constructor", "toString", "__proto__"]) {
    const p = fixture("http://127.0.0.1:1/");
    p.plans = [];
    p.requests[0].responses = [];
    p.requests[0].examples[0].headers["content-type"] = media;
    assert.throws(() => exportApipost(p), /Content-Type/);
  }
});
