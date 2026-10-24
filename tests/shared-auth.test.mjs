import { renameSharedAuthScopes } from "../public/shared-auth.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  applySharedAuth,
  validateSharedAuthSettings,
} from "../src/shared-auth.mjs";
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
import { versionPlan } from "../src/plan-version.mjs";
const project = () => ({
  settings: {
    globalAuth: { type: "bearer", token: "{{token}}" },
    folderAuth: {
      Orders: { type: "basic", username: "user", password: "{{password}}" },
      Public: { type: "none" },
    },
  },
});
test("shared authentication obeys request, exact folder and project precedence with explicit no-auth", () => {
  const p = project(),
    r = normalizeRequest({ url: "https://example.test", folder: "Orders" });
  const before = structuredClone([p, r]);
  assert.deepEqual(applySharedAuth(p, r).auth, p.settings.folderAuth.Orders);
  assert.deepEqual(
    applySharedAuth(p, { ...r, folder: "Orders/Child" }).auth,
    p.settings.globalAuth,
  );
  assert.deepEqual(applySharedAuth(p, { ...r, folder: "Public" }).auth, {
    type: "none",
  });
  assert.deepEqual(applySharedAuth(p, { ...r, inheritAuth: false }).auth, {
    type: "none",
  });
  const own = { type: "bearer", token: "own" };
  assert.deepEqual(applySharedAuth(p, { ...r, auth: own }).auth, own);
  assert.deepEqual([p, r], before);
});
test("new auth snapshots freeze credentials templates; legacy plans never acquire defaults", () => {
  const p = project(),
    request = normalizeRequest({ url: "https://example.test" });
  const plan = versionPlan(null, { steps: [{ request }] }, "manual", p);
  assert.equal(plan.steps[0].request.authSnapshot, true);
  p.settings.globalAuth.token = "changed";
  assert.equal(
    freezeServiceBinding(p, plan.steps[0].request).auth.token,
    "{{token}}",
  );
  const legacy = snapshotPlan({ steps: [{ request }] });
  assert.deepEqual(freezeServiceBinding(p, legacy.steps[0].request).auth, {
    type: "none",
  });
});
test("shared authentication validation rejects malformed or oversized scope definitions", () => {
  for (const settings of [
    { globalAuth: null },
    { globalAuth: { type: "system" } },
    { globalAuth: { type: "bearer", token: { nested: "x" } } },
    { globalAuth: { type: "bearer", token: "x".repeat(70000) } },
    { folderAuth: [] },
    { folderAuth: JSON.parse('{"__proto__":{"type":"none"}}') },
  ])
    assert.throws(() => validateSharedAuthSettings(settings));
  assert.doesNotThrow(() => validateSharedAuthSettings(project().settings));
  const original = project().settings;
  assert.deepEqual(
    renameSharedAuthScopes(original, "Orders", "Renamed").Renamed,
    original.folderAuth.Orders,
  );
  assert.equal(
    renameSharedAuthScopes(original, "Orders", null).Orders,
    undefined,
  );
  assert.throws(
    () => renameSharedAuthScopes(original, "Orders", "Public"),
    /已存在/,
  );
  assert(original.folderAuth.Orders);
});

test("shared credentials reach real HTTP and cURL while old plan templates stay frozen", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const http = await import("node:http");
  const fixture = http.createServer((req, res) => {
    res.end(JSON.stringify({ authorization: req.headers.authorization || "" }));
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-auth-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((r) => fixture.close(r));
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("shared auth fixture");
  p.settings = {
    globalAuth: { type: "bearer", token: "{{token}}" },
    folderAuth: { Public: { type: "none" } },
  };
  p.globalVariables = { token: "fixture-global" };
  await app.store.save(p);
  const request = normalizeRequest({
    url: `http://127.0.0.1:${fixture.address().port}/`,
  });
  const call = async (action, data) => {
    const r = await fetch(`${app.url}/api/projects/${p.id}/${action}`, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    });
    const value = await r.json();
    assert.equal(r.status, 200, JSON.stringify(value));
    return value;
  };
  assert.equal(
    JSON.parse((await call("execute", { request })).body).authorization,
    "Bearer fixture-global",
  );
  assert.match(
    (await call("curl", { request })).curl,
    /authorization: Bearer fixture-global/,
  );
  const plan = await call("plans", {
    name: "frozen shared auth",
    steps: [{ request }],
  });
  const changed = await app.store.get(p.id);
  changed.settings.globalAuth = { type: "bearer", token: "replacement" };
  await app.store.save(changed);
  assert.equal(
    JSON.parse((await call("execute", { request })).body).authorization,
    "Bearer replacement",
  );
  assert.equal(
    JSON.parse(
      (await call("run", { planId: plan.id, runId: "shared-auth" })).results[0]
        .response.body,
    ).authorization,
    "Bearer fixture-global",
  );
  for (const override of [{ inheritAuth: false }, { folder: "Public" }])
    assert.equal(
      JSON.parse(
        (await call("execute", { request: { ...request, ...override } })).body,
      ).authorization,
      "",
    );
});
