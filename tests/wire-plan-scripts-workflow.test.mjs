// Ordinary GitHub CI only: real VM, TCP/WS/SSE, HTTP, MCP, CLI and storage fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { snapshotPlan, runPlan, restoreProject } from "../src/core.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
import { executeRequest, Store } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";

const secret = "Bearer wire-script-fixture";
async function fixture(t) {
  const sockets = new Set(),
    seen = [],
    consumed = [],
    held = Promise.withResolvers();
  const frame = Buffer.from("aa00ff0d0a", "hex"),
    tail = Buffer.from("bbcc", "hex");
  const tcp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const chunks = [];
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (bytes.at(-1) !== 10) return;
      handled = true;
      seen.push({ type: "tcp", bytes: bytes.toString("base64") });
      const command = bytes.toString();
      if (command === "frame\n") socket.write(Buffer.concat([frame, tail]));
      else if (command === "partial\n") socket.end(frame.subarray(0, -1));
      else if (command === "hold\n") {
        socket.write("observed-before-cancel");
        held.resolve();
      } else if (command === "huge\n")
        socket.end(Buffer.alloc(1024 * 1024, 120));
      else socket.end(bytes);
    });
  });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (req.url === "/consume") {
      consumed.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ received: body }));
      return;
    }
    seen.push({ type: "sse", method: req.method, body, url: req.url });
    if (req.headers.authorization !== secret || req.url === "/denied") {
      res.writeHead(403);
      res.end("denied");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      "id: observed\nevent: value\ndata: " +
        JSON.stringify(req.method === "POST" ? body : "event-value") +
        "\n\n",
    );
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== secret) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (socket) => {
    socket.on("error", () => {});
    socket.on("message", (bytes, binary) => {
      seen.push({ type: "websocket", bytes: bytes.toString("base64"), binary });
      socket.send(bytes, { binary }, (error) => {
        if (!error) socket.close(1000, "fixture complete");
      });
    });
  });
  tcp.listen(0, "127.0.0.1");
  server.listen(0, "127.0.0.1");
  await Promise.all([once(tcp, "listening"), once(server, "listening")]);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await Promise.all(
      [tcp, server].map((s) => new Promise((resolve) => s.close(resolve))),
    );
  });
  return {
    seen,
    consumed,
    held,
    frame,
    tail,
    tcp: { id: "tcp", type: "tcp", url: "127.0.0.1", port: tcp.address().port },
    websocket: {
      id: "ws",
      type: "websocket",
      url: `ws://127.0.0.1:${server.address().port}/wire`,
    },
    sse: {
      id: "sse",
      type: "sse",
      url: `http://127.0.0.1:${server.address().port}/events`,
    },
    consumer: {
      method: "POST",
      url: `http://127.0.0.1:${server.address().port}/consume`,
      bodyType: "raw",
      body: "{{reply}}",
    },
  };
}
const wireStep = (definition, message, extra = {}) => ({
  id: "wire",
  type: "protocol",
  protocol: {
    definition,
    ...(message === undefined ? {} : { message }),
    duration: 1500,
  },
  protocolScripts: {
    version: 1,
    before:
      "apt.setVar('prefix','native-value');pm.variables.set('local','phase-private');console.log('wire-before');",
    after:
      "pm.test('native',()=>{pm.expect(pm.response).to.equal(undefined);pm.expect(pm.variables.get('local')).to.equal('phase-private');pm.expect(wire.request.headers).to.equal(undefined);pm.expect(wire.request.tls).to.equal(undefined);});apt.setVar('reply',wire.protocol==='tcp'?wire.result.result.body:wire.protocol==='websocket'?wire.result.result.messages[0].data:JSON.parse(wire.result.result.events[0].data));console.log('wire-after');",
  },
  ...extra,
});
const credentials = (id = "wire") => ({
  [id]: { headers: { Authorization: secret } },
});
const noHTTP = () => {
  throw Error("unexpected HTTP consumer");
};
const decode = (response) => {
  assert.notEqual(response.result.isError, true, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
};

test("wire scripts run real TCP WebSocket and SSE PRE transport POST HTTP workflows with native evidence", async (t) => {
  const f = await fixture(t);
  for (const type of ["tcp", "websocket", "sse"]) {
    const definition = {
      ...f[type],
      templateMode: "variables",
      ...(type === "sse" ? { method: "POST", body: "{{prefix}}" } : {}),
    };
    const plan = snapshotPlan({
      statusPolicy: "strict200",
      steps: [
        wireStep(
          definition,
          type === "sse"
            ? undefined
            : "{{prefix}}" + (type === "tcp" ? "\n" : ""),
        ),
        { request: f.consumer },
      ],
    });
    const report = await runPlan(plan, {}, executeRequest, {
      executeProtocol: executeWireFlow,
      ...(type === "tcp" ? {} : { protocolCredentials: credentials() }),
    });
    assert.equal(report.status, "passed", JSON.stringify(report));
    const record = report.results[0],
      native = record.protocolResult;
    assert.equal(record.response, undefined);
    assert.equal(native.status, "completed");
    assert.equal(record.protocol.definition.templateMode, "literal");
    assert.equal(
      f.consumed.at(-1),
      type === "tcp" ? "native-value\n" : "native-value",
    );
    assert.equal(report.variables.local, undefined);
    if (type === "tcp")
      assert.equal(
        native.result.base64,
        Buffer.from("native-value\n").toString("base64"),
      );
    if (type === "websocket") {
      assert.equal(native.result.messages[0].encoding, "utf8");
      assert.equal(native.result.closeCode, 1000);
    }
    if (type === "sse") {
      assert.equal(native.result.status, 200);
      assert.equal(native.result.events[0].id, "observed");
    }
    assert.doesNotMatch(JSON.stringify(report), /Bearer wire-script-fixture/);
  }
  assert.equal(f.seen.length, 3);
  assert.equal(f.consumed.length, 3);
});

test("wire script real payload templates distinguish literal variables and absent mode without recursive expansion", async (t) => {
  const f = await fixture(t);
  for (const type of ["tcp", "websocket", "sse"])
    for (const mode of [undefined, "literal", "variables"]) {
      const configured = "{{prefix}}" + (type === "tcp" ? "\n" : "");
      const definition = {
        ...f[type],
        ...(mode === undefined ? {} : { templateMode: mode }),
        ...(type === "sse" ? { method: "POST", body: configured } : {}),
      };
      const expected =
        (mode === "literal" || (mode === undefined && type === "sse")
          ? "{{prefix}}"
          : "{{nested}}") + (type === "tcp" ? "\n" : "");
      const s = wireStep(definition, type === "sse" ? undefined : configured, {
        protocolScripts: {
          version: 1,
          before:
            "apt.setVar('prefix','{{nested}}');apt.setVar('nested','must-not-expand');",
          after: `pm.test('resolved-once',()=>pm.expect(wire.request.${type === "sse" ? "body" : "message"}).to.equal(${JSON.stringify(expected)}));`,
        },
      });
      const report = await runPlan(snapshotPlan({ steps: [s] }), {}, noHTTP, {
        executeProtocol: executeWireFlow,
        ...(type === "tcp" ? {} : { protocolCredentials: credentials() }),
      });
      assert.equal(report.status, "passed", JSON.stringify(report));
      const observed = f.seen.at(-1);
      assert.equal(
        type === "sse"
          ? observed.body
          : Buffer.from(observed.bytes, "base64").toString(),
        expected,
      );
    }
});

test("wire script binary messages retain exact TCP bytes and authoritative WebSocket base64 encoding", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("00ff410a", "hex");
  for (const type of ["tcp", "websocket"]) {
    const s = wireStep(
      f[type],
      { encoding: "hex", data: "{{hex}}" },
      {
        protocolScripts: {
          version: 1,
          before: "apt.setVar('hex','00ff410a');",
          after:
            type === "tcp"
              ? `pm.test('bytes',()=>pm.expect(wire.result.result.base64).to.equal('${bytes.toString("base64")}'));`
              : `pm.test('binary',()=>{pm.expect(wire.result.result.messages[0].encoding).to.equal('base64');pm.expect(wire.result.result.messages[0].data).to.equal('${bytes.toString("base64")}');});`,
        },
      },
    );
    const report = await runPlan(snapshotPlan({ steps: [s] }), {}, noHTTP, {
      executeProtocol: executeWireFlow,
      ...(type === "tcp" ? {} : { protocolCredentials: credentials() }),
    });
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(f.seen.at(-1).bytes, bytes.toString("base64"));
    assert.deepEqual(report.results[0].protocol.message, {
      encoding: "hex",
      data: "00ff410a",
    });
  }
});

