import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { recentSavedDefinitions } from "../src/recent-saved-definitions.mjs";
import { validateSavedVersionSummary } from "../public/recent-saved-versions.js";

test("saved definition projection bounds, orders and returns only active owner metadata", () => {
  const requests = Array.from({ length: 52 }, (_, i) => ({
    id: "id-" + i,
    name: "Name " + i,
    method: "GET",
    url: "private-url",
    body: "private-body",
  }));
  const entries = requests.map((request, i) => ({
    requestId: request.id,
    currentVersion: 1,
    currentCreatedAt: new Date(Date.UTC(2026, 10, 21, 0, i)).toISOString(),
  }));
  const project = {
    id: "owner",
    configRevision: 3,
    requests: [
      ...requests,
      { id: "untracked" },
      { id: "deleted", deletedAt: "time" },
    ],
    requestDefinitionHistory: {
      projectId: "owner",
      entries: [...entries, { requestId: "deleted", retired: true }],
    },
  };
  const data = recentSavedDefinitions(project);
  assert.equal(data.tracked, 52);
  assert.equal(data.untracked, 1);
  assert.equal(data.rows.length, 50);
  assert.equal(data.rows[0].requestId, "id-51");
  assert.deepEqual(Object.keys(data.rows[0]).sort(), [
    "currentCreatedAt",
    "method",
    "name",
    "requestId",
    "version",
  ]);
  assert.doesNotMatch(JSON.stringify(data), /private-url|private-body/);
  assert.equal(validateSavedVersionSummary(data, "owner"), data);
  assert.throws(
    () => validateSavedVersionSummary(data, "another project"),
    /不属于/,
  );
  assert.throws(
    () =>
      validateSavedVersionSummary(
        { ...data, rows: [data.rows[0], ...data.rows.slice(0, 49)] },
        "owner",
      ),
    /格式不完整/,
  );
  assert.deepEqual(
    recentSavedDefinitions({ ...project, requestDefinitionHistory: undefined })
      .rows,
    [],
  );
});

test("owner route returns canonical metadata only and does not accept mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "recent-saved-route-"));
  const app = await createApp({ root, port: 0 });
  try {
    let project = await app.store.create("Saved route fixture");
    project.requests = [
      normalizeRequest({
        id: "fixture",
        name: "Initial persisted",
        method: "POST",
        url: "http://127.0.0.1:32187/not-dispatched",
        bodyType: "raw",
        body: "private-body",
        headers: [{ key: "X-Private", value: "private-header" }],
        auth: { type: "bearer", token: "private-bearer" },
      }),
    ];
    project = await app.store.save(project);
    const first = project.requestDefinitionHistory.entries[0];
    project.requests[0].name = "Canonical saved name";
    project = await app.store.save(project);
    const current = project.requestDefinitionHistory.entries[0];
    const launch = new URL(app.launchUrl);
    const token = new URLSearchParams(launch.hash.slice(1)).get("token");
    const endpoint = new URL(
      "/api/projects/" + project.id + "/recent-saved-definitions",
      launch,
    );
    assert.equal((await fetch(endpoint)).status, 403);
    const headers = { "x-local-token": token };
    const response = await fetch(endpoint, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = await response.json();
    assert.equal(data.projectId, project.id);
    assert.equal(first.currentVersion, 1);
    assert.equal(data.rows[0].version, 2);
    assert.deepEqual(data.rows, [
      {
        requestId: "fixture",
        name: "Canonical saved name",
        method: "POST",
        version: 2,
        currentCreatedAt: current.currentCreatedAt,
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(data),
      /private-header|private-body|private-bearer|not-dispatched/,
    );
    assert.equal(
      (await fetch(new URL(endpoint + "?limit=30"), { headers })).status,
      400,
    );
    assert.equal(
      (await fetch(endpoint, { headers, method: "POST" })).status,
      405,
    );
    assert.equal(
      (await app.store.get(project.id)).configRevision,
      project.configRevision,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
