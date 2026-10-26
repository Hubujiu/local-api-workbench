import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";

const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error("Expected cancellation lifecycle observation did not arrive");
};
test(
  "official SDK cancellation stays session-scoped and persists server-side terminal evidence",
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-cancellation-"));
    const app = await createApp({ root, port: 0 });
    const pendingResponses = new Map(),
      seen = [],
      clients = [],
      errors = [];
    const upstream = http.createServer((req, res) => {
      seen.push(req.url);
      if (req.url.startsWith("/slow")) pendingResponses.set(req.url, res);
      else {
        res.setHeader("content-type", "application/json");
        res.end("{}");
      }
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      await Promise.all(
        clients.map(({ client }) => client.close().catch(() => {})),
      );
      upstream.closeAllConnections();
      app.server.closeAllConnections();
      await Promise.all(
        [upstream, app.server].map(
          (server) => new Promise((resolve) => server.close(resolve)),
        ),
      );
      await rm(root, { recursive: true, force: true });
    });
    const base = "http://127.0.0.1:" + upstream.address().port;
    const a = await app.store.create("first"),
      b = await app.store.create("second");
    for (const [p, suffix] of [
      [a, "a"],
      [b, "b"],
    ]) {
      p.requests = [
        {
          id: "slow",
          name: "slow",
          method: "GET",
          url: base + "/slow-" + suffix,
          timeout: 10000,
        },
      ];
      p.plans = [
        snapshotPlan({
          id: "flow",
          name: "flow",
          steps: [
            { request: p.requests[0] },
            {
              request: {
                name: "later",
                method: "GET",
                url: base + "/later-" + suffix,
              },
            },
          ],
        }),
      ];
      await app.store.save(p);
    }
    const headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
    const config = await fetch(app.url + "/api/mcp/config", {
      method: "POST",
      headers,
      body: JSON.stringify({
        enabled: true,
        projects: [a.id, b.id],
        write: true,
        execute: true,
      }),
    }).then((r) => r.json());
    const connect = async () => {
      const messages = [];
      const transport = new StreamableHTTPClientTransport(
        new URL(app.url + "/mcp"),
        {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
          fetch: async (url, init) => {
            if (typeof init?.body === "string")
              messages.push(JSON.parse(init.body));
            return fetch(url, init);
          },
        },
      );
      const client = new Client({ name: "cancel-fixture", version: "1" });
      client.onerror = (error) => errors.push(error.message);
      const item = { client, transport, messages };
      clients.push(item);
      await client.connect(transport);
      return item;
    };
    const first = await connect(),
      second = await connect();
    assert(first.transport.sessionId && second.transport.sessionId);
    assert.notEqual(first.transport.sessionId, second.transport.sessionId);
    const initialSessionIds = [
      first.transport.sessionId,
      second.transport.sessionId,
    ];
    const abort = new AbortController();
    const one = first.client.callTool(
      {
        name: "localapi_execute_flow",
        arguments: { projectId: a.id, planId: a.plans[0].id },
      },
      undefined,
      { signal: abort.signal },
    );
    const rejected = assert.rejects(one, /abort|cancel/i);
    const two = second.client.callTool({
      name: "localapi_execute_flow",
      arguments: { projectId: b.id, planId: b.plans[0].id },
    });
    await waitFor(() => pendingResponses.size === 2);
    assert.equal(
      first.messages.find((x) => x.method === "tools/call").id,
      second.messages.find((x) => x.method === "tools/call").id,
    );
    abort.abort();
    await rejected;
    await waitFor(async () =>
      (await new Store(root).get(a.id)).runs.some(
        (run) => run.status === "cancelled",
      ),
    );
    assert(!seen.includes("/later-a"));
    assert.equal(
      (await app.store.get(b.id)).runs.length,
      0,
      "other session must still be executing",
    );
    pendingResponses.get("/slow-b").end("{}");
    const completed = JSON.parse((await two).content[0].text);
    assert.equal(completed.status, "passed");
    assert(seen.includes("/later-b"));
    assert(
      !errors.some((message) => /unknown.*id/i.test(message)),
      errors.join("\n"),
    );
    await first.client.ping();
    // A cancelled request ID remains consumed, so a late notification cannot target a reused ID.
    const requestId = first.messages.find((x) => x.method === "tools/call").id;
    const rpcHeaders = {
      Authorization: "Bearer " + config.token,
      "content-type": "application/json",
      "mcp-session-id": first.transport.sessionId,
    };
    for (const id of [requestId, "unknown"]) {
      const response = await fetch(app.url + "/mcp", {
        method: "POST",
        headers: rpcHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id },
        }),
      });
      assert.equal(response.status, 202);
    }
    const duplicate = await fetch(app.url + "/mcp", {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "ping" }),
    });
    assert.equal(duplicate.status, 400);
    const deletedSession = second.transport.sessionId;
    await second.transport.terminateSession();
    const stale = await fetch(app.url + "/mcp", {
      method: "POST",
      headers: { ...rpcHeaders, "mcp-session-id": deletedSession },
      body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "ping" }),
    });
    assert.equal(stale.status, 404);
    // SDK clears its session header after DELETE; legacy stateless reads remain supported.
    await second.client.ping();
    const cancelCall = async (name, args) => {
      const previous = seen.filter((url) => url === "/slow-a").length;
      const controller = new AbortController();
      const pending = first.client.callTool(
        { name, arguments: args },
        undefined,
        { signal: controller.signal },
      );
      const rejection = assert.rejects(pending, /abort|cancel/i);
      await waitFor(
        () => seen.filter((url) => url === "/slow-a").length > previous,
      );
      controller.abort();
      await rejection;
    };
    await cancelCall("localapi_execute_api", {
      projectId: a.id,
      apiId: "slow",
    });
    await waitFor(async () =>
      (await new Store(root).get(a.id)).history.some(
        (record) => record.status === "cancelled",
      ),
    );

    const append = app.store.append.bind(app.store);
    app.store.append = async (projectId, group, record) => {
      if (projectId === a.id && group === "runs")
        throw Error("/private-storage-path/fixture-secret");
      return append(projectId, group, record);
    };
    try {
      await cancelCall("localapi_execute_flow", {
        projectId: a.id,
        planId: a.plans[0].id,
      });
      await waitFor(async () => {
        const state = await fetch(app.url + "/api/mcp/config", {
          headers,
        }).then((r) => r.json());
        return state.lastActivity?.recordSaved === false;
      });
      const state = await fetch(app.url + "/api/mcp/config", { headers }).then(
        (r) => r.json(),
      );
      assert.equal(state.lastActivity.status, "failed");
      assert.equal(state.lastActivity.executionStatus, "cancelled");
      assert.match(state.lastActivity.persistenceError, /保存失败/);
      assert(!JSON.stringify(state.lastActivity).includes("fixture-secret"));
    } finally {
      app.store.append = append;
    }
    const previous = seen.filter((url) => url === "/slow-a").length;
    const deletionPending = first.client.callTool({
      name: "localapi_execute_flow",
      arguments: { projectId: a.id, planId: a.plans[0].id },
    });
    await waitFor(
      () => seen.filter((url) => url === "/slow-a").length > previous,
    );
    await first.transport.terminateSession();
    const deletionResult = JSON.parse((await deletionPending).content[0].text);
    assert.equal(deletionResult.status, "cancelled");
    assert.equal(deletionResult.recordSaved, true);

    const disk = await new Store(root).get(a.id);
    assert.equal(disk.runs[0].source, "mcp");
    for (const sessionId of initialSessionIds)
      assert(!JSON.stringify(disk).includes(sessionId));

    const capacityProjects = [];
    for (let i = 0; i < 10; i++) {
      const project = await app.store.create("capacity-" + i);
      project.requests = [
        {
          id: "slow",
          name: "capacity",
          method: "GET",
          url: base + "/slow-cap-" + i,
          timeout: 10000,
        },
      ];
      await app.store.save(project);
      capacityProjects.push(project);
    }
    const configure = async (execute) => {
      const response = await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers,
        body: JSON.stringify({
          enabled: true,
          projects: [a.id, b.id, ...capacityProjects.map((p) => p.id)],
          write: execute,
          execute,
        }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).token, config.token);
    };
    await configure(true);
    const capacity = await connect();
    const controllers = capacityProjects.map(() => new AbortController());
    const rejections = capacityProjects.map((project, i) =>
      assert.rejects(
        capacity.client.callTool(
          {
            name: "localapi_execute_api",
            arguments: { projectId: project.id, apiId: "slow" },
          },
          undefined,
          { signal: controllers[i].signal },
        ),
        /abort|cancel/i,
      ),
    );
    await waitFor(
      () => seen.filter((url) => url.startsWith("/slow-cap-")).length === 10,
    );
    await assert.rejects(
      capacity.client.callTool({ name: "localapi_list_projects" }),
      /429|并发/,
    );
    controllers[0].abort();
    await rejections[0];
    await waitFor(async () =>
      (await app.store.get(capacityProjects[0].id)).history.some(
        (row) => row.status === "cancelled",
      ),
    );
    controllers.slice(1).forEach((controller) => controller.abort());
    await Promise.all(rejections);
    await waitFor(async () => {
      const state = await fetch(app.url + "/api/mcp/config", { headers }).then(
        (r) => r.json(),
      );
      return !state.activities.some(
        (activity) => activity.status === "running",
      );
    });
    // The same session takes the next policy, while in-flight calls lose the old epoch.
    const beforePolicy = seen.filter((url) => url === "/slow-a").length;
    const previousRuns = (await app.store.get(a.id)).runs.length;
    const policyPending = capacity.client.callTool({
      name: "localapi_execute_flow",
      arguments: { projectId: a.id, planId: a.plans[0].id },
    });
    const policyRejected = assert.rejects(
      policyPending,
      /authorization changed/i,
    );
    await waitFor(
      () => seen.filter((url) => url === "/slow-a").length > beforePolicy,
    );
    await configure(false);
    await policyRejected;
    await waitFor(
      async () => (await app.store.get(a.id)).runs.length > previousRuns,
    );
    assert.equal((await app.store.get(a.id)).runs[0].status, "cancelled");
    assert(
      !(await capacity.client.listTools()).tools.some(
        (tool) => tool.name === "localapi_execute_api",
      ),
    );
  },
);