test("wire script real delimiter completion preserves exact frame trailing bytes and partial expectations", async (t) => {
  const f = await fixture(t),
    definition = { ...f.tcp, completion: "delimiter", delimiterHex: "0d0a" };
  for (const command of ["frame", "partial"])
    for (const expectedStatus of ["completed", "partial"]) {
      const report = await runPlan(
        snapshotPlan({
          steps: [
            wireStep(definition, command + "\n", {
              expectedStatus,
              protocolScripts: {
                version: 1,
                after:
                  "console.log(wire.result.status);apt.setVar('accepted','yes');pm.test('framing-readonly',()=>pm.expect(Object.isFrozen(wire.result.result.framing)).to.equal(true));",
              },
            }),
          ],
        }),
        {},
        noHTTP,
        { executeProtocol: executeWireFlow },
      );
      const actual = command === "frame" ? "completed" : "partial",
        native = report.results[0].protocolResult;
      assert.equal(native.status, actual);
      assert.equal(
        report.status,
        actual === expectedStatus ? "passed" : "failed",
      );
      assert.equal(
        report.variables.accepted,
        actual === expectedStatus ? "yes" : undefined,
      );
      assert.equal(
        native.result.base64,
        (command === "frame" ? f.frame : f.frame.subarray(0, -1)).toString(
          "base64",
        ),
      );
      assert.equal(native.result.framing.matched, command === "frame");
      // Trailing evidence is bounded to bytes actually read with the matching chunk.
      const capturedTail = Buffer.from(
        native.result.framing.trailingBase64,
        "base64",
      );
      assert.equal(native.result.framing.trailingSize, capturedTail.length);
      assert.deepEqual(capturedTail, f.tail.subarray(0, capturedTail.length));
      assert(
        report.results[0].logs.some(
          (log) => log.phase === "after" && log.message === actual,
        ),
      );
    }
});

