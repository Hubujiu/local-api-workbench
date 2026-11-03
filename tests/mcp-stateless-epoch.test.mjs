import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { snapshotPlan } from "../src/core.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-stateless-epoch-"));
  const app = await createApp({ root, port: 0 });
  const seen = [];
  const entered = deferred();
  let held;
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "application/json");
    if (req.url === "/held") {
      held = res;
      entered.resolve();
    } else res.end("{}");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    held?.end("{}");
    upstream.closeAllConnections();
    app.server.closeAllConnections();
    await Promise.all(
      [upstream, app.server].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    await rm(root, { recursive: true, force: true });
  });
  const owner = async (url, body) => {
    const response = await fetch(app.url + url, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const project = await app.store.create("Stateless policy fixture");
  const base = "http://127.0.0.1:" + upstream.address().port;
  project.plans = [
    snapshotPlan({
      id: "flow",
      name: "flow",
      steps: ["/held", "/later"].map((suffix) => ({
        request: {
          name: suffix,
          method: "GET",
          url: base + suffix,
          timeout: 5000,
        },
      })),
    }),
  ];
  await app.store.save(project);
  const policy = {
    enabled: true,
    projects: [project.id],
    write: true,
    execute: true,
  };
  const grant = await owner("/api/mcp/config", policy);
  const call = () =>
    fetch(app.url + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + grant.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "same-request-id",
        method: "tools/call",
        params: {
          name: "localapi_execute_flow",
          arguments: { projectId: project.id, planId: "flow" },
        },
      }),
    }).then((response) => response.json());
  return {
    app,
    project,
    policy,
    owner,
    call,
    seen,
    entered,
    release: () => held.end("{}"),
  };
}

test(
  "owner execution revocation stops a stateless flow before its next request",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const pending = f.call();
    await f.entered.promise;
    await f.owner("/api/mcp/config", { ...f.policy, execute: false });
    f.release();
    const reply = await pending;
    const saved = await f.app.store.get(f.project.id);
    t.diagnostic(
      JSON.stringify({
        seen: f.seen,
        statuses: saved.runs.map((run) => run.status),
        responseCode: reply.error?.code,
      }),
    );
    assert.deepEqual(f.seen, ["/held"]);
    assert.equal(reply.error?.code, -32000);
    assert.equal(saved.runs.length, 1);
    assert.equal(saved.runs[0].status, "cancelled");
    assert.equal(saved.runs[0].source, "mcp");
  },
);
