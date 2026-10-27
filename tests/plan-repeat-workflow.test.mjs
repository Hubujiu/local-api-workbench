import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { restoreProject } from "../src/core.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";
const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "plan-repeat-workflow-"));
  let app = await createApp({ root, port: 0 });
  const seen = [],
    clients = [];
  let beforeReply = async () => {};
  const peer = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    seen.push({
      url: req.url,
      token: req.headers["x-token"],
      identity: req.headers["x-identity"],
      frozen: req.headers["x-frozen"],
    });
    await beforeReply(req, res);
    if (res.destroyed) return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ token: `token-${seen.length}` }));
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await close();
    peer.closeAllConnections();
    await new Promise((r) => peer.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const post = async (route, body) => {
    const res = await fetch(app.url + "/api/" + route, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, value: await res.json() };
  };
  const makeProject = async (name) => {
    const p = await app.store.create(name);
    p.environments[0].variables = { identity: name, token: "initial" };
    p.requests = ["login", "refresh", "consume", "after"].map((part) => ({
      id: part,
      name: part,
      url: `http://127.0.0.1:${peer.address().port}/${part}`,
      method: "POST",
      headers: [
        { key: "X-Identity", value: "{{identity}}" },
        { key: "X-Token", value: "{{token}}" },
        { key: "X-Frozen", value: "original" },
      ],
      extract: ["login", "refresh"].includes(part)
        ? [{ name: "token", source: "json", path: "$.token" }]
        : [],
    }));
    await app.store.save(p);
    return p;
  };
  const definition = (p) => ({
    name: "Frozen repeated workflow",
    environmentId: p.environments[0].id,
    steps: [
      { id: "login", request: p.requests[0] },
      {
        type: "repeat",
        id: "group",
        count: 2,
        steps: [
          { id: "refresh", request: p.requests[1] },
          { id: "consume", request: p.requests[2] },
        ],
      },
      { id: "after", request: p.requests[3] },
    ],
  });
  const client = () => {
    const c = new Client({ name: "repeat-workflow", version: "1.0" });
    clients.push(c);
    return c;
  };
  return {
    root,
    seen,
    post,
    makeProject,
    definition,
    client,
    get app() {
      return app;
    },
    beforeReply: (fn) => {
      beforeReply = fn;
    },
    restart: async () => {
      await close();
      app = await createApp({ root, port: 0 });
    },
  };
}
function checkRun(run) {
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true);
  assert.equal(run.recordId, run.id);
  assert.equal(run.snapshot.steps[1].type, "repeat");
  assert.equal(run.snapshot.steps[1].count, 2);
  assert.equal(run.results.length, 6);
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["login", "refresh", "consume", "refresh", "consume", "after"],
  );
  assert.equal(
    new Set(
      run.results.filter((r) => r.repeat).map((r) => r.repeat.occurrenceId),
    ).size,
    4,
  );
}
test(
  "owner and official SDK HTTP/stdio retain repeat graphs, frozen definitions and project isolation through backup/restart and CLI",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const allowed = await f.makeProject("allowed"),
      denied = await f.makeProject("denied");
    const create = await f.post(
      `projects/${allowed.id}/plans`,
      f.definition(allowed),
    );
    assert.equal(create.status, 200);
    const plan = create.value;
    const owner = await f.post(`projects/${allowed.id}/run`, {
      planId: plan.id,
    });
    assert.equal(owner.status, 200);
    checkRun(owner.value);
    assert.deepEqual(
      f.seen.map((r) => r.url),
      ["/login", "/refresh", "/consume", "/refresh", "/consume", "/after"],
    );
    assert.equal(
      f.seen[2].token,
      JSON.parse(owner.value.results[1].response.body).token,
    );
    const edit = await f.app.store.get(allowed.id);
    edit.requests[1].url = "http://127.0.0.1:1/must-not-send";
    edit.requests[1].headers[2].value = "live-edited";
    edit.environments[0].variables.identity = "allowed-now";
    await f.app.store.save(edit);
    const settings = await f.post("mcp/config", {
      enabled: true,
      projects: [allowed.id],
      write: true,
      execute: true,
      remember: false,
    });
    const sdk = f.client();
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer " + settings.value.token },
        },
      }),
    );
    const beforeDenied = f.seen.length;
    const resaved = decode(
      await sdk.callTool({
        name: "localapi_save_plan",
        arguments: { projectId: allowed.id, plan },
      }),
    );
    assert.deepEqual(resaved.steps, plan.steps);
    assert.equal(f.seen.length, beforeDenied);
    assert.equal(
      (
        await sdk.callTool({
          name: "localapi_run_plan",
          arguments: { projectId: denied.id, planId: plan.id },
        })
      ).isError,
      true,
    );
    assert.equal(f.seen.length, beforeDenied);
    const fromSDK = decode(
      await sdk.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: allowed.id, planId: plan.id },
      }),
    );
    checkRun(fromSDK);
    assert.equal(fromSDK.planHash, owner.value.planHash);
    assert.ok(
      f.seen
        .slice(-6)
        .every((r) => r.identity === "allowed-now" && r.frozen === "original"),
    );
    const saved = await f.app.store.get(allowed.id);
    const restored = restoreProject(saved);
    restored.environments[0].variables.identity = "restored";
    await f.app.store.save(restored);
    await sdk.close();
    await f.restart();
    const restarted = await f.post(`projects/${restored.id}/run`, {
      planId: plan.id,
    });
    checkRun(restarted.value);
    assert.ok(f.seen.slice(-6).every((r) => r.identity === "restored"));
    const stdio = f.client();
    await stdio.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(repo, "src/mcp.mjs"),
          "--project",
          restored.id,
          "--write",
          "--execute",
        ],
        env: { ...process.env, LOCAL_API_DATA: f.root },
        stderr: "pipe",
      }),
    );
    const stdioRun = decode(
      await stdio.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: restored.id, planId: plan.id },
      }),
    );
    checkRun(stdioRun);
    await stdio.close();
    const activity = (await readMCPActivities(f.root)).find(
      (row) => row.projectId === restored.id && row.planId === plan.id,
    );
    assert.equal(activity.completed, 6);
    assert.equal(activity.total, 6);
    assert.equal(activity.repeat, undefined); // Trailing linear step, not stale group metadata.
    const cli = await exec(
      process.execPath,
      ["scripts/run-plan.mjs", "--project", restored.id, "--plan", plan.id],
      {
        cwd: repo,
        env: { ...process.env, LOCAL_API_DATA: f.root },
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const cliRun = JSON.parse(cli.stdout);
    checkRun(cliRun);
    const disk = await new Store(f.root).get(restored.id);
    assert.ok(disk.runs.some((r) => r.id === cliRun.id));
    assert.deepEqual(disk.plans[0].steps, saved.plans[0].steps);
    assert.deepEqual((await f.app.store.get(denied.id)).runs, []);
    assert.equal(f.seen.length, 30);
  },
);

