import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Store } from "../src/runtime.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const literal = (value) => ({ literal: value });
const gate = (left, right, steps) => ({
  id: "gate",
  type: "if",
  condition: { left, op: "eq", right },
  steps,
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "plan-if-mcp-"));
  const app = await createApp({ root, port: 0 });
  const clients = [],
    seen = [];
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(req.url === "/failure" ? 401 : 200, {
      "content-type": "application/json",
    });
    res.end('{"private":"owned-secret-marker-not-a-real-secret"}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => app.server.close(resolve)),
      new Promise((resolve) => peer.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const allowed = await app.store.create("IF SDK allowed");
  const denied = await app.store.create("IF SDK denied");
  denied.globalVariables = { foreignOnly: 1 };
  await app.store.save(denied);
  const owner = async (route, body, method = "POST") => {
    const response = await fetch(app.url + "/api/" + route, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const configure = async (options = {}) => {
    const response = await owner("mcp/config", {
      enabled: true,
      projects: [allowed.id],
      write: true,
      execute: true,
      remember: false,
      ...options,
    });
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return response.value;
  };
  const connect = async (transport = "http", options = {}) => {
    const client = new Client({
      name: "canonical-if-fixture",
      version: "1.0.0",
    });
    clients.push(client);
    if (transport === "http") {
      const config = await configure(options);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
        { timeout: 5000 },
      );
    } else {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            path.resolve(import.meta.dirname, "../src/mcp.mjs"),
            "--project",
            allowed.id,
            ...(options.write === false ? [] : ["--write"]),
            ...(options.execute === false ? [] : ["--execute"]),
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        }),
        { timeout: 5000 },
      );
    }
    return client;
  };
  const call = (client, name, args) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
  const leaf = (id, target = "/must-not-run") => ({
    id,
    request: {
      name: id,
      method: "GET",
      url: `http://127.0.0.1:${peer.address().port}${target}`,
    },
  });
  const save = async (client, id, steps, options = {}) =>
    decode(
      await call(client, "localapi_save_plan", {
        projectId: allowed.id,
        plan: {
          id,
          name: id,
          failurePolicy: "stop",
          ...options,
          environmentId: allowed.environments[0].id,
          steps,
        },
      }),
    );
  const activity = async (planId) => {
    const config = await owner("mcp/config", undefined, "GET");
    assert.equal(config.status, 200);
    const found = config.value.activities.find(
      (entry) =>
        entry.tool === "localapi_run_plan" &&
        entry.projectId === allowed.id &&
        entry.planId === planId,
    );
    assert.ok(found, JSON.stringify(config.value.activities));
    return found;
  };
  return {
    root,
    app,
    allowed,
    denied,
    seen,
    owner,
    connect,
    call,
    leaf,
    save,
    activity,
  };
}

function checkStop(run) {
  assert.equal(run.status, "failed");
  assert.equal(run.recordSaved, true, JSON.stringify(run.persistenceError));
  assert.equal(run.recordId, run.id);
  assert.equal(run.snapshot.failurePolicy, "stop");
  assert.equal(run.stopReason, "step-failure");
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["earlier", "failed"],
  );
  assert.equal(run.results[0].status, "passed");
  assert.equal(run.results[1].status, "failed");
  assert.equal(run.results[1].response.status, 401);
  assert.deepEqual(run.failureStop, {
    stepId: "failed",
    repeat: run.results[1].repeat,
  });
  assert.equal(typeof run.failureStop.repeat.occurrenceId, "string");
}
function nestedSteps(f) {
  return [
    f.leaf("earlier", "/effect"),
    {
      id: "outer",
      type: "repeat",
      count: 2,
      steps: [
        gate(literal(true), literal(true), [
          {
            id: "inner",
            type: "repeat",
            count: 2,
            steps: [f.leaf("failed", "/failure"), f.leaf("inner-tail")],
          },
        ]),
      ],
    },
    f.leaf("tail"),
  ];
}

