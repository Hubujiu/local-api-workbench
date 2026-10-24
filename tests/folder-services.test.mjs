import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveServiceRequest,
  freezeServiceBinding,
} from "../src/environments.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { versionPlan } from "../src/plan-version.mjs";
test("relative requests inherit exact folder service while explicit and absolute destinations stay authoritative", () => {
  const p = {
    environments: [
      {
        id: "env",
        variables: {},
        serverUrls: { a: "https://a.test", b: "https://b.test" },
      },
    ],
    servers: [{ id: "a" }, { id: "b" }],
    settings: { folderServices: { Orders: "a" } },
  };
  const request = normalizeRequest({ folder: "Orders", url: "/items" });
  assert.equal(resolveServiceRequest(p, request).url, "https://a.test/items");
  assert.equal(
    resolveServiceRequest(p, { ...request, serviceId: "b" }).url,
    "https://b.test/items",
  );
  assert.equal(
    resolveServiceRequest(p, { ...request, url: "https://direct.test/items" })
      .url,
    "https://direct.test/items",
  );
  assert.equal(
    freezeServiceBinding(p, { ...request, url: "{{baseUrl}}/items" }).serviceId,
    "",
  );
  const plan = versionPlan(
    null,
    { name: "frozen", steps: [{ request }] },
    "manual",
    p,
  );
  assert.equal(plan.steps[0].request.serviceId, "a");
  p.settings.folderServices.Orders = "b";
  assert.equal(
    resolveServiceRequest(p, plan.steps[0].request).url,
    "https://a.test/items",
  );
  assert.equal(resolveServiceRequest(p, request).url, "https://b.test/items");
  p.servers = p.servers.filter((s) => s.id !== "a");
  assert.throws(
    () => resolveServiceRequest(p, plan.steps[0].request),
    /服务不存在/,
  );
});

test("saved plan and case execute against frozen service after folder binding changes", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const path = await import("node:path"),
    os = await import("node:os");
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "api-folder-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("folder fixture");
  project.servers = [
    { id: "a", name: "working" },
    { id: "b", name: "missing" },
  ];
  project.environments[0].serverUrls = {
    a: app.url + "/mock/" + project.id,
    b: app.url + "/mock/" + project.id + "/missing",
  };
  project.settings.folderServices = { Orders: "a" };
  project.requests = [
    {
      id: "fixture",
      name: "fixture",
      folder: "Orders",
      url: "/fixture",
      examples: [{ status: 200, body: "ok" }],
    },
  ];
  await app.store.save(project);
  const call = async (action, data) => {
    const response = await fetch(
      app.url + "/api/projects/" + project.id + "/" + action,
      {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const plan = await call("plans", {
    id: "frozen",
    name: "frozen",
    steps: [{ request: project.requests[0] }],
  });
  assert.equal(plan.steps[0].request.serviceId, "a");
  const savedCase = await call("cases", {
    name: "case",
    sourceRequestId: "fixture",
    request: project.requests[0],
  });
  const changed = await app.store.get(project.id);
  changed.settings.folderServices.Orders = "b";
  await app.store.save(changed);
  assert.equal(
    (await call("execute", { request: changed.requests[0] })).status,
    404,
  );
  const run = await call("run", { planId: "frozen", runId: "fixture" });
  assert.equal(run.status, "passed");
  assert.equal(
    (await call("execute", { request: savedCase.item.request })).status,
    200,
  );
});