test(
  "repeat completed wire evidence survives real generic and post-journal save failures without replay",
  { timeout: 15000 },
  async (t) => {
    for (const mode of ["generic", "unknown"])
      await t.test(mode, async (t) => {
        const f = await fixture(t),
          p = await f.makeProject(mode);
        const made = await f.post(`projects/${p.id}/plans`, f.definition(p));
        assert.equal(made.status, 200);
        const directory = f.app.store.directory(p.id),
          history = path.join(directory, "history"),
          kept = path.join(directory, "owned-history-backup"),
          journal = path.join(directory, ".transaction.json");
        const file = path.join(history, "requests.json"),
          original = await readFile(file, "utf8");
        const save = f.app.store.save,
          read = f.app.store.readUnlocked;
        let blocked = false,
          attempted = 0;
        if (mode === "generic")
          f.beforeReply(async (req) => {
            if (req.url === "/after") await writeFile(file, '{"owned-broken":');
          });
        else
          f.app.store.save = async function (project, options) {
            if (project.id !== p.id || !options?.activity)
              return save.call(this, project, options);
            attempted++;
            // Real Store reads/preflight/journal/apply still execute. The fixture only
            // introduces an owned ordinary-file obstacle after the original read.
            this.readUnlocked = async function (id) {
              const state = await read.call(this, id);
              this.readUnlocked = read;
              await rename(history, kept);
              await writeFile(history, "private-obstacle-marker");
              blocked = true;
              return state;
            };
            try {
              return await save.call(this, project, options);
            } finally {
              this.readUnlocked = read;
            }
          };
        t.after(() => {
          f.app.store.save = save;
          f.app.store.readUnlocked = read;
        });
        const response = await f.post(`projects/${p.id}/run`, {
          planId: made.value.id,
        });
        assert.equal(response.status, 200);
        const run = response.value;
        assert.equal(run.status, "passed");
        assert.equal(run.results.length, 6);
        assert.equal(run.snapshot.steps[1].type, "repeat");
        assert.equal(run.recordSaved, false);
        assert.equal(run.recordId, null);
        assert.equal(run.attemptedRecordId, run.id);
        assert.equal(run.persistenceOutcome.retry_safe, false);
        assert.equal(f.seen.length, 6);
        assert.equal(
          run.persistenceOutcome.code,
          mode === "generic"
            ? "RECORD_SAVE_FAILED"
            : "PROJECT_COMMIT_UNCERTAIN",
        );
        const receipt = JSON.stringify({
          message: run.persistenceError,
          outcome: run.persistenceOutcome,
        });
        assert.ok(!receipt.includes(f.root));
        assert.ok(!receipt.includes("private-obstacle-marker"));
        f.app.store.save = save;
        f.app.store.readUnlocked = read;
        if (mode === "generic") {
          await assert.rejects(readFile(journal), { code: "ENOENT" });
          await writeFile(file, original);
        } else {
          assert.equal(attempted, 1);
          assert.equal(blocked, true);
          assert.equal(run.persistenceOutcome.commit_outcome, "unknown");
          assert.equal(run.persistenceOutcome.project_id, p.id);
          assert.ok((await readFile(journal, "utf8")).length > 0);
          await rm(history);
          await rename(kept, history);
        }
        const repaired = await new Store(f.root).get(p.id);
        assert.equal(
          repaired.runs.some((r) => r.id === run.id),
          mode === "unknown",
        );
        assert.equal(f.seen.length, 6);
      });
  },
);

