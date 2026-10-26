import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, rename, symlink, readFile } from "node:fs/promises";
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
async function fixture(t, count = 2) {
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
  for (const suffix of Array.from({ length: count }, (_, i) =>
    String.fromCharCode(97 + i),
  )) {
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
    const protocolErrors = [];
    client.onerror = (error) => protocolErrors.push(error.message);
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
    assert(
      !protocolErrors.some((message) => /unknown.*id/i.test(message)),
      protocolErrors.join("\n"),
    );
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

test(
  "stdio cancellation remains available with ten occupied tool slots and all runs retain evidence",
  { timeout: 20000 },
  async (t) => {
    const { root, store, projects, held, seen } = await fixture(t, 10);
    const client = new Client({ name: "stdio-full-slots", version: "1" });
    t.after(() => client.close().catch(() => {}));
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          main,
          ...projects.flatMap((p) => ["--project", p.id]),
          "--write",
          "--execute",
        ],
        env: { LOCAL_API_DATA: root },
        stderr: "pipe",
      }),
    );
    const controllers = projects.map(() => new AbortController());
    const rejections = projects.map((p, i) =>
      assert.rejects(
        client.callTool(
          {
            name: "localapi_execute_flow",
            arguments: { projectId: p.id, planId: p.plans[0].id },
          },
          undefined,
          { signal: controllers[i].signal },
        ),
        /abort|cancel/i,
      ),
    );
    await waitFor(() => held.size === 10);
    await assert.rejects(
      client.callTool({ name: "localapi_list_projects" }),
      /concurrent tool limit/i,
    );
    controllers[0].abort();
    await rejections[0];
    await waitFor(async () =>
      (await store.get(projects[0].id)).runs.some(
        (run) => run.status === "cancelled",
      ),
    );
    controllers.slice(1).forEach((controller) => controller.abort());
    await Promise.all(rejections);
    await waitFor(
      async () =>
        (await readMCPActivities(root)).filter(
          (row) => row.status === "cancelled",
        ).length === 10,
    );
    for (const p of projects)
      assert.equal((await store.get(p.id)).runs[0].status, "cancelled");
    assert(!seen.some((url) => url.startsWith("/later")));
    await client.ping();
    assert.equal(
      decode(await client.callTool({ name: "localapi_list_projects" })).length,
      10,
    );
  },
);

test(
  "stdio cancelled execution exposes real disk save failure without replay and recovery retains its result",
  { timeout: 18000 },
  async (t) => {
    const {
      root,
      store,
      projects: [p],
      held,
      seen,
    } = await fixture(t);
    const client = new Client({ name: "stdio-save-failure", version: "1" });
    t.after(() => client.close().catch(() => {}));
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [main, "--project", p.id, "--write", "--execute"],
        env: { LOCAL_API_DATA: root },
        stderr: "pipe",
      }),
    );
    const controller = new AbortController();
    const rejected = assert.rejects(
      client.callTool(
        {
          name: "localapi_execute_flow",
          arguments: { projectId: p.id, planId: p.plans[0].id },
        },
        undefined,
        { signal: controller.signal },
      ),
      /abort|cancel/i,
    );
    await waitFor(() => held.size === 1);
    const directory = store.directory(p.id),
      history = path.join(directory, "history");
    await rename(history, path.join(directory, "history-original"));
    // Reads see ENOENT and retain defaults; atomic application cannot mkdir a
    // dangling directory link, so failure is after journal publication.
    await symlink(
      path.join(directory, "missing-history-target"),
      history,
      "junction",
    );
    controller.abort();
    await rejected;
    await waitFor(async () =>
      (await readMCPActivities(root)).some(
        (row) => row.projectId === p.id && row.recordSaved === false,
      ),
    );
    const activity = (await readMCPActivities(root)).find(
      (row) => row.projectId === p.id && row.recordSaved === false,
    );
    assert.equal(activity.status, "failed");
    assert.equal(activity.executionStatus, "cancelled");
    assert.match(activity.persistenceError, /保存失败/);
    assert(!JSON.stringify(activity).includes(root));
    const journal = JSON.parse(
      await readFile(path.join(directory, ".transaction.json"), "utf8"),
    );
    assert.equal(journal.runs[0].status, "cancelled");
    await rm(history);
    await rename(path.join(directory, "history-original"), history);
    const recovered = await new Store(root).get(p.id);
    assert.equal(recovered.runs[0].status, "cancelled");
    assert.equal(seen.filter((url) => url === "/slow-a").length, 1);
    assert(!seen.includes("/later-a"));
    await client.ping();
  },
);