test("wire script SSE handshake 200 remains partial at the event limit and a failed handshake stays error-only", async (t) => {
  const f = await fixture(t);
  for (const expectedStatus of ["completed", "partial"]) {
    const s = wireStep(f.sse, undefined, {
      protocol: { definition: f.sse, maxEvents: 1, duration: 1500 },
      expectedStatus,
      protocolScripts: {
        version: 1,
        after:
          "pm.test('native-stream-status',()=>{pm.expect(wire.result.status).to.equal('partial');pm.expect(wire.result.result.status).to.equal(200);pm.expect(wire.request.method).to.equal('GET');pm.expect(pm.response).to.equal(undefined);});apt.setVar('accepted',true);",
      },
    });
    const report = await runPlan(snapshotPlan({ steps: [s] }), {}, noHTTP, {
      executeProtocol: executeWireFlow,
      protocolCredentials: credentials(),
    });
    assert.equal(
      report.status,
      expectedStatus === "partial" ? "passed" : "failed",
      JSON.stringify(report),
    );
    assert.equal(report.results[0].protocolResult.result.limited, true);
    assert.equal(
      report.variables.accepted,
      expectedStatus === "partial" ? true : undefined,
    );
  }
  const failed = await runPlan(
    snapshotPlan({
      steps: [
        wireStep(
          { ...f.sse, url: f.sse.url.replace("/events", "/denied") },
          undefined,
          {
            expectedStatus: "failed",
            protocolScripts: {
              version: 1,
              after:
                "pm.test('no-fictional-status',()=>{pm.expect(wire.result.status).to.equal('failed');pm.expect(wire.result.result.error).to.contain('403');pm.expect(wire.result.result.status).to.equal(undefined);pm.expect(wire.result.result.events).to.equal(undefined);});",
            },
          },
        ),
      ],
    }),
    {},
    noHTTP,
    { executeProtocol: executeWireFlow, protocolCredentials: credentials() },
  );
  assert.equal(failed.status, "passed", JSON.stringify(failed));
  assert.deepEqual(Object.keys(failed.results[0].protocolResult.result), [
    "error",
  ]);
});

test("wire script WebSocket bounded capture requires explicit partial even when POST assertions pass", async (t) => {
  const f = await fixture(t);
  for (const expectedStatus of ["completed", "partial"]) {
    const s = wireStep(f.websocket, "capture", {
      expectedStatus,
      protocol: {
        definition: f.websocket,
        message: "capture",
        maxMessages: 1,
        duration: 1500,
      },
      protocolScripts: {
        version: 1,
        after:
          "pm.test('bounded',()=>{pm.expect(wire.result.status).to.equal('partial');pm.expect(wire.result.result.limited).to.equal(true);pm.expect(wire.result.result.messages[0].data).to.equal('capture');});apt.setVar('accepted',true);",
      },
    });
    const report = await runPlan(snapshotPlan({ steps: [s] }), {}, noHTTP, {
      executeProtocol: executeWireFlow,
      protocolCredentials: credentials(),
    });
    assert.equal(
      report.status,
      expectedStatus === "partial" ? "passed" : "failed",
      JSON.stringify(report),
    );
    assert.equal(
      report.variables.accepted,
      expectedStatus === "partial" ? true : undefined,
    );
    assert.equal(report.results[0].protocolResult.status, "partial");
    assert.equal(report.results[0].assertions.at(-1).passed, true);
  }
});

