import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import {
  commitConcurrentProjectEdit,
  assertStaleProjectRejection,
} from "./helpers/project-save-conflict-fixture.mjs";

test("real owner stale config save leaves second client change intact until explicit read and edit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-conflict-fixture-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const requests = [];
  async function call(url, method = "GET", data) {
    requests.push({ url, method });
    const response = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const owner = async (url, method = "GET", data) => {
    const r = await call(url, method, data);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const created = await call("/api/projects", "POST", {
    name: "Conflict fixture",
  });
  assert.equal(created.status, 201);
  const endpoint = `/api/projects/${created.body.id}`;
  const initial = await owner(endpoint, "PUT", {
    ...created.body,
    requests: [
      {
        id: "request-1",
        name: "Initial",
        method: "GET",
        url: "http://127.0.0.1:1/never-execute",
        headers: [],
        params: [],
        body: { type: "none" },
      },
    ],
  });
  const { before, committed } = await commitConcurrentProjectEdit(
    owner,
    endpoint,
    initial.id,
  );
  const stale = structuredClone(before);
  stale.requests[0].name = "Local unsaved";
  const rejected = await call(endpoint, "PUT", stale);
  assertStaleProjectRejection(rejected.status, rejected.body, initial.id);
  const after = await owner(endpoint);
  assert.deepEqual(after, committed);
  assert.equal(stale.requests[0].name, "Local unsaved");
  assert.equal(requests.filter((r) => r.method === "PUT").length, 3);
  const retry = structuredClone(after);
  retry.requests[0].name = "Explicit edit after reload";
  const accepted = await owner(endpoint, "PUT", retry);
  assert.equal(accepted.name, committed.name);
  assert.equal(accepted.requests[0].name, retry.requests[0].name);
  assert.equal(accepted.configRevision, committed.configRevision + 1);
  assert.deepEqual(await owner(endpoint), accepted);
});
for (const [label, status, patch] of [
  ["wrong status", 409, {}],
  ["wrong owner", 400, { project_id: "other" }],
  ["unknown result", 400, { commit_outcome: "unknown" }],
  ["retry permission", 400, { retry_safe: true }],
  ["missing error", 400, { error: "" }],
])
  test(`conflict receipt rejects ${label}`, () => {
    assert.throws(() =>
      assertStaleProjectRejection(
        status,
        {
          project_id: "p",
          commit_outcome: "not_committed",
          retry_safe: false,
          error: "stale",
          ...patch,
        },
        "p",
      ),
    );
  });