for (const transport of ["http", "stdio"]) {
  test(
    `official SDK ${transport} saves stop policy, preserves evidence and enforces read/write/execute project grants`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t),
        client = await f.connect(transport);
      const plan = await f.save(client, "stopped", nestedSteps(f));
      assert.equal(plan.failurePolicy, "stop");
      const deniedBefore = await f.app.store.get(f.denied.id);
      for (const [name, args] of [
        ["localapi_save_plan", { projectId: f.denied.id, plan }],
        ["localapi_run_plan", { projectId: f.denied.id, planId: plan.id }],
        [
          "localapi_get_execution_flow",
          { projectId: f.denied.id, planId: plan.id },
        ],
        [
          "localapi_execute_flow",
          {
            projectId: f.allowed.id,
            planId: plan.id,
            environmentId: f.denied.environments[0].id,
          },
        ],
      ])
        assert.equal((await f.call(client, name, args)).isError, true);
      assert.deepEqual(f.seen, []);
      const run = decode(
        await f.call(client, "localapi_run_plan", {
          projectId: f.allowed.id,
          planId: plan.id,
        }),
      );
      checkStop(run);
      assert.deepEqual(f.seen, ["/effect", "/failure"]);
      const detail = decode(
        await f.call(client, "localapi_get_execution_result", {
          projectId: f.allowed.id,
          runId: run.id,
        }),
      );
      assert.deepEqual(detail.failureStop, run.failureStop);
      assert.deepEqual(detail.snapshot, run.snapshot);
      assert.deepEqual(detail.results, run.results);
      // Root's chunk consumer must retain the complete stored policy evidence,
      // not only the small inline SDK summary. Pin every continuation to bytes.
      const stored = (await f.app.store.get(f.allowed.id)).runs.find(
        (row) => row.id === run.id,
      );
      const expectedBytes = Buffer.from(JSON.stringify(stored));
      const expectedSha256 = createHash("sha256")
        .update(expectedBytes)
        .digest("hex");
      const chunks = [];
      for (let offsetBytes = 0; offsetBytes < expectedBytes.length; ) {
        const chunk = decode(
          await f.call(client, "localapi_get_execution_result_chunk", {
            projectId: f.allowed.id,
            runId: run.id,
            offsetBytes,
            maxBytes: 257,
            ...(offsetBytes ? { expectedSha256 } : {}),
          }),
        );
        assert.equal(chunk.sha256, expectedSha256);
        assert.equal(chunk.totalBytes, expectedBytes.length);
        const bytes = Buffer.from(chunk.data, "base64");
        assert.equal(chunk.chunkBytes, bytes.length);
        assert.ok(bytes.length > 0 && bytes.length <= 257);
        assert.equal(chunk.nextOffsetBytes, offsetBytes + bytes.length);
        assert.equal(chunk.eof, chunk.nextOffsetBytes === expectedBytes.length);
        chunks.push(bytes);
        offsetBytes = chunk.nextOffsetBytes;
      }
      assert.deepEqual(Buffer.concat(chunks), expectedBytes);
      const complete = JSON.parse(Buffer.concat(chunks));
      assert.deepEqual(complete.failureStop, run.failureStop);
      assert.equal(complete.planHash, run.planHash);
      const deniedChunk = await f.call(
        client,
        "localapi_get_execution_result_chunk",
        {
          projectId: f.denied.id,
          runId: run.id,
          offsetBytes: 0,
        },
      );
      assert.equal(deniedChunk.isError, true);
      assert.match(deniedChunk.content[0].text, /项目未授权/);
      assert.deepEqual(f.seen, ["/effect", "/failure"]);
      const summaries = decode(
        await f.call(client, "localapi_list_execution_runs", {
          projectId: f.allowed.id,
          planId: plan.id,
        }),
      );
      const summary = summaries.find((r) => r.id === run.id);
      assert.equal(summary.stopReason, "step-failure");
      assert.deepEqual(summary.failureStop, run.failureStop);
      for (const [name, args] of [
        [
          "apipost_get_execution_flow",
          { project_id: f.allowed.id, flow_id: plan.id },
        ],
        [
          "apipost_get_execution_result",
          { project_id: f.allowed.id, run_id: run.id },
        ],
        ["apipost_list_execution_runs", { project_id: f.allowed.id }],
      ])
        assert.equal((await f.call(client, name, args)).isError, true);
      // A linear stop definition isolates policy rejection from IF/repeat rejection.
      const linear = await f.save(client, "linear-stop", [
        f.leaf("ok", "/linear"),
      ]);
      assert.equal(
        (
          await f.call(client, "apipost_get_execution_flow", {
            project_id: f.allowed.id,
            flow_id: linear.id,
          })
        ).isError,
        true,
      );
      const linearRun = decode(
        await f.call(client, "localapi_run_plan", {
          projectId: f.allowed.id,
          planId: linear.id,
        }),
      );
      assert.equal(linearRun.status, "passed");
      assert.equal(
        (
          await f.call(client, "apipost_get_execution_result", {
            project_id: f.allowed.id,
            run_id: linearRun.id,
          })
        ).isError,
        true,
      );
      const readonly = await f.connect(transport, {
        write: false,
        execute: false,
      });
      const before = await f.app.store.get(f.allowed.id);
      const listed = (await readonly.listTools()).tools;
      assert.equal(
        listed.some((tool) =>
          [
            "localapi_save_plan",
            "localapi_run_plan",
            "localapi_execute_flow",
          ].includes(tool.name),
        ),
        false,
      );
      for (const [name, args] of [
        ["localapi_save_plan", { projectId: f.allowed.id, plan }],
        ["localapi_run_plan", { projectId: f.allowed.id, planId: plan.id }],
      ])
        assert.equal((await f.call(readonly, name, args)).isError, true);
      assert.deepEqual(
        decode(
          await f.call(readonly, "localapi_get_execution_result", {
            projectId: f.allowed.id,
            runId: run.id,
          }),
        ).failureStop,
        run.failureStop,
      );
      assert.equal(
        (
          await f.call(readonly, "localapi_get_execution_result", {
            projectId: f.denied.id,
            runId: run.id,
          })
        ).isError,
        true,
      );
      assert.deepEqual(await f.app.store.get(f.allowed.id), before);
      assert.deepEqual(await f.app.store.get(f.denied.id), deniedBefore);
      assert.deepEqual(f.seen, ["/effect", "/failure", "/linear"]);
    },
  );
}