test("wire script cancellation of an actual held TCP connection preserves returned error not invented partial data", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  const pending = runPlan(
    snapshotPlan({
      steps: [
        wireStep(f.tcp, "hold\n", {
          protocolScripts: {
            version: 1,
            before: "apt.setVar('confirmed','pre');",
            after: "apt.setVar('leak',true);",
          },
        }),
        { request: f.consumer },
      ],
    }),
    {},
    executeRequest,
    { executeProtocol: executeWireFlow, signal: controller.signal },
  );
  await Promise.race([
    f.held.promise,
    pending.then((report) => {
      throw Error("hold not reached: " + JSON.stringify(report));
    }),
  ]);
  controller.abort();
  const report = await pending;
  assert.equal(report.status, "cancelled");
  assert.equal(report.variables.confirmed, "pre");
  assert.equal(report.variables.leak, undefined);
  assert.equal(report.results[0].protocolResult.status, "cancelled");
  assert.deepEqual(Object.keys(report.results[0].protocolResult.result), [
    "error",
  ]);
  assert.equal(f.seen.length, 1);
  assert.equal(f.consumed.length, 0);
});

test("wire script actual valid 1 MiB TCP response survives the independent context ceiling without truncation", async (t) => {
  const f = await fixture(t);
  const report = await runPlan(
    snapshotPlan({
      steps: [
        wireStep(f.tcp, "huge\n", {
          protocolScripts: {
            version: 1,
            before: "apt.setVar('confirmed','pre');",
            after: "apt.setVar('leak',true);",
          },
        }),
      ],
    }),
    {},
    noHTTP,
    { executeProtocol: executeWireFlow },
  );
  assert.equal(report.status, "failed");
  assert.equal(report.results[0].scriptPhase, "after");
  assert.match(report.results[0].error, /上下文|超限/);
  const native = report.results[0].protocolResult;
  assert.equal(native.status, "completed");
  assert.equal(native.result.size, 1024 * 1024);
  assert.equal(native.result.body, "x".repeat(1024 * 1024));
  assert.deepEqual(
    Buffer.from(native.result.base64, "base64"),
    Buffer.alloc(1024 * 1024, 120),
  );
  assert.equal(report.variables.confirmed, "pre");
  assert.equal(report.variables.leak, undefined);
  assert.equal(f.seen.length, 1);
});

test("wire scripts persist through owner HTTP MCP aliases CLI backup and restart without live-definition drift", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "wire-script-entrypoints-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("wire scripts");
  project.protocols = [f.tcp];
  await app.store.save(project);
  const post = async (action, body) => {
    const response = await fetch(
      app.url + "/api/projects/" + project.id + "/" + action,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify(body),
      },
    );
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const configured = wireStep(f.tcp, "{{prefix}}\n");
  configured.protocol = {
    definitionId: "tcp",
    message: "{{prefix}}\n",
    duration: 1500,
  };
  configured.protocolScripts.before +=
    "pm.environment.set('durable','wire-script');";
  const plan = await post("plans", {
    name: "frozen wire scripts",
    steps: [configured, { request: f.consumer }],
  });
  assert.deepEqual(plan.steps[0].protocolScripts, configured.protocolScripts);
  const owned = await post("run", { planId: plan.id });
  assert.equal(owned.status, "passed", JSON.stringify(owned));
  assert.equal(owned.recordSaved, true);
  const changed = await app.store.get(project.id);
  changed.protocols = [];
  await app.store.save(changed);
  const runner = createMCP({
    store: app.store,
    projects: [project.id],
    write: true,
    execute: true,
  });
  for (const name of ["localapi_execute_flow", "localapi_run_plan"]) {
    const report = decode(
      await runner({
        id: 1,
        method: "tools/call",
        params: { name, arguments: { projectId: project.id, planId: plan.id } },
      }),
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.recordSaved, true);
    assert.equal(
      report.results[0].protocolResult.result.body,
      "native-value\n",
    );
  }
  const child = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
      "--project",
      project.id,
      "--plan",
      plan.id,
    ],
    {
      env: { ...process.env, LOCAL_API_DATA: root },
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const cli = JSON.parse(child.stdout);
  assert.equal(cli.status, "passed", JSON.stringify(cli));
  assert.equal(cli.recordSaved, true);
  const reloaded = await new Store(root).get(project.id);
  assert.equal(reloaded.runs.length, 4);
  assert.equal(reloaded.runs[0].source, "cli");
  assert.equal(reloaded.environments[0].variables.durable, "wire-script");
  const restored = restoreProject({ ...reloaded, version: 1 });
  assert.deepEqual(
    restored.plans[0].steps[0].protocolScripts,
    configured.protocolScripts,
  );
  assert.deepEqual(
    restored.runs[0].snapshot.steps[0].protocolScripts,
    configured.protocolScripts,
  );
  assert.deepEqual(
    restored.runs[0].results[0].protocolResult,
    reloaded.runs[0].results[0].protocolResult,
  );
  assert.equal(
    f.seen.length,
    4,
    "restart reads, restoration and definition edits do not execute",
  );
  assert.equal(f.consumed.length, 4);
});

