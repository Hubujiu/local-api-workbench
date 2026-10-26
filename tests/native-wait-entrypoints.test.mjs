// Integration acceptance for native wait + assert/pick + MCP cancellation/CLI.
// Independently authored fixtures, not an original-runtime parity claim.
// /waiting is an intentional script HTTP effect; cancellation cannot undo it.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const main = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const script = (id, data) => ({
  type: "customScript",
  id,
  name: id,
  enabled: 1,
  data,
});
const nativeWait = (id, data, enabled = 1) => ({
  type: "wait",
  id,
  name: id,
  enabled,
  data,
});
const pick = {
  type: "pickVars",
  id: "pick",
  name: "Pick token",
  enabled: 1,
  data: {
    source: "responseJson",
    variables: [{ name: "token", expression: "$.token", type: "envVars" }],
  },
};
const nativeAssert = {
  type: "assert",
  id: "status",
  name: "Native status",
  enabled: 1,
  data: {
    type: "responseCode",
    expression: { path: "", compareType: "eq", compareValue: "200" },
  },
};
async function waitFor(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error(message);
}
function decode(response) {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
}
const call = (project) => ({
  name: "localapi_execute_flow",
  arguments: {
    projectId: project.id,
    planId: project.plans[0].id,
    environmentId: project.environments[0].id,
  },
});
function sourceFor(base, label) {
  const source = modernApipostFixture();
  source.global.envs = [];
  source.global.servers = [];
  source.global.global_vars = {};
  source.global.global_param.pre_tasks = [
    script("project", 'const order=["project"];'),
    nativeWait("project-wait", 20),
  ];
  source.apis[0].request.pre_tasks = [
    script("folder", 'order.push("folder");'),
    nativeWait("folder-wait", 20),
  ];
  const api = source.apis[1];
  api.url = `${base}/main/${label}`;
  api.request.query.parameter = [];
  api.request.header.parameter = [];
  api.request.pre_tasks = [
    nativeWait("zero", 0),
    nativeWait("disabled", "{{inert-wait}}", -1),
    script(
      "before",
      'order.push("request");apt.setRequestHeader("x-order",order.join(","));pm.environment.set("beforeProof",order.join(","));',
    ),
  ];
  api.request.post_tasks = [
    script("post-prefix", 'const prefix="post:";'),
    nativeWait("post-wait", 40),
    nativeAssert,
    pick,
    script(
      "post-done",
      'pm.environment.set("postProof",prefix+pm.environment.get("token"));',
    ),
  ];
  return source;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "native-wait-entry-")),
    data = path.join(root, "data"),
    events = [],
    clients = [],
    children = [];
  const upstream = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    events.push({
      path: url.pathname,
      finished: url.searchParams.get("finished"),
      authorization: request.headers.authorization,
      order: request.headers["x-order"],
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ token: "token-" + url.pathname.split("/").at(-1) }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root: data, port: 0 });
  const closeApp = async () => {
    for (const client of clients.splice(0))
      await client.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await closeApp();
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        await Promise.race([exited.catch(() => {}), delay(1000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await exited.catch(() => {});
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const args = (projects) => [
    main,
    ...projects.flatMap((project) => ["--project", project.id]),
    "--write",
    "--execute",
  ];
  const connect = async (transport) => {
    const client = new Client({ name: "native-wait-entry", version: "1" });
    clients.push(client);
    const errors = [];
    client.onerror = (error) => errors.push(error.message);
    let stderr = "";
    transport.stderr?.on("data", (bytes) => {
      stderr = (stderr + bytes).slice(-16000);
    });
    await client.connect(transport);
    return { client, errors, stderr: () => stderr };
  };
  return {
    root,
    data,
    events,
    base: `http://127.0.0.1:${upstream.address().port}`,
    get app() {
      return app;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root: data, port: 0 });
    },
    async http(projects) {
      const response = await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify({
          enabled: true,
          projects: projects.map((project) => project.id),
          write: true,
          execute: true,
          remember: false,
        }),
      });
      assert.equal(response.status, 200);
      const config = await response.json();
      return connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
      );
    },
    stdio: (projects) =>
      connect(
        new StdioClientTransport({
          command: process.execPath,
          args: args(projects),
          env: { LOCAL_API_DATA: data },
          stderr: "pipe",
        }),
      ),
    raw(projects) {
      const child = spawn(process.execPath, args(projects), {
        env: {
          LOCAL_API_DATA: data,
          ...(process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
        if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) child.kill();
      });
      child.stderr.on("data", (bytes) => {
        stderr = (stderr + bytes).slice(-16000);
      });
      child.stdin.on("error", () => {});
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      exited.catch(() => {});
      children.push({ child, exited });
      return { child, exited, stdout: () => stdout, stderr: () => stderr };
    },
  };
}
async function projectFor(f, label, cancelPhase) {
  const project = await f.app.store.create(label),
    source = sourceFor(f.base, label);
  if (cancelPhase) {
    const tasks = [
      script(
        "wait-marker",
        `let finished=false;pm.environment.set("pending","must-not-commit");setTimeout(()=>pm.sendRequest(${JSON.stringify(`${f.base}/waiting/${label}`)}+"?finished="+finished,()=>{}),50);`,
      ),
      nativeWait("cancel-wait", 1000),
      script(
        "wait-finished",
        'finished=true;pm.environment.set("afterWait","must-not-commit");',
      ),
    ];
    if (cancelPhase === "before") {
      // Keep the active pre phase within its exact 1000ms aggregate wait bound.
      source.global.global_param.pre_tasks = [];
      source.apis[0].request.pre_tasks = [];
      source.apis[1].request.pre_tasks = tasks;
      // Global cancellation must stop a wait-only plan too, without pick policy.
      source.apis[1].request.post_tasks = [];
    } else source.apis[1].request.post_tasks = [...tasks, nativeAssert, pick];
  }
  const original = structuredClone(source);
  importIntoProject(project, source);
  assert.deepEqual(source, original);
  project.environments[0].variables.token = "stale";
  project.plans = [
    snapshotPlan({
      id: "wait-flow",
      name: "Native waits",
      steps: [
        { request: project.requests[0] },
        {
          request: {
            method: "GET",
            url: `${f.base}/later/${label}`,
            auth: { type: "bearer", token: "{{token}}" },
          },
        },
      ],
    }),
  ];
  await f.app.store.save(project);
  return project;
}
async function savedCancelled(f, project, phase, oldIds, stdio) {
  let saved, run;
  await waitFor(async () => {
    saved = await new Store(f.data).get(project.id);
    run = saved.runs.find(
      (item) => item.status === "cancelled" && !oldIds.has(item.id),
    );
    return !!run;
  }, "cancelled native wait record was not persisted");
  assert.equal(run.results.length, 1);
  const record = run.results[0],
    vars = saved.environments[0].variables;
  assert.equal(vars.token, "stale");
  assert.equal(vars.pending, undefined);
  assert.equal(vars.afterWait, undefined);
  assert.equal(vars.postProof, undefined);
  assert.equal(
    vars.beforeProof,
    phase === "after" ? "project,folder,request" : undefined,
  );
  if (phase === "after") {
    assert.equal(record.response.status, 200);
    assert.equal(
      JSON.parse(record.response.body).token,
      "token-" + project.name,
    );
  } else assert.equal(record.response, undefined);
  const own = f.events.filter((event) =>
    event.path.endsWith("/" + project.name),
  );
  assert.equal(
    own.filter((event) => event.path.startsWith("/waiting/")).length,
    1,
  );
  assert.equal(
    own.some((event) => event.path.startsWith("/main/")),
    phase === "after",
  );
  assert.equal(
    own.some((event) => event.path.startsWith("/later/")),
    false,
  );
  if (stdio)
    await waitFor(
      async () =>
        (await readMCPActivities(f.data)).some(
          (item) =>
            item.projectId === project.id &&
            item.status === "cancelled" &&
            item.recordSaved === true,
        ),
      "stdio activity does not confirm saved cancellation",
    );
  return run;
}
function begin(entry, project) {
  const controller = new AbortController();
  let settled = false;
  const pending = entry.client.callTool(call(project), undefined, {
    signal: controller.signal,
  });
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { controller, pending, settled: () => settled };
}
async function observeWait(f, project, settled) {
  await waitFor(() => {
    if (settled?.())
      throw Error(
        "execution settled before the wait marker; cancellation is not being tested",
      );
    return f.events.some((event) => event.path === "/waiting/" + project.name);
  }, "timer marker was not observed during native wait");
  const event = f.events.find(
    (item) => item.path === "/waiting/" + project.name,
  );
  assert.equal(
    event.finished,
    "false",
    "marker must run while the native wait is pending, not after skipped/completed wait",
  );
}
async function independentRun(f, entry, project) {
  const result = decode(await entry.client.callTool(call(project)));
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.recordSaved, true);
  const saved = await new Store(f.data).get(project.id);
  assert.equal(
    saved.environments[0].variables.postProof,
    "post:token-" + project.name,
  );
  return result;
}
for (const transport of ["http", "stdio"])
  for (const phase of ["before", "after"])
    test(
      `native wait: actual SDK ${transport} cancellation during ${phase} phase preserves only committed state`,
      { timeout: 20000 },
      async (t) => {
        const f = await fixture(t),
          project = await projectFor(f, `${transport}-${phase}`, phase),
          other = await projectFor(f, "independent"),
          httpEntry = await f.http([project, other]);
        const entry =
          transport === "http" ? httpEntry : await f.stdio([project]);
        const oldIds = new Set(
          (await new Store(f.data).get(project.id)).runs.map((item) => item.id),
        );
        const active = begin(entry, project);
        await observeWait(f, project, active.settled);
        const independent = independentRun(f, httpEntry, other);
        independent.catch(() => {});
        const rejected = assert.rejects(active.pending, /abort|cancel/i);
        active.controller.abort();
        await rejected;
        const run = await savedCancelled(
          f,
          project,
          phase,
          oldIds,
          transport === "stdio",
        );
        await independent;
        await entry.client.ping();
        assert.equal(
          entry.errors.some((message) => /unknown.*id/i.test(message)),
          false,
        );
        const count = f.events.length;
        await f.restart();
        assert.equal(f.events.length, count);
        assert.equal(
          (await new Store(f.data).get(project.id)).runs.find(
            (item) => item.id === run.id,
          ).status,
          "cancelled",
        );
      },
    );
