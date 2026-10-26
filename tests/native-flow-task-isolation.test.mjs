import { nativeMongoFixture } from "./fixtures/apipost-mongodb.mjs";
import { nativeRedisFixture } from "./fixtures/apipost-redis.mjs";
// Cross-feature acceptance for native directory plans and native API task pipelines.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { prepareDirectoryPlans } from "../src/apipost-execution-plans.mjs";
import {
  normalizeRequest,
  snapshotPlan,
  runPlan,
  importIntoProject,
  restoreProject,
} from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";
function flow(source, api, name, scripts) {
  return {
    flow_id: name,
    project_id: source.project_id,
    name,
    description: "",
    environment_id: "1",
    source: "manual",
    created_at: "2026-10-26T00:00:00Z",
    updated_at: "2026-10-26T00:00:00Z",
    steps: [
      {
        step_id: "step",
        target_id: api.target_id,
        api_snapshot: structuredClone(api),
        input: { body: { kind: "step-only" } },
        ...(scripts
          ? {
              pre_script:
                'apt.environment.set("stepBefore","owned");apt.setRequestHeader("x-step","owned");',
              post_script:
                'apt.environment.set("stepAfter",apt.response.json().value);',
            }
          : {}),
      },
    ],
  };
}
for (const engine of ["pg", "redis", "mongodb"])
  test(
    `native frozen ${engine} flows isolate API tasks across real HTTP and restore`,
    { timeout: 20000 },
    async (t) => {
      const seen = [],
        upstream = http.createServer((req, res) => {
          seen.push({
            db: req.headers["x-db-value"],
            step: req.headers["x-step"],
          });
          res.setHeader("content-type", "application/json");
          res.end('{"value":"step-response"}');
        });
      await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
      const root = await mkdtemp(
        path.join(os.tmpdir(), "native-flow-isolation-"),
      );
      let app = await createApp({ root, port: 0 });
      t.after(async () => {
        upstream.closeAllConnections();
        await new Promise((r) => upstream.close(r));
        app.server.closeAllConnections();
        await new Promise((r) => app.server.close(r));
        await rm(root, { recursive: true, force: true });
      });
      const source = (
        engine === "mongodb"
          ? nativeMongoFixture
          : engine === "redis"
            ? nativeRedisFixture
            : nativeDatabaseFixture
      )(`http://127.0.0.1:${upstream.address().port}/echo`);
      source.global.envs = [
        { env_id: "1", name: "Flow Env", server_list: [], env_var_list: {} },
      ];
      for (const node of source.apis) node.project_id = source.project_id;
      const sourceAPI = source.apis.find((a) => a.target_type === "api");
      sourceAPI.method = "POST";
      sourceAPI.request.body = { mode: "json", raw: "{}" };
      sourceAPI.db_link = { config: { password: "discarded-snapshot-secret" } };
      const api = source.apis.find((a) => a.target_type === "api"),
        flows = [
          flow(source, api, "without-step-code", false),
          flow(source, api, "with-step-code", true),
        ],
        before = JSON.stringify({ source, flows });
      const p = await app.store.create("Isolation");
      importIntoProject(p, source);
      const active = p.requests.find((r) => r.nativeTasks);
      assert(active);
      assert.equal(
        active.nativeTasks.before.filter((x) => x.type === "database").length,
        1,
      );
      const blocked = await runPlan(
        snapshotPlan({ steps: [{ request: active }] }),
        {},
        executeRequest,
      );
      assert.equal(blocked.status, "failed");
      assert.match(blocked.results[0].error, /数据库|授权/);
      assert.equal(seen.length, 0);
      p.plans = prepareDirectoryPlans(source, flows, p, {
        normalizeRequest,
        snapshotPlan,
      });
      for (const plan of p.plans) {
        assert.equal(plan.steps[0].request.nativeTasks, undefined);
        assert.deepEqual(
          plan.steps[0].request.importedNativeTaskSource,
          active.nativeTasks,
        );
        assert(!JSON.stringify(plan).includes("discarded-snapshot-secret"));
        assert.equal(plan.steps[0].request.inheritSharedScripts, false);
      }
      const frozenSource = structuredClone(
        p.plans[0].steps[0].request.importedNativeTaskSource,
      );
      active.nativeTasks.before.find((t) => t.type === "database").data.query =
        engine === "mongodb"
          ? JSON.stringify({
              collection: "items",
              filter: { name: "edited" },
              limit: 1,
            })
          : engine === "redis"
            ? '["GET","edited-live-key"]'
            : "SELECT 2";
      assert.deepEqual(
        p.plans[0].steps[0].request.importedNativeTaskSource,
        frozenSource,
      );
      await app.store.save(p);
      const storedBeforeInvalid = await app.store.get(p.id);
      const invalid = structuredClone(storedBeforeInvalid);
      invalid.plans[0].steps[0].request.importedNativeTaskSource.before.find(
        (t) => t.type === "database",
      ).data.password = "must-reject";
      const invalidResponse = await fetch(app.url + "/api/projects/" + p.id, {
        method: "PUT",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(invalid),
      });
      assert.equal(invalidResponse.status, 400);
      assert.match((await invalidResponse.json()).error, /未知字段/);
      assert.deepEqual(await app.store.get(p.id), storedBeforeInvalid);
      const restored = restoreProject(p);
      await app.store.save(restored);
      for (const current of [p, restored])
        for (const plan of current.plans) {
          const r = await fetch(
            app.url + "/api/projects/" + current.id + "/run",
            {
              method: "POST",
              headers: {
                "x-local-token": app.token,
                "content-type": "application/json",
              },
              body: JSON.stringify({ planId: plan.id }),
            },
          );
          const result = await r.json();
          assert.equal(r.status, 200, JSON.stringify(result));
          assert.equal(result.status, "passed", JSON.stringify(result));
        }
      assert.equal(seen.length, 4);
      assert(seen.every((x) => x.db === undefined));
      assert.equal(seen.filter((x) => x.step === "owned").length, 2);
      for (const current of [p, restored]) {
        const saved = await app.store.get(current.id),
          env = saved.environments.find(
            (e) => e.id === saved.plans[1].environmentId,
          );
        assert.equal(env.variables.stepBefore, "owned");
        assert.equal(env.variables.stepAfter, "step-response");
        assert.equal(env.variables.native_value, undefined);
        assert(saved.requests.find((r) => r.id === active.id).nativeTasks);
      }
      assert.equal(JSON.stringify({ source, flows }), before);
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      app = await createApp({ root, port: 0 });
      for (const plan of (await app.store.get(p.id)).plans) {
        assert.equal(plan.steps[0].request.nativeTasks, undefined);
        assert.deepEqual(
          plan.steps[0].request.importedNativeTaskSource,
          frozenSource,
        );
        const response = await fetch(
          app.url + "/api/projects/" + p.id + "/run",
          {
            method: "POST",
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            body: JSON.stringify({ planId: plan.id }),
          },
        );
        const result = await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        assert.equal(result.status, "passed", JSON.stringify(result));
      }
      assert.equal(seen.length, 6);
      assert(seen.every((x) => x.db === undefined));
      assert.equal(seen.filter((x) => x.step === "owned").length, 3);
    },
  );