test("wire script concurrent projects retain their own selected environment and persisted POST values", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "wire-script-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    projects = [];
  for (const tenant of ["one", "two"]) {
    const project = await store.create(tenant);
    project.environments[0].variables = { tenant };
    project.plans = [
      snapshotPlan({
        steps: [
          wireStep(f.tcp, "{{prefix}}\n", {
            protocolScripts: {
              version: 1,
              before:
                "apt.setVar('prefix',pm.environment.get('tenant'));pm.variables.set('private',pm.environment.get('tenant'));",
              after:
                "pm.test('project-local',()=>pm.expect(wire.result.result.body.trim()).to.equal(pm.variables.get('private')));pm.environment.set('observed',wire.result.result.body.trim());",
            },
          }),
        ],
      }),
    ];
    await store.save(project);
    projects.push(project);
  }
  const runner = createMCP({
    store,
    projects: projects.map((p) => p.id),
    write: true,
    execute: true,
  });
  const reports = await Promise.all(
    projects.map(async (project) =>
      decode(
        await runner({
          id: project.id,
          method: "tools/call",
          params: {
            name: "localapi_run_plan",
            arguments: { projectId: project.id, planId: project.plans[0].id },
          },
        }),
      ),
    ),
  );
  for (let i = 0; i < projects.length; i++) {
    assert.equal(reports[i].status, "passed", JSON.stringify(reports[i]));
    assert.equal(reports[i].variables.private, undefined);
    const saved = await new Store(root).get(projects[i].id);
    assert.equal(saved.environments[0].variables.observed, projects[i].name);
    assert.equal(saved.runs.length, 1);
  }
  assert.deepEqual(
    f.seen.map((item) => Buffer.from(item.bytes, "base64").toString()).sort(),
    ["one\n", "two\n"],
  );
});

test("wire script actual history-save failures return phase evidence and never replay transport", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "wire-script-history-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    project = await store.create("save failure");
  project.plans = [snapshotPlan({ steps: [wireStep(f.tcp, "{{prefix}}\n")] })];
  await store.save(project);
  const append = store.append.bind(store);
  const runner = createMCP({
    store,
    projects: [project.id],
    write: true,
    execute: true,
  });
  for (const uncertain of [false, true]) {
    store.append = async (...args) => {
      if (args[1] === "runs")
        throw uncertain
          ? new ProjectCommitUncertain(project.id, Error("fixture"))
          : Error("fixture storage failure");
      return append(...args);
    };
    const report = decode(
      await runner({
        id: 1,
        method: "tools/call",
        params: {
          name: "localapi_execute_flow",
          arguments: { projectId: project.id, planId: project.plans[0].id },
        },
      }),
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.recordSaved, false);
    assert.equal(
      report.persistenceOutcome.code,
      uncertain ? "PROJECT_COMMIT_UNCERTAIN" : "RECORD_SAVE_FAILED",
    );
    assert.equal(report.persistenceOutcome.retry_safe, false);
    assert.equal(
      report.results[0].protocolResult.result.body,
      "native-value\n",
    );
    assert.deepEqual(
      report.results[0].logs
        .filter((log) => ["before", "after"].includes(log.phase))
        .map((log) => log.message),
      ["wire-before", "wire-after"],
    );
  }
  assert.equal(f.seen.length, 2);
  assert.equal((await store.get(project.id)).runs.length, 0);
});