for (const phase of ["before", "after"])
  test(
    `native wait: actual stdio EOF during ${phase} phase saves cancelled flow before clean child exit`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t),
        project = await projectFor(f, `eof-${phase}`, phase),
        other = await projectFor(f, "independent"),
        httpEntry = await f.http([other]),
        child = f.raw([project]);
      const oldIds = new Set(
        (await new Store(f.data).get(project.id)).runs.map((item) => item.id),
      );
      child.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {},
        }) + "\n",
      );
      await waitFor(
        () => child.stdout().includes("\n"),
        "stdio initialization missing",
      );
      child.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: call(project),
        }) + "\n",
      );
      await observeWait(
        f,
        project,
        () => child.child.exitCode !== null || child.child.signalCode !== null,
      );
      const independent = independentRun(f, httpEntry, other);
      independent.catch(() => {});
      child.child.stdin.end();
      await waitFor(
        () => child.child.exitCode !== null || child.child.signalCode !== null,
        "EOF child did not exit",
        5000,
      );
      assert.deepEqual(
        await child.exited,
        { code: 0, signal: null },
        child.stderr(),
      );
      const responses = child
        .stdout()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((message) => message.id === 1);
      assert.equal(responses.length, 1, child.stdout());
      const output = decode(responses[0].result);
      assert.equal(output.status, "cancelled");
      assert.equal(output.recordSaved, true);
      const run = await savedCancelled(f, project, phase, oldIds, true);
      assert.equal(run.id, output.id);
      await independent;
      const count = f.events.length;
      await f.restart();
      assert.equal(f.events.length, count);
      assert.equal(
        (await new Store(f.data).get(project.id)).runs.find(
          (item) => item.id === run.id,
        ).status,
        "cancelled",
      );
    },
  );