test(
  "owner cancellation interrupts an actual in-flight repeat leaf and durably records only started occurrences",
  { timeout: 12000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.makeProject("cancelled");
    const made = await f.post(`projects/${p.id}/plans`, f.definition(p));
    assert.equal(made.status, 200);
    let entered, closed;
    const pending = new Promise((resolve) => {
      entered = resolve;
    });
    f.beforeReply((req, res) => {
      if (
        req.url !== "/refresh" ||
        f.seen.filter((r) => r.url === "/refresh").length !== 2
      )
        return;
      closed = new Promise((resolve) => res.once("close", resolve));
      entered();
      return closed;
    });
    const executing = f.post(`projects/${p.id}/run`, {
      planId: made.value.id,
      runId: "repeat-cancel",
    });
    await pending;
    assert.equal((await f.post("cancel", { id: "repeat-cancel" })).status, 200);
    const { value: run } = await executing;
    await closed;
    assert.equal(run.status, "cancelled");
    assert.equal(run.recordSaved, true);
    assert.equal(run.results.length, 4);
    assert.equal(f.seen.length, 4);
    assert.equal(run.results[3].repeat.iteration, 1);
    assert.equal(run.results[3].repeat.childId, "refresh");
    assert.equal(run.results[3].status, "failed");
    assert.equal(
      run.variables.token,
      JSON.parse(run.results[1].response.body).token,
    );
    const saved = await new Store(f.root).get(p.id);
    assert.equal(saved.runs.find((r) => r.id === run.id).status, "cancelled");
    assert.equal(saved.runs.find((r) => r.id === run.id).results.length, 4);
    assert.equal(f.seen.length, 4);
  },
);