async function invokeCLI(t, f, planId, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/run-plan.mjs",
        "--project",
        f.allowed.id,
        "--plan",
        planId,
        "--output",
        output,
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, LOCAL_API_DATA: f.root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    const timer = setTimeout(() => {
      failure = Error("CLI timeout");
      child.kill("SIGKILL");
    }, 8000);
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, signal, stdout, stderr });
    });
  });
}

test(
  "real CLI child returns failed stop evidence, preserves prior effects, writes output and reopens unchanged frozen history",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      sdk = await f.connect();
    const plan = await f.save(sdk, "cli-stop", nestedSteps(f));
    const deniedBefore = await f.app.store.get(f.denied.id);
    const output = path.join(f.root, "cli-stop-evidence.json");
    const result = await invokeCLI(t, f, plan.id, output);
    assert.equal(result.code, 1, result.stderr + result.stdout);
    assert.equal(result.signal, null);
    const run = JSON.parse(result.stdout);
    checkStop(run);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), run);
    const reopened = await new Store(f.root).get(f.allowed.id);
    const record = reopened.runs.find((r) => r.id === run.id);
    assert.equal(record.source, "cli");
    assert.deepEqual(record.failureStop, run.failureStop);
    assert.deepEqual(record.results, run.results);
    assert.deepEqual(record.snapshot, plan);
    assert.deepEqual(f.seen, ["/effect", "/failure"]);
    // Explicit continue updates the frozen definition, not the previous run.
    const continued = await f.save(sdk, plan.id, plan.steps, {
      failurePolicy: "continue",
    });
    assert.equal(Object.hasOwn(continued, "failurePolicy"), false);
    const next = await invokeCLI(t, f, plan.id, output);
    assert.equal(next.code, 1, next.stderr + next.stdout);
    const nextRun = JSON.parse(next.stdout);
    assert.equal(nextRun.results.length, 10);
    assert.equal(nextRun.stopReason, undefined);
    assert.notEqual(nextRun.planHash, run.planHash);
    const after = await new Store(f.root).get(f.allowed.id);
    assert.deepEqual(
      after.runs.find((r) => r.id === run.id),
      record,
    );
    assert.deepEqual(await f.app.store.get(f.denied.id), deniedBefore);
  },
);