function cli(f, project) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/run-plan.mjs",
        "--project",
        project.id,
        "--plan",
        project.plans[0].id,
        "--environment",
        project.environments[0].id,
        "--database-stdin",
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, LOCAL_API_DATA: f.data },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    const timer = setTimeout(() => {
      failure = Error("native wait CLI fixture exceeded 15s");
      child.kill();
    }, 15000);
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        failure = Error("CLI output exceeds fixture bound");
        child.kill();
      }
    });
    child.stderr.on("data", (bytes) => {
      stderr = (stderr + bytes).slice(-16000);
    });
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      failure ? reject(failure) : resolve({ code, signal, stdout, stderr });
    });
    // Explicit empty mapping exercises the closed CLI collector without granting a DB.
    child.stdin.end(JSON.stringify({ databaseConnections: {} }));
  });
}
test(
  "native wait: true CLI ordered import, explicit empty grants, frozen edits and backup/restored restart",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      project = await projectFor(f, "cli-success");
    const frozen = structuredClone(
      project.plans[0].steps[0].request.nativeTasks,
    );
    project.requests[0].nativeTasks.before.find(
      (task) => task.type === "wait",
    ).data = 0;
    await f.app.store.save(project);
    const execute = async (target) => {
      const start = f.events.length,
        output = await cli(f, target);
      assert.equal(output.code, 0, output.stdout + output.stderr);
      assert.equal(output.signal, null);
      const run = JSON.parse(output.stdout);
      assert.equal(run.status, "passed", JSON.stringify(run.results));
      assert.equal(run.recordSaved, true);
      assert.deepEqual(
        f.events.slice(start).map((event) => event.path),
        ["/main/cli-success", "/later/cli-success"],
      );
      assert.equal(f.events[start].order, "project,folder,request");
      assert.equal(f.events.at(-1).authorization, "Bearer token-cli-success");
      assert.equal(
        run.results[0].assertions.find((item) => item.name === "Native status")
          ?.passed,
        true,
      );
      assert.deepEqual(run.snapshot.steps[0].request.nativeTasks, frozen);
      const saved = await new Store(f.data).get(target.id),
        vars = saved.environments[0].variables;
      assert.equal(vars.beforeProof, "project,folder,request");
      assert.equal(vars.postProof, "post:token-cli-success");
      assert.equal(saved.runs.find((item) => item.id === run.id).source, "cli");
      assert.equal(
        JSON.stringify(saved).includes('"databaseConnections"'),
        false,
      );
      return run;
    };
    const run = await execute(project);
    const exported = await fetch(
      `${f.app.url}/api/projects/${project.id}/export`,
      { headers: { "x-local-token": f.app.token } },
    );
    assert.equal(exported.status, 200);
    const document = await exported.json();
    const restoredResponse = await fetch(f.app.url + "/api/restore", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": f.app.token,
      },
      body: JSON.stringify({ document }),
    });
    assert.equal(
      restoredResponse.status,
      201,
      await restoredResponse.clone().text(),
    );
    const restored = await restoredResponse.json();
    const count = f.events.length;
    await f.restart();
    assert.equal(f.events.length, count);
    assert.equal(
      (await new Store(f.data).get(restored.id)).runs.find(
        (item) => item.id === run.id,
      ).status,
      "passed",
    );
    await execute(restored);

    // In contrast, an ordinary wait-only script error retains legacy continuation.
    const ordinary = await f.app.store.create("CLI ordinary wait failure");
    ordinary.plans = [
      snapshotPlan({
        id: "ordinary",
        steps: [
          {
            request: {
              url: f.base + "/main/ordinary",
              inheritSharedScripts: false,
              nativeTasks: {
                version: 1,
                before: [
                  nativeWait("ordinary-wait", 20),
                  script(
                    "ordinary-error",
                    'throw Error("ordinary wait failure");',
                  ),
                ],
                after: [],
              },
            },
          },
          { request: { url: f.base + "/later/ordinary" } },
        ],
      }),
    ];
    await f.app.store.save(ordinary);
    const ordinaryStart = f.events.length,
      ordinaryOutput = await cli(f, ordinary);
    assert.equal(
      ordinaryOutput.code,
      1,
      ordinaryOutput.stdout + ordinaryOutput.stderr,
    );
    assert.equal(ordinaryOutput.signal, null);
    const ordinaryRun = JSON.parse(ordinaryOutput.stdout);
    assert.equal(ordinaryRun.status, "failed");
    assert.equal(ordinaryRun.recordSaved, true);
    assert.deepEqual(
      ordinaryRun.results.map((item) => item.status),
      ["failed", "passed"],
    );
    assert.match(ordinaryRun.results[0].error, /ordinary wait failure/);
    assert.deepEqual(
      f.events.slice(ordinaryStart).map((event) => event.path),
      ["/later/ordinary"],
    );
    assert.equal(
      (await new Store(f.data).get(ordinary.id)).runs.find(
        (item) => item.id === ordinaryRun.id,
      ).status,
      "failed",
    );
  },
);