test(
  "stdio entrypoint starts through a symlinked directory",
  { timeout: 12000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-stdio-entry-"));
    const alias = path.join(root, "linked-app");
    await symlink(path.resolve(import.meta.dirname, ".."), alias, "junction");
    const data = path.join(root, "data"),
      store = new Store(data);
    const p = await store.create("linked entry");
    const client = new Client({ name: "linked-stdio", version: "1" });
    t.after(async () => {
      await client.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(alias, "src", "mcp.mjs"), "--project", p.id],
        env: { LOCAL_API_DATA: data },
        stderr: "pipe",
      }),
    );
    await client.ping();
    assert.equal(
      decode(await client.callTool({ name: "localapi_list_projects" }))[0].id,
      p.id,
    );
  },
);

// Cross-feature acceptance: native MCP aliases and per-process created-project grants.
test(
  "stdio native aliases cancel API/flow and isolate newly created project grants across restart",
  { timeout: 20000 },
  async (t) => {
    const {
      root,
      store,
      projects: [p],
      held,
      seen,
    } = await fixture(t);
    const client = new Client({ name: "native-stdio-cancel", version: "1" });
    const errors = [];
    client.onerror = (error) => errors.push(error.message);
    const connect = async (c) =>
      c.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [main, "--project", p.id, "--write", "--execute"],
          env: { LOCAL_API_DATA: root },
          stderr: "pipe",
        }),
      );
    t.after(() => client.close().catch(() => {}));
    await connect(client);
    assert(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "apipost_execute_api",
      ),
    );
    const created = decode(
      await client.callTool({
        name: "apipost_create_project",
        arguments: { name: "ephemeral native grant" },
      }),
    );
    const added = await store.get(created.project_id);
    added.requests = [
      {
        id: "slow",
        name: "created request",
        method: "GET",
        url: p.requests[0].url.replace("/slow-a", "/slow-created"),
        timeout: 10000,
      },
    ];
    await store.save(added);
    for (const [projectId, tool, args, collection, endpoint] of [
      [
        p.id,
        "apipost_execute_api",
        { project_id: p.id, target_id: p.requests[0].id },
        "history",
        "/slow-a",
      ],
      [
        p.id,
        "apipost_execute_flow",
        { project_id: p.id, flow_id: p.plans[0].id },
        "runs",
        "/slow-a",
      ],
      [
        added.id,
        "apipost_execute_api",
        { project_id: added.id, target_id: "slow" },
        "history",
        "/slow-created",
      ],
    ]) {
      const previous = seen.filter((url) => url === endpoint).length;
      const oldIds = new Set(
        (await store.get(projectId))[collection].map((record) => record.id),
      );
      const controller = new AbortController();
      const rejected = assert.rejects(
        client.callTool({ name: tool, arguments: args }, undefined, {
          signal: controller.signal,
        }),
        /abort|cancel/i,
      );
      await waitFor(
        () => seen.filter((url) => url === endpoint).length > previous,
      );
      controller.abort();
      await rejected;
      await waitFor(async () =>
        (await store.get(projectId))[collection].some(
          (record) => !oldIds.has(record.id) && record.status === "cancelled",
        ),
      );
      await waitFor(async () =>
        (await readMCPActivities(root)).some(
          (row) =>
            row.projectId === projectId &&
            row.tool === tool &&
            row.status === "cancelled" &&
            row.recordSaved === true,
        ),
      );
    }
    assert(!seen.some((url) => url.startsWith("/later")));
    assert(
      !errors.some((message) => /unknown.*id/i.test(message)),
      errors.join("\n"),
    );
    const current = decode(
      await client.callTool({ name: "apipost_list_projects" }),
    );
    assert(current.projects.some((project) => project.project_id === added.id));
    const restarted = new Client({
      name: "native-stdio-restarted",
      version: "1",
    });
    t.after(() => restarted.close().catch(() => {}));
    await connect(restarted);
    assert.equal(
      (
        await restarted.callTool({
          name: "apipost_list_apis",
          arguments: { project_id: added.id },
        })
      ).isError,
      true,
    );
    assert(
      !decode(
        await restarted.callTool({ name: "apipost_list_projects" }),
      ).projects.some((project) => project.project_id === added.id),
    );
  },
);
