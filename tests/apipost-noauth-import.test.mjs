import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importDocument, normalizeRequest } from "../src/core.mjs";
import { applySharedAuth } from "../src/shared-auth.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";
const legacy = (url, auth) => ({
  apis: [
    {
      target_id: "api",
      target_type: "api",
      name: "public",
      method: "GET",
      url,
      request: auth === undefined ? {} : { auth },
    },
  ],
});
const bearer = { type: "bearer", bearer: { key: "fictional-source-bearer" } };
function modern(url, scenario) {
  const d = modernApipostFixture();
  d.global.envs = [];
  d.global.servers = [];
  d.global.global_vars = {};
  d.global.global_param.pre_tasks = [];
  d.global.global_param.post_tasks = [];
  const api = d.apis[1];
  api.url = url;
  api.request.query.parameter = [];
  api.request.header.parameter = [];
  api.request.pre_tasks = [];
  api.request.post_tasks = [];
  if (scenario === "noauth" || scenario === "none") {
    d.global.global_param.auth = bearer;
    api.request.auth = { type: scenario };
  }
  if (scenario === "folder-none") {
    d.global.global_param.auth = bearer;
    d.apis[0].request.auth = { type: "none" };
  }
  if (scenario === "source-bearer") d.global.global_param.auth = bearer;
  if (scenario === "source-basic")
    d.apis[0].request.auth = {
      type: "basic",
      basic: { username: "fictional-user", password: "fictional-pass" },
    };
  if (scenario === "missing") {
    delete d.global.global_param.auth;
    delete d.apis[0].request.auth;
    delete api.request.auth;
  }
  return d;
}

test("native explicit noauth and none opt out without changing generic or absent legacy inheritance", () => {
  const project = {
    settings: { globalAuth: { type: "bearer", token: "fictional-target" } },
  };
  for (const type of ["noauth", "none"]) {
    const r = importDocument(legacy("http://127.0.0.1:1", { type }))[0];
    assert.equal(r.inheritAuth, false);
    assert.deepEqual(applySharedAuth(project, r).auth, { type: "none" });
  }
  const missing = importDocument(legacy("http://127.0.0.1:1"))[0];
  assert.equal(missing.inheritAuth, true);
  for (const r of [
    missing,
    normalizeRequest({
      url: "http://127.0.0.1:1",
      auth: { type: "none" },
      inheritAuth: true,
    }),
  ])
    assert.equal(applySharedAuth(project, r).auth.token, "fictional-target");
});

for (const format of ["json", "directory"])
  test(`native ${format} source auth isolation on actual owner HTTP, frozen plans, restore and restart`, async (t) => {
    const seen = [];
    const upstream = http.createServer((q, r) => {
      seen.push({ url: q.url, authorization: q.headers.authorization });
      r.end("{}");
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${upstream.address().port}`;
    const root = await mkdtemp(path.join(tmpdir(), "native-noauth-"));
    let app = await createApp({ root, port: 0 });
    const stop = async () => {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
    };
    t.after(async () => {
      await stop();
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const post = async (route, body, status = 200) => {
      const r = await fetch(app.url + route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify(body),
      });
      const v = await r.json();
      assert.equal(r.status, status, JSON.stringify(v));
      return v;
    };
    const other = await app.store.create("other"),
      untouched = await app.store.get(other.id);
    for (const scenario of [
      "noauth",
      "none",
      "source-inherit-noauth",
      "folder-none",
      "missing",
      "source-bearer",
      "source-basic",
    ]) {
      const p = await app.store.create(scenario);
      p.settings.globalAuth = {
        type: "bearer",
        token: "fictional-target-secret",
      };
      await app.store.save(p);
      const d = modern(url + "/" + scenario, scenario),
        document = format === "json" ? d : nativeDirectoryFixture(d),
        original = structuredClone(document);
      const imported = await post(`/api/projects/${p.id}/import`, { document });
      assert.deepEqual(document, original);
      assert.equal(imported.requests[0].inheritAuth, false);
      assert.equal(
        imported.settings.globalAuth.token,
        "fictional-target-secret",
      );
      const expected =
        scenario === "source-bearer"
          ? "Bearer fictional-source-bearer"
          : scenario === "source-basic"
            ? "Basic " +
              Buffer.from("fictional-user:fictional-pass").toString("base64")
            : undefined;
      const control = {
        url: url + "/control",
        auth: { type: "none" },
        inheritAuth: true,
      };
      const plan = await post(`/api/projects/${p.id}/plans`, {
        steps: [{ request: imported.requests[0] }, { request: control }],
      });
      const live = await app.store.get(p.id);
      live.settings.globalAuth.token = "fictional-changed-target";
      live.requests[0].auth = { type: "bearer", token: "fictional-live-edit" };
      live.requests[0].inheritAuth = true;
      await app.store.save(live);
      let count = seen.length;
      const run = await post(`/api/projects/${p.id}/run`, { planId: plan.id });
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.equal(seen.length, count + 2);
      assert.equal(seen[count].authorization, expected);
      assert.equal(
        seen[count + 1].authorization,
        "Bearer fictional-target-secret",
      );
      const disk = await new Store(root).get(p.id);
      assert.equal(
        disk.plans.find((x) => x.id === plan.id).steps[0].request.inheritAuth,
        false,
      );
      const restored = await post("/api/restore", { document: disk }, 201);
      assert.deepEqual(
        restored.plans.find((x) => x.id === plan.id).steps,
        plan.steps,
      );
      await stop();
      app = await createApp({ root, port: 0 });
      count = seen.length;
      const rerun = await post(`/api/projects/${restored.id}/run`, {
        planId: plan.id,
      });
      assert.equal(rerun.status, "passed", JSON.stringify(rerun));
      assert.equal(seen[count].authorization, expected);
      assert.equal(
        seen[count + 1].authorization,
        "Bearer fictional-target-secret",
      );
    }
    // Legacy explicit spelling must also survive the owner entrypoint, not only model checks.
    if (format === "json")
      for (const type of ["noauth", "none", undefined]) {
        const p = await app.store.create("legacy-" + type);
        p.settings.globalAuth = {
          type: "bearer",
          token: "fictional-target-secret",
        };
        await app.store.save(p);
        const imported = await post(`/api/projects/${p.id}/import`, {
          document: legacy(
            url + "/legacy-" + type,
            type === undefined ? undefined : { type },
          ),
        });
        const plan = await post(`/api/projects/${p.id}/plans`, {
          steps: [{ request: imported.requests[0] }],
        });
        const run = await post(`/api/projects/${p.id}/run`, {
          planId: plan.id,
        });
        assert.equal(run.status, "passed", JSON.stringify(run));
        assert.equal(
          seen.at(-1).authorization,
          type === undefined ? "Bearer fictional-target-secret" : undefined,
        );
      }
    assert.deepEqual(await app.store.get(other.id), untouched);
  });
