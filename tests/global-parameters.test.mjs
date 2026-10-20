import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGlobalParameters,
  validateGlobalParameters,
} from "../src/global-parameters.mjs";
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
import { versionPlan } from "../src/plan-version.mjs";
const pair = (key, value, enabled = true) => ({ key, value, enabled });
const project = () => ({
  settings: {
    globalParameters: {
      headers: [pair("X-Token", "{{token}}"), pair("X-Disabled", "global")],
      query: [pair("tag", "global"), pair("other", "yes")],
      cookies: [pair("sid", "global")],
      form: [pair("shared", "global")],
    },
  },
});
test("project parameters merge without mutating sources, request overrides include disabled rows", () => {
  const p = project();
  const r = normalizeRequest({
    url: "https://example.test",
    headers: [pair("x-token", "local"), pair("x-disabled", "", false)],
    query: [pair("tag", "a"), pair("tag", "b")],
    bodyType: "urlencoded",
  });
  const before = structuredClone([p, r]);
  const result = applyGlobalParameters(p, r);
  assert.deepEqual(result.headers, r.headers);
  assert.deepEqual(result.query, [pair("other", "yes"), ...r.query]);
  assert.deepEqual(result.form, p.settings.globalParameters.form);
  assert.deepEqual(result.cookies, p.settings.globalParameters.cookies);
  assert.deepEqual([p, r], before);
  assert.deepEqual(
    applyGlobalParameters(p, { ...r, inheritGlobalParameters: false }).cookies,
    [],
  );
  assert.deepEqual(
    applyGlobalParameters(p, { ...r, bodyType: "json" }).form,
    [],
  );
});
test("global parameters snapshot once; old plans never acquire new defaults", () => {
  const p = project(),
    r = normalizeRequest({ url: "https://example.test" });
  const plan = versionPlan(null, { steps: [{ request: r }] }, "manual", p);
  assert.equal(plan.steps[0].request.parametersSnapshot, true);
  p.settings.globalParameters.headers[0].value = "changed";
  assert.equal(
    freezeServiceBinding(p, plan.steps[0].request).headers[0].value,
    "{{token}}",
  );
  const legacy = snapshotPlan({ steps: [{ request: r }] });
  assert.deepEqual(
    freezeServiceBinding(p, legacy.steps[0].request).headers,
    [],
  );
  const edited = versionPlan(
    plan,
    {
      ...plan,
      steps: plan.steps.map((s) => ({
        ...s,
        request: { ...s.request, name: "renamed" },
      })),
    },
    "manual",
    p,
  );
  assert.equal(edited.steps[0].request.headers[0].value, "{{token}}");
});
test("global parameter schema rejects unknown settings, files, duplicates, nonstrings and unbounded data", () => {
  for (const value of [
    null,
    [],
    { auth: {} },
    { headers: [pair("X", "1"), pair("x", "2")] },
    { form: [{ ...pair("file", "x"), type: "file" }] },
    { query: [pair("q", {})] },
    { cookies: [pair("sid", "x\ny")] },
    { headers: [pair("Bad Name", "x")] },
    { query: [pair("q", "中".repeat(30000))] },
  ])
    assert.throws(() => validateGlobalParameters(value));
  assert.deepEqual(validateGlobalParameters(undefined), {
    headers: [],
    query: [],
    cookies: [],
    form: [],
  });
  assert.deepEqual(
    validateGlobalParameters({ query: [pair("A", "1"), pair("a", "2")] }).query,
    [pair("A", "1"), pair("a", "2")],
  );
});

test("real HTTP debug, cURL, load, plan and case consume defaults at creation only", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const http = await import("node:http");
  const { createApp } = await import("../src/server.mjs");
  const { runLoad } = await import("../src/load-runner.mjs");
  const received = [];
  const fixture = http.createServer(async (req, res) => {
    received.push(req.headers);
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ headers: req.headers, url: req.url, body }));
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "api-global-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((r) => fixture.close(r));
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("global fixture");
  p.settings = project().settings;
  p.globalVariables = { token: "initial" };
  const request = normalizeRequest({
    id: "fixture",
    url: `http://127.0.0.1:${fixture.address().port}/echo`,
    method: "POST",
    bodyType: "urlencoded",
  });
  p.requests = [request];
  await app.store.save(p);
  const call = async (action, data) => {
    const response = await fetch(`${app.url}/api/projects/${p.id}/${action}`, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const debug = await call("execute", { request });
  const echo = JSON.parse(debug.body);
  assert.equal(echo.headers["x-token"], "initial");
  assert.equal(echo.headers.cookie, "sid=global");
  assert.equal(echo.url, "/echo?tag=global&other=yes");
  assert.equal(echo.body, "shared=global");
  assert.match((await call("curl", { request })).curl, /x-token: initial/);
  const plan = await call("plans", { name: "frozen", steps: [{ request }] });
  const savedCase = await call("cases", {
    name: "frozen",
    sourceRequestId: "fixture",
    request,
  });
  const changed = await app.store.get(p.id);
  changed.settings.globalParameters.headers[0].value = "new";
  await app.store.save(changed);
  assert.equal(
    JSON.parse((await call("execute", { request })).body).headers["x-token"],
    "new",
  );
  assert.equal(
    JSON.parse(
      (await call("execute", { request: savedCase.item.request })).body,
    ).headers["x-token"],
    "initial",
  );
  const run = await call("run", { planId: plan.id, runId: "globals" });
  assert.equal(run.status, "passed");
  assert.equal(
    JSON.parse(run.results[0].response.body).headers["x-token"],
    "initial",
  );
  const loaded = await runLoad(changed, request, { count: 2, concurrency: 1 });
  assert.equal(loaded.count, 2);
  assert.equal(loaded.passed, 2);
  assert.deepEqual(
    received.slice(-2).map((h) => h["x-token"]),
    ["new", "new"],
  );
  const { createMCP } = await import("../src/mcp.mjs");
  const mcp = createMCP({
    store: app.store,
    projects: [p.id],
    execute: true,
    write: true,
  });
  const output = await mcp({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_execute_api",
      arguments: { projectId: p.id, apiId: "fixture" },
    },
  });
  assert.equal(output.result.isError, undefined, JSON.stringify(output));
  assert.equal(received.at(-1)["x-token"], "new");
  const invalid = await app.store.get(p.id);
  invalid.settings.globalParameters = { headers: [pair("Bad Name", "x")] };
  await assert.rejects(app.store.save(invalid), /Header/);
  assert.equal(
    (await app.store.get(p.id)).settings.globalParameters.headers[0].value,
    "new",
  );
  const optedOut = JSON.parse(
    (
      await call("execute", {
        request: { ...request, inheritGlobalParameters: false },
      })
    ).body,
  );
  assert.equal(optedOut.headers["x-token"], undefined);
  assert.equal(optedOut.url, "/echo");
});
