import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
test("session, project persistence, permission boundary, mock and snapshot plan", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-server-"));
  const a = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((r) => a.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  let r = await fetch(a.url + "/api/projects");
  assert.equal(r.status, 403);
  r = await fetch(a.url + "/api/session", {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(r.status, 403);
  const call = async (p, method = "GET", data) => {
    let r = await fetch(a.url + p, {
      method,
      headers: { "x-local-token": a.token, "content-type": "application/json" },
      body: data ? JSON.stringify(data) : undefined,
    });
    assert(r.ok, await r.clone().text());
    return r.json();
  };
  let p = await call("/api/projects", "POST", { name: "Integration" });
  p.requests = [
    {
      id: "test",
      name: "Fixture",
      url: a.url + "/mock/" + p.id + "/test",
      method: "GET",
      examples: [{ status: 200, body: '{"token":"ok"}' }],
    },
  ];
  p = await call("/api/projects/" + p.id, "PUT", p);
  let response = await call("/api/projects/" + p.id + "/execute", "POST", {
    request: p.requests[0],
  });
  assert.equal(response.status, 200);
  let plan = await call("/api/projects/" + p.id + "/plans", "POST", {
    name: "test plan",
    steps: [{ request: p.requests[0] }],
  });
  let run = await call("/api/projects/" + p.id + "/run", "POST", {
    planId: plan.id,
  });
  assert.equal(run.status, "passed");
  assert.equal((await call("/api/projects/" + p.id)).runs.length, 1);
});
