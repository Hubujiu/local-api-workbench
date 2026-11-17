import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRequest, exportOpenAPI } from "../src/core.mjs";

const request = (url, extra = {}) => normalizeRequest({ url, ...extra });
test("OpenAPI rejects colliding path/method definitions instead of overwriting requests", () => {
  for (const second of [
    "https://a.example.test/items?q=second",
    "https://b.example.test/items",
    "https://a.example.test/items#second",
  ]) {
    const project = {
      name: "Collision",
      requests: [
        request("https://a.example.test/items?q=first", { name: "First" }),
        request(second, { name: "Second" }),
      ],
    };
    const snapshot = structuredClone(project);
    assert.throws(() => exportOpenAPI(project), /OpenAPI.*重复.*GET.*\/items/);
    assert.deepEqual(project, snapshot);
  }
});
test("OpenAPI retains distinct methods and excludes deleted collisions", () => {
  const project = {
    name: "Distinct",
    requests: [
      request("https://a.example.test/items", { name: "Read" }),
      request("https://a.example.test/items", {
        method: "POST",
        name: "Create",
      }),
      {
        ...request("https://a.example.test/items"),
        deletedAt: "2026-10-23T00:00:00Z",
      },
    ],
  };
  const result = exportOpenAPI(project);
  assert.equal(result.paths["/items"].get.summary, "Read");
  assert.equal(result.paths["/items"].post.summary, "Create");
});

test("HTTP export reports collisions without partial data and native backup keeps both requests", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(join(tmpdir(), "openapi-collision-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = (url, method = "GET", body) =>
    fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const created = await call("/api/projects", "POST", { name: "Collision" });
  assert.equal(created.ok, true);
  let project = await created.json();
  project.requests = [
    request("https://first.example.test/items", { name: "First" }),
    request("https://second.example.test/items", { name: "Second" }),
  ];
  const saved = await call("/api/projects/" + project.id, "PUT", project);
  assert.equal(saved.ok, true, await saved.clone().text());
  project = await saved.json();
  const rejected = await call(
    "/api/projects/" + project.id + "/export?format=openapi",
  );
  assert.equal(rejected.ok, false);
  const error = await rejected.json();
  assert.match(error.error, /OpenAPI.*重复.*GET.*\/items/);
  assert.equal(error.paths, undefined);
  const backup = await call("/api/projects/" + project.id + "/export");
  assert.equal(backup.ok, true);
  assert.deepEqual((await backup.json()).requests, project.requests);
});
