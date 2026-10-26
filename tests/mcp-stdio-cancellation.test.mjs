import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";
const main = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error("stdio lifecycle observation timed out");
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-stdio-cancel-"));
  const held = new Map(),
    seen = [],
    counters = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith("/slow")) held.set(req.url, res);
    else {
      counters.push(req.headers["x-counter"]);
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    projects = [];
  const base = "http://127.0.0.1:" + server.address().port;
  for (const suffix of ["a", "b"]) {
    const p = await store.create(suffix);
    p.requests = [
      {
        id: "slow",
        name: "slow",
        method: "GET",
        url: base + "/slow-" + suffix,
        timeout: 10000,
      },
      {
        id: "counter",
        name: "counter",
        method: "GET",
        url: base + "/counter",
        beforeScript:
          'apt.setVar("counter",Number(apt.getVar("counter")||0)+1);apt.setRequestHeader("x-counter",String(apt.getVar("counter")));',
      },
    ];
    p.plans = [
      snapshotPlan({
        id: "flow",
        name: "flow",
        steps: [
          { request: p.requests[0] },
          { request: { name: "later", url: base + "/later-" + suffix } },
        ],
      }),
    ];
    await store.save(p);
    projects.push(p);
  }
  return { root, store, projects, held, seen, counters };
}
const decode = (response) => {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
};

test(
  "official SDK stdio cancels one concurrent plan while preserving shared debug state and grants",
  { timeout: 18000 },
  async (t) => {
    const {
      root,
      store,
      projects: [a, b],
      held,
      seen,
      counters,
    } = await fixture(t);
    const denied = await store.create("denied");
    const client = new Client({ name: "stdio-cancel", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        main,
        "--project",
        a.id,
        "--project",
        b.id,
        "--write",
        "--execute",
      ],
      env: { LOCAL_API_DATA: root },
      stderr: "pipe",
    });
    t.after(() => client.close().catch(() => {}));
    await client.connect(transport);
    const controller = new AbortController();
    const first = assert.rejects(
      client.callTool(
        {
          name: "localapi_execute_flow",
          arguments: { projectId: a.id, planId: a.plans[0].id },
        },
        undefined,
        { signal: controller.signal },
      ),
      /abort|cancel/i,
    );
    const second = client.callTool({
      name: "localapi_execute_flow",
      arguments: { projectId: b.id, planId: b.plans[0].id },
    });
    await waitFor(() => held.size === 2);
    controller.abort();
    await first;
    await waitFor(async () =>
      (await new Store(root).get(a.id)).runs.some(
        (run) => run.status === "cancelled",
      ),
    );
    assert(!seen.includes("/later-a"));
    assert.equal((await store.get(b.id)).runs.length, 0);
    held.get("/slow-b").end("{}");
    assert.equal(decode(await second).status, "passed");
    await waitFor(async () => {
      const rows = await readMCPActivities(root);
      return (
        rows.some(
          (row) => row.projectId === a.id && row.status === "cancelled",
        ) &&
        rows.some((row) => row.projectId === b.id && row.status === "completed")
      );
    });
    for (let i = 0; i < 2; i++)
      assert.equal(
        decode(
          await client.callTool({
            name: "localapi_execute_api",
            arguments: { projectId: a.id, apiId: "counter" },
          }),
        ).status,
        "passed",
      );
    assert.deepEqual(counters.filter(Boolean), ["1", "2"]);
    assert.equal(
      (await store.get(a.id)).environments[0].variables.counter,
      undefined,
    );
    const created = decode(
      await client.callTool({
        name: "localapi_create_project",
        arguments: { name: "new grant" },
      }),
    );
    const projects = decode(
      await client.callTool({ name: "localapi_list_projects" }),
    );
    assert(projects.some((p) => p.id === created.id));
    assert(!projects.some((p) => p.id === denied.id));
    assert.equal(
      (
        await client.callTool({
          name: "localapi_list_apis",
          arguments: { projectId: denied.id },
        })
      ).isError,
      true,
    );
    await client.ping();
  },
);

test(
  "raw stdio EOF cancels a live HTTP plan, saves terminal evidence and exits cleanly",
  { timeout: 15000 },
  async (t) => {
    const {
      root,
      store,
      projects: [p],
      held,
      seen,
    } = await fixture(t);
    const child = spawn(
      process.execPath,
      [main, "--project", p.id, "--write", "--execute"],
      {
        env: {
          LOCAL_API_DATA: root,
          ...(process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let text = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {},
      }) + "\n",
    );
    await waitFor(() => text.includes("\n"));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "localapi_execute_flow",
          arguments: { projectId: p.id, planId: p.plans[0].id },
        },
      }) + "\n",
    );
    await waitFor(() => held.size === 1);
    child.stdin.end();
    assert.equal(await exited, 0, stderr);
    const messages = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const result = decode(messages.find((message) => message.id === 1).result);
    assert.equal(result.status, "cancelled");
    assert.equal(result.recordSaved, true);
    assert.equal((await store.get(p.id)).runs[0].status, "cancelled");
    assert(!seen.includes("/later-a"));
    assert(
      (await readMCPActivities(root)).some(
        (row) => row.projectId === p.id && row.status === "cancelled",
      ),
    );
  },
);
