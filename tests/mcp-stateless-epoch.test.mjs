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
  const held = new Map();
  const gates = new Map();
  const closed = new Map();
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/held")) {
      held.set(req.url, res);
      if (req.url === "/held") entered.resolve();
      gates.get(req.url)?.resolve();
      res.once("close", () => closed.get(req.url)?.resolve());
    } else res.end("{}");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const res of held.values()) res.end("{}");
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
  const rpc = async (message, sessionId) => {
    const response = await fetch(app.url + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + grant.token,
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(message),
    });
    return {
      status: response.status,
      sessionId: response.headers.get("mcp-session-id"),
      result: response.status === 202 ? undefined : await response.json(),
    };
  };
  const call = (target = project.id, planId = "flow") =>
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
          arguments: { projectId: target, planId },
        },
      }),
    }).then((response) => response.json());
  return {
    app,
    project,
    policy,
    owner,
    call,
    rpc,
    base,
    seen,
    entered,
    waitFor: (url) => {
      if (held.has(url)) return Promise.resolve();
      if (!gates.has(url)) gates.set(url, deferred());
      return gates.get(url).promise;
    },
    waitClosed: (url) => {
      if (held.get(url)?.destroyed) return Promise.resolve();
      if (!closed.has(url)) closed.set(url, deferred());
      return closed.get(url).promise;
    },
    release: (url = "/held") => held.get(url).end("{}"),
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

for (const [name, update] of [
  ["project removal", { projects: [] }],
  ["disable", { enabled: false }],
  ["rotation", { rotate: true }],
]) {
  test(
    `owner ${name} aborts an admitted stateless execution`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const pending = f.call();
      await f.entered.promise;
      await f.owner("/api/mcp/config", { ...f.policy, ...update });
      await f.waitClosed("/held");
      const reply = await pending;
      const saved = await f.app.store.get(f.project.id);
      assert.deepEqual(f.seen, ["/held"]);
      assert.equal(reply.error?.code, -32000);
      assert.equal(saved.runs.length, 1);
      assert.equal(saved.runs[0].status, "cancelled");
      assert.equal(saved.runs[0].source, "mcp");
    },
  );
}

test(
  "same stateless request IDs remain independent and cancellation notifications cannot claim them",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const second = await f.app.store.create("Second stateless project");
    second.plans = [
      snapshotPlan({
        id: "flow",
        name: "second",
        steps: ["/held-second", "/later-second"].map((suffix) => ({
          request: {
            name: suffix,
            method: "GET",
            url: f.base + suffix,
            timeout: 5000,
          },
        })),
      }),
    ];
    await f.app.store.save(second);
    const policy = { ...f.policy, projects: [f.project.id, second.id] };
    await f.owner("/api/mcp/config", policy);
    const initialized = await f.rpc({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
    });
    assert(initialized.sessionId);
    const one = f.call();
    const two = f.call(second.id);
    await Promise.all([f.entered.promise, f.waitFor("/held-second")]);
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "same-request-id" },
    };
    assert.equal((await f.rpc(notification)).status, 202);
    assert.equal(
      (await f.rpc(notification, initialized.sessionId)).status,
      202,
    );
    f.release();
    const firstResult = JSON.parse((await one).result.content[0].text);
    assert.equal(firstResult.status, "passed");
    assert.equal(firstResult.recordSaved, true);
    assert.equal((await f.app.store.get(second.id)).runs.length, 0);
    assert(!f.seen.includes("/later-second"));
    await f.owner("/api/mcp/config", { ...policy, execute: false });
    await f.waitClosed("/held-second");
    assert.equal((await two).error?.code, -32000);
    assert.equal(
      (await f.app.store.get(second.id)).runs[0].status,
      "cancelled",
    );
    assert.equal(
      (await f.app.store.get(f.project.id)).runs[0].status,
      "passed",
    );
    assert.deepEqual(
      [...f.seen].sort(),
      ["/held", "/held-second", "/later"].sort(),
    );
  },
);

test(
  "rejected stateless dispatches release transient ownership and ID-less calls start no work",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 40; i++) {
      const rejected = await f.call(f.project.id, "missing");
      assert.equal(rejected.result.isError, true);
      const ignored = await f.rpc({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "localapi_execute_flow",
          arguments: { projectId: f.project.id, planId: "flow" },
        },
      });
      assert.equal(ignored.status, 202);
    }
    assert.deepEqual(f.seen, []);
    const pending = f.call();
    await f.entered.promise;
    f.release();
    const completed = JSON.parse((await pending).result.content[0].text);
    assert.equal(completed.status, "passed");
    assert.equal(completed.recordSaved, true);
    assert.equal((await f.app.store.get(f.project.id)).runs.length, 1);
  },
);

test(
  "server close aborts stateless work and waits for its cancelled history",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const pending = f.call();
    await f.entered.promise;
    const closing = new Promise((resolve, reject) =>
      f.app.server.close((error) => (error ? reject(error) : resolve())),
    );
    await f.waitClosed("/held");
    assert.equal((await pending).error?.code, -32000);
    await closing;
    const saved = await f.app.store.get(f.project.id);
    assert.deepEqual(f.seen, ["/held"]);
    assert.equal(saved.runs.length, 1);
    assert.equal(saved.runs[0].status, "cancelled");
  },
);

test(
  "revocation after confirmed history persistence does not rewrite completed effects",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const enteredAppend = deferred();
    const releaseAppend = deferred();
    const append = f.app.store.append.bind(f.app.store);
    t.after(() => releaseAppend.resolve());
    t.mock.method(f.app.store, "append", async (...args) => {
      const value = await append(...args);
      enteredAppend.resolve();
      await releaseAppend.promise;
      return value;
    });
    const pending = f.call();
    await f.entered.promise;
    f.release();
    await enteredAppend.promise;
    const before = await f.app.store.get(f.project.id);
    assert.equal(before.runs[0].status, "passed");
    await f.owner("/api/mcp/config", { ...f.policy, execute: false });
    releaseAppend.resolve();
    assert.equal((await pending).error?.code, -32000);
    const after = await f.app.store.get(f.project.id);
    assert.deepEqual(after.runs, before.runs);
    assert.deepEqual(f.seen, ["/held", "/later"]);
  },
);
