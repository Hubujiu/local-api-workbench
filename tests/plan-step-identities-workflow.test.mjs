import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import {
  runPlan,
  normalizeRequest,
  snapshotPlan,
  restoreProject,
} from "../src/core.mjs";
import { versionPlan } from "../src/plan-version.mjs";
import { executeRequest } from "../src/runtime.mjs";
const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const identityError = /步骤ID无效或重复/;
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function files(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.endsWith(".lock")) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory())
      for (const [name, bytes] of Object.entries(await files(file)))
        result[entry.name + "/" + name] = bytes;
    else result[entry.name] = (await readFile(file)).toString("base64");
  }
  return result;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "linear-plan-identity-"));
  let app = await createApp({ root, port: 0 });
  const seen = [],
    clients = [];
  const peer = http.createServer((req, res) => {
    seen.push({ url: req.url, frozen: req.headers["x-frozen"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const close = async () => {
    await Promise.all(
      clients.splice(0).map((client) => client.close().catch(() => {})),
    );
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await close();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const request = normalizeRequest({
    id: "api",
    name: "same target",
    url: `http://127.0.0.1:${peer.address().port}/same`,
    headers: [{ key: "X-Frozen", value: "original" }],
  });
  const p = await app.store.create("linear identities");
  p.requests = [request];
  await app.store.save(p);
  const other = await app.store.create("other project");
  const call = async (route, value, method = "POST") => {
    const response = await fetch(app.url + "/api/" + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(value) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const sdk = async (transport, projectId = p.id) => {
    const client = new Client({
      name: "linear-plan-identities",
      version: "1.0",
    });
    clients.push(client);
    if (transport === "http") {
      const configuration = await call("mcp/config", {
        enabled: true,
        projects: [projectId],
        write: true,
        execute: true,
        remember: false,
      });
      assert.equal(configuration.status, 200);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: {
            headers: { Authorization: "Bearer " + configuration.value.token },
          },
        }),
      );
    } else {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            path.join(repo, "src/mcp.mjs"),
            "--project",
            projectId,
            "--write",
            "--execute",
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        }),
      );
    }
    assert(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "localapi_save_plan",
      ),
    );
    return (name, args) =>
      client.callTool({ name, arguments: { projectId, ...args } });
  };
  const cli = (projectId, planId) =>
    exec(
      process.execPath,
      [
        path.join(repo, "scripts/run-plan.mjs"),
        "--project",
        projectId,
        "--plan",
        planId,
      ],
      {
        cwd: repo,
        env: { ...process.env, LOCAL_API_DATA: root },
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  return {
    root,
    p,
    other,
    request,
    seen,
    call,
    sdk,
    cli,
    get app() {
      return app;
    },
    restart: async () => {
      await close();
      app = await createApp({ root, port: 0 });
    },
  };
}

test(
  "ordinary plan identities survive owner SDK HTTP/stdio CLI frozen execution, full save, results and backup restart",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const created = await f.call(`projects/${f.p.id}/plans`, {
      name: "same target is allowed",
      steps: [
        { id: "toString", request: f.request },
        { id: "hasOwnProperty", request: f.request },
        { request: f.request },
        { id: "", enabled: false, request: f.request },
      ],
    });
    assert.equal(created.status, 200);
    let plan = created.value;
    const ids = plan.steps.map((step) => step.id);
    assert.equal(new Set(ids).size, 4);
    assert(ids.every((id) => typeof id === "string" && id.length > 0));
    assert.deepEqual(ids.slice(0, 2), ["toString", "hasOwnProperty"]);
    // A legacy plan can have no per-step attribution. Prototype names are IDs,
    // not inherited attribution functions when an unrelated field changes.
    let p = await f.app.store.get(f.p.id);
    p.plans[0].provenance = { fields: {}, steps: {} };
    await f.app.store.save(p);
    const httpCall = await f.sdk("http");
    plan = decode(
      await httpCall("localapi_update_execution_flow", {
        plan: { ...p.plans[0], description: "field-only edit" },
      }),
    );
    for (const id of ids) assert.equal(plan.provenance.steps[id], "manual");
    assert.deepEqual(versionPlan(plan, plan), plan);
    p = await f.app.store.get(f.p.id);
    const fullSave = await f.call(`projects/${p.id}`, p, "PUT");
    assert.equal(fullSave.status, 200);
    assert.deepEqual(
      fullSave.value.plans[0].steps.map((step) => step.id),
      ids,
    );
    const frozen = structuredClone(fullSave.value.plans[0]);
    const runs = [];
    const check = (run) => {
      assert.equal(run.status, "passed");
      assert.equal(run.recordSaved, true);
      assert.deepEqual(run.snapshot, frozen);
      assert.deepEqual(
        run.results.map((step) => step.stepId),
        ids.slice(0, 3),
      );
      if (runs.length) assert.equal(run.planHash, runs[0].planHash);
      runs.push(run);
    };
    check((await f.call(`projects/${p.id}/run`, { planId: plan.id })).value);
    p = await f.app.store.get(f.p.id);
    p.requests[0].url = p.requests[0].url.replace("/same", "/live-edited");
    p.requests[0].headers[0].value = "changed";
    await f.app.store.save(p);
    check(decode(await httpCall("localapi_run_plan", { planId: plan.id })));
    const stdioCall = await f.sdk("stdio");
    check(decode(await stdioCall("localapi_run_plan", { planId: plan.id })));
    check(JSON.parse((await f.cli(p.id, plan.id)).stdout));
    for (const run of runs) {
      const persisted = decode(
        await httpCall("localapi_get_execution_result", { runId: run.id }),
      );
      assert.deepEqual(persisted.snapshot, frozen);
      assert.deepEqual(persisted.results, run.results);
    }
    assert(
      f.seen.every((row) => row.url === "/same" && row.frozen === "original"),
    );
    assert.equal(
      (
        await httpCall("localapi_run_plan", {
          projectId: f.other.id,
          planId: plan.id,
        })
      ).isError,
      true,
    );
    const backup = (await f.call(`projects/${p.id}/export`, undefined, "GET"))
      .value;
    const restored = await f.call("restore", { document: backup });
    assert.equal(restored.status, 201);
    await f.restart();
    check(
      (await f.call(`projects/${restored.value.id}/run`, { planId: plan.id }))
        .value,
    );
    const restartedSDK = await f.sdk("stdio", restored.value.id);
    const prior = decode(
      await restartedSDK("localapi_get_execution_result", {
        runId: runs[0].id,
      }),
    );
    assert.deepEqual(prior.results, runs[0].results);
    assert.deepEqual(prior.snapshot, frozen);
    assert.equal(f.seen.length, 15);
    assert.deepEqual((await f.app.store.get(f.other.id)).plans, []);
    // The direct raw API still allocates its first identities only in its clone.
    const raw = {
      name: "raw",
      steps: [{ request: f.request }, { id: "", request: f.request }],
    };
    const before = structuredClone(raw);
    const rawRun = await runPlan(raw, {}, executeRequest);
    assert.equal(rawRun.status, "passed");
    assert.equal(new Set(rawRun.results.map((step) => step.stepId)).size, 2);
    assert(
      rawRun.results.every(
        (step) => typeof step.stepId === "string" && step.stepId,
      ),
    );
    assert.deepEqual(raw, before);
  },
);

test(
  "invalid ordinary identities reject whole owner MCP save restore and execution batches without rewriting historical evidence",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const created = await f.call(`projects/${f.p.id}/plans`, {
      name: "valid",
      steps: [
        { id: "one", request: f.request },
        { id: "two", request: f.request },
      ],
    });
    assert.equal(created.status, 200);
    const plan = created.value;
    const httpCall = await f.sdk("http"),
      stdioCall = await f.sdk("stdio");
    const directory = f.app.store.directory(f.p.id);
    const baseline = await files(directory);
    const bad = (id = "one") => ({
      ...plan,
      steps: [{ ...plan.steps[0] }, { ...plan.steps[1], id, enabled: false }],
    });
    for (const id of [
      "one",
      null,
      false,
      0,
      7,
      {},
      [],
      "__proto__",
      "constructor",
      "prototype",
      "x".repeat(201),
      "\ud800",
    ]) {
      const input = bad(id),
        before = structuredClone(input);
      const response = await f.call(`projects/${f.p.id}/plans`, input);
      assert.equal(response.status, 400);
      assert.match(response.value.error, identityError);
      assert.deepEqual(input, before);
    }
    for (const call of [httpCall, stdioCall])
      for (const name of [
        "localapi_save_plan",
        "localapi_update_execution_flow",
        "localapi_create_execution_flow",
      ]) {
        const input = bad();
        if (name === "localapi_create_execution_flow") delete input.id;
        const response = await call(name, { plan: input });
        assert.equal(response.isError, true);
        assert.match(response.content[0].text, identityError);
      }
    const current = await f.app.store.get(f.p.id);
    const mixed = {
      ...structuredClone(current),
      plans: [
        { name: "new missing identities", steps: [{ request: f.request }] },
        bad(),
      ],
    };
    const beforeMixed = structuredClone(mixed);
    await assert.rejects(f.app.store.save(mixed), identityError);
    assert.deepEqual(mixed, beforeMixed);
    const fullSave = await f.call(
      `projects/${f.p.id}`,
      { ...current, plans: [bad()] },
      "PUT",
    );
    assert.equal(fullSave.status, 400);
    assert.match(fullSave.value.error, identityError);
    const beforeProjects = await f.app.store.list();
    const restoreInput = { ...current, plans: [bad()] };
    const beforeRestore = structuredClone(restoreInput);
    assert.throws(() => restoreProject(restoreInput), identityError);
    assert.deepEqual(restoreInput, beforeRestore);
    const restoreResponse = await f.call("restore", { document: restoreInput });
    assert.equal(restoreResponse.status, 400);
    assert.match(restoreResponse.value.error, identityError);
    assert.deepEqual(await f.app.store.list(), beforeProjects);
    assert.throws(() => versionPlan(bad(), plan), identityError);
    assert.throws(() => snapshotPlan(bad()), identityError);
    let sends = 0;
    await assert.rejects(
      runPlan(bad(), {}, async () => {
        sends++;
      }),
      identityError,
    );
    assert.equal(sends, 0);
    assert.deepEqual(await files(directory), baseline);
    assert.equal(f.seen.length, 0);
    // Simulate an old on-disk bad definition plus already recorded evidence.
    // Reads must retain both duplicate evidence identities; do not renumber them.
    const saved = (await f.call(`projects/${f.p.id}/run`, { planId: plan.id }))
      .value;
    assert.equal(saved.recordSaved, true);
    const historical = await f.app.store.get(f.p.id);
    historical.runs[0].snapshot.steps[1].id = "one";
    historical.runs[0].results[1].stepId = "one";
    await writeFile(
      path.join(directory, "history/runs.json"),
      JSON.stringify(historical.runs),
    );
    const planFile = path.join(
      directory,
      "plans",
      "key-" + Buffer.from(plan.id).toString("base64url") + ".json",
    );
    const actualPlanFile = /^[a-f0-9-]{36}$/i.test(plan.id)
      ? path.join(directory, "plans", plan.id + ".json")
      : planFile;
    await writeFile(actualPlanFile, JSON.stringify(bad()));
    const oldBytes = await files(directory),
      count = f.seen.length;
    await f.restart();
    const legacy = await f.app.store.get(f.p.id);
    assert.deepEqual(legacy.runs[0], historical.runs[0]);
    const legacySDK = await f.sdk("stdio");
    assert.deepEqual(
      decode(
        await legacySDK("localapi_get_execution_result", { runId: saved.id }),
      ),
      historical.runs[0],
    );
    const ownerRun = await f.call(`projects/${f.p.id}/run`, {
      planId: plan.id,
    });
    assert.equal(ownerRun.status, 400);
    assert.match(ownerRun.value.error, identityError);
    const rejected = await legacySDK("localapi_run_plan", { planId: plan.id });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, identityError);
    await assert.rejects(f.cli(f.p.id, plan.id), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, identityError);
      return true;
    });
    assert.equal(f.seen.length, count);
    assert.deepEqual(await files(directory), oldBytes);
    // Repair the definition explicitly, not the old evidence; backup preserves it.
    legacy.plans = [structuredClone(plan)];
    await f.app.store.save(legacy);
    const exported = (
      await f.call(`projects/${f.p.id}/export`, undefined, "GET")
    ).value;
    const restored = await f.call("restore", { document: exported });
    assert.equal(restored.status, 201);
    assert.deepEqual(restored.value.runs[0], historical.runs[0]);
  },
);
