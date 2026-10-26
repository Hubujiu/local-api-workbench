import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";
import {
  prepareWireExecution,
  validateWireRecord,
} from "../src/wire-evidence.mjs";
import { validateWireSessionRecord } from "../src/wire-session-evidence.mjs";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";
import {
  resolveProtocolText,
  protocolTemplateContext,
} from "../src/protocol-text-templates.mjs";
import { createMCP } from "../src/mcp.mjs";

async function until(fn) {
  const end = Date.now() + 4000;
  while (!(await fn())) {
    if (Date.now() > end) throw Error("template fixture deadline");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture(t) {
  const received = [],
    sockets = new Set();
  let connections = 0;
  const tcp = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (data) => {
      received.push({ type: "tcp", body: data.toString() });
      socket.write(data);
    });
  });
  const server = http.createServer(async (req, res) => {
    connections++;
    let body = "";
    for await (const part of req) body += part;
    received.push({ type: "sse", body, url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: " + JSON.stringify(body) + "\n\n");
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    connections++;
    socket.on("error", () => {});
    socket.on("message", (data) => {
      received.push({ type: "websocket", body: data.toString() });
      socket.send(data.toString());
    });
  });
  tcp.listen(0, "127.0.0.1");
  server.listen(0, "127.0.0.1");
  await Promise.all([once(tcp, "listening"), once(server, "listening")]);
  const root = await mkdtemp(path.join(tmpdir(), "wire-templates-"));
  let app = await createApp({ root, port: 0 });
  const stopApp = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await stopApp();
    for (const socket of sockets) socket.destroy();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((r) => wss.close(r));
    server.closeAllConnections();
    await Promise.all([
      new Promise((r) => server.close(r)),
      new Promise((r) => tcp.close(r)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("template project"),
    other = await app.store.create("isolated");
  p.globalVariables = {
    tenant: "global",
    unusedSecret: "not-in-session-evidence",
  };
  p.environments[0].variables = {
    tenant: "environment",
    zero: 0,
    no: false,
    empty: "",
    nested: "{{notExpanded}}",
  };
  p.environments.push({
    id: "alternate",
    name: "alternate",
    variables: { tenant: "alternate" },
  });
  const defs = [
    {
      id: "ws",
      type: "websocket",
      url: `ws://127.0.0.1:${server.address().port}/fixed`,
      message: "{{tenant}}/{{zero}}/{{no}}/{{empty}}/{{nested}}",
    },
    {
      id: "tcp",
      type: "tcp",
      url: "127.0.0.1",
      port: tcp.address().port,
      completion: "first-data",
      message: "{{tenant}}",
    },
    {
      id: "sse",
      type: "sse",
      url: `http://127.0.0.1:${server.address().port}/fixed?key=literal`,
      method: "POST",
      body: "{{tenant}}/{{zero}}/{{no}}/{{empty}}/{{nested}}",
    },
  ];
  p.protocols = defs.map((d) =>
    normalizeProtocol({ ...d, templateMode: "variables" }),
  );
  await app.store.save(p);
  const request = async (route, body, method = "POST") => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const post = (route, body = {}, project = p.id) =>
    request(`/api/projects/${project}/${route}`, body);
  return {
    get app() {
      return app;
    },
    root,
    p,
    other,
    defs,
    received,
    connections: () => connections,
    request,
    post,
    async restart() {
      await stopApp();
      app = await createApp({ root, port: 0 });
    },
  };
}

test("bounded explicit text modes preserve legacy forms and never evaluate replacement text", () => {
  assert.equal(
    resolveProtocolText("{{zero}}|{{no}}|{{empty}}|{{next}}", {
      zero: 0,
      no: false,
      empty: "",
      next: "{{$guid}}$&",
    }),
    "0|false||{{$guid}}$&",
  );
  for (const value of [null, {}, [], Infinity, NaN, undefined, 1n])
    assert.throws(() => resolveProtocolText("{{value}}", { value }));
  assert.throws(() => resolveProtocolText("{{$guid}}", {}), /缺少变量/);
  assert.throws(
    () =>
      resolveProtocolText("{{value}}", Object.create({ value: "inherited" })),
    /缺少变量/,
  );
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    get() {
      throw Error("must not call");
    },
  });
  assert.throws(() => resolveProtocolText("{{value}}", accessor), /缺少变量/);
  for (const text of ["{{", "{{}}", "{{a{b}}", "orphan}}", "{{constructor}}"])
    assert.throws(() => resolveProtocolText(text, {}));
  const oneMiB = "雪".repeat(349525) + "x";
  assert.equal(
    Buffer.byteLength(resolveProtocolText("{{value}}", { value: oneMiB })),
    1048576,
  );
  assert.throws(
    () =>
      resolveProtocolText("{{value}}{{value}}".repeat(10000), {
        value: oneMiB,
      }),
    /超过/,
  );
  assert.throws(
    () => resolveProtocolText("{{value}}", { value: "x".repeat(65537) }, 65536),
    /超过/,
  );
  const base = {
    id: "d",
    type: "websocket",
    url: "ws://127.0.0.1:1",
    message: "{{literal}}",
  };
  assert(!Object.hasOwn(normalizeProtocol(base), "templateMode"));
  assert.equal(
    normalizeProtocol({ ...base, templateMode: "literal" }).message,
    "{{literal}}",
  );
  for (const templateMode of ["variables", "literal"]) {
    assert.throws(() =>
      normalizeProtocol({
        ...base,
        templateMode,
        message: { encoding: "utf8", data: "text" },
      }),
    );
    assert.throws(() =>
      normalizeProtocol({
        type: "sse",
        url: "http://127.0.0.1:1",
        templateMode,
      }),
    );
  }
  const project = {
    environments: [{ id: "env", variables: { value: "fixed" } }],
  };
  const context = protocolTemplateContext(project);
  project.environments[0].variables.value = "changed";
  assert.equal(context.variables.value, "fixed");
  assert.throws(() => protocolTemplateContext(project, ""));
  assert.throws(() => protocolTemplateContext(project, "foreign"));
  assert.throws(
    () =>
      protocolTemplateContext({
        environments: [{ id: "env", variables: { big: "x".repeat(4194305) } }],
      }),
    /4MiB/,
  );
});

test("project HTTP resolves actual WS TCP SSE payloads, preserves definitions and restores durable evidence", async (t) => {
  const f = await fixture(t),
    original = JSON.stringify(f.p.protocols);
  for (const definitionId of ["ws", "tcp", "sse"]) {
    const result = await f.post("protocol", {
      definitionId,
      duration: 150,
      maxMessages: 1,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.value.recordSaved, true, JSON.stringify(result));
  }
  assert.deepEqual(
    f.received.map((x) => x.body),
    [
      "environment/0/false//{{notExpanded}}",
      "environment",
      "environment/0/false//{{notExpanded}}",
    ],
  );
  let saved = await new Store(f.root).get(f.p.id);
  assert.equal(JSON.stringify(saved.protocols), original);
  assert.equal(saved.protocolRuns.length, 3);
  for (const record of saved.protocolRuns) {
    validateWireRecord(record);
    assert.equal(record.definition.templateMode, "literal");
    assert.equal(
      record.templateProvenance.environmentId,
      f.p.environments[0].id,
    );
  }
  assert(
    !JSON.stringify(saved.protocolRuns).includes("not-in-session-evidence"),
  );
  const before = f.connections();
  for (const input of [
    { definitionId: "ws", message: "{{missing}}" },
    { definitionId: "ws", templateMode: "literal" },
    { definitionId: "sse", body: "override" },
    { definitionId: "tcp", environmentId: "foreign" },
    { definitionId: "tcp", environmentId: "" },
  ])
    assert.equal((await f.post("protocol", input)).status, 400);
  assert.equal(
    (await f.post("protocol", { definitionId: "ws" }, f.other.id)).status,
    400,
  );
  assert.equal(f.connections(), before);
  const exported = await f.request(
    `/api/projects/${f.p.id}/export`,
    undefined,
    "GET",
  );
  const restored = await f.request("/api/restore", {
    document: exported.value,
  });
  assert.equal(restored.status, 201, JSON.stringify(restored));
  assert.deepEqual(restored.value.protocolRuns, saved.protocolRuns);
  assert.deepEqual(restored.value.protocols, saved.protocols);
  const corrupt = structuredClone(exported.value);
  corrupt.protocolRuns[0].templateProvenance.variables = { forbidden: "data" };
  assert.equal(
    (await f.request("/api/restore", { document: corrupt })).status,
    400,
  );
  await f.restart();
  saved = await new Store(f.root).get(f.p.id);
  assert.equal(saved.protocolRuns.length, 3);
  assert.equal(
    (await f.post("protocol", { definitionId: "tcp" })).value.recordSaved,
    true,
  );
});

test("explicit plan modes freeze definitions and use prior runtime extraction; old implicit interpolation remains", async (t) => {
  const f = await fixture(t);
  const response = await f.post("plans", {
    steps: [
      {
        id: "tcp",
        type: "protocol",
        protocol: { definitionId: "tcp" },
        extract: [{ name: "previous", path: "$.body" }],
      },
      {
        id: "ws",
        type: "protocol",
        expectedStatus: "partial",
        protocol: {
          definitionId: "ws",
          message: "{{previous}}",
          duration: 150,
          maxMessages: 1,
        },
      },
      { id: "sse", type: "protocol", protocol: { definitionId: "sse" } },
    ],
  });
  assert.equal(response.status, 200, JSON.stringify(response));
  const plan = response.value;
  const modified = await f.app.store.get(f.p.id);
  modified.protocols[0].message = "changed";
  modified.protocols[0].url = "ws://127.0.0.1:1/changed";
  await f.app.store.save(modified);
  const run = await f.post("run", { planId: plan.id });
  assert.equal(run.value.status, "passed", JSON.stringify(run));
  assert.equal(run.value.recordSaved, true);
  assert.equal(run.value.results[1].protocol.message, "environment");
  assert.equal(
    run.value.results[2].protocol.definition.body,
    "environment/0/false//{{notExpanded}}",
  );
  assert.equal(run.value.snapshot.steps[1].protocol.message, "{{previous}}");
  const mcp = createMCP({
    store: f.app.store,
    projects: [f.p.id],
    write: true,
    execute: true,
  });
  const output = await mcp({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_run_plan",
      arguments: { projectId: f.p.id, planId: plan.id },
    },
  });
  assert.equal(
    output.result.isError,
    undefined,
    output.result.content?.[0]?.text,
  );
  const legacy = snapshotPlan({
    steps: [
      {
        type: "protocol",
        protocol: { definition: f.defs[1], message: "{{value}}" },
      },
    ],
  });
  assert.equal(
    (
      await runPlan(legacy, { value: "legacy" }, async () => {}, {
        executeProtocol: executeWireFlow,
      })
    ).status,
    "passed",
  );
  const literal = snapshotPlan({
    steps: [
      {
        type: "protocol",
        protocol: {
          definition: { ...f.defs[1], templateMode: "literal" },
          message: "{{missing}}",
        },
      },
    ],
  });
  assert.equal(
    (
      await runPlan(literal, {}, async () => {}, {
        executeProtocol: executeWireFlow,
      })
    ).status,
    "passed",
  );
  assert.equal(f.received.at(-1).body, "{{missing}}");
  const missing = snapshotPlan({
    steps: [
      {
        type: "protocol",
        protocol: {
          definition: { ...f.defs[1], templateMode: "variables" },
          message: "{{missing}}",
        },
      },
    ],
  });
  const before = f.connections();
  const failure = await runPlan(missing, {}, async () => {}, {
    executeProtocol: executeWireFlow,
  });
  assert.equal(failure.status, "failed");
  assert.equal(f.connections(), before);
});

test("live WS TCP SSE uses one private open-time context and errors never send unresolved text", async (t) => {
  const f = await fixture(t);
  for (const definitionId of ["ws", "tcp"]) {
    const opened = await f.post("protocol-sessions", { definitionId });
    assert.equal(opened.status, 200, JSON.stringify(opened));
    const sessionId = opened.value.id;
    await until(
      async () =>
        (
          await f.request(
            `/api/projects/${f.p.id}/protocol-sessions/${sessionId}`,
            undefined,
            "GET",
          )
        ).value.state === "open",
    );
    const changed = await f.app.store.get(f.p.id);
    changed.currentEnvironmentId = "alternate";
    changed.environments[0].variables.tenant = "edited after open";
    await f.app.store.save(changed);
    const startCount = f.received.length;
    assert.equal(
      (await f.post(`protocol-sessions/${sessionId}/send`, {})).status,
      200,
    );
    await until(() => f.received.length > startCount);
    assert.equal(
      f.received.at(-1).body,
      definitionId === "ws"
        ? "environment/0/false//{{notExpanded}}"
        : "environment",
    );
    const count = f.received.length;
    assert.equal(
      (
        await f.post(`protocol-sessions/${sessionId}/send`, {
          message: "{{tenant}}/{{nested}}",
        })
      ).status,
      200,
    );
    await until(() => f.received.length > count);
    assert.equal(f.received.at(-1).body, "environment/{{notExpanded}}");
    assert.equal(
      (
        await f.post(`protocol-sessions/${sessionId}/send`, {
          message: "{{missing}}",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.post(
          `protocol-sessions/${sessionId}/send`,
          { message: "foreign" },
          f.other.id,
        )
      ).status,
      400,
    );
    const state = await f.request(
      `/api/projects/${f.p.id}/protocol-sessions/${sessionId}`,
      undefined,
      "GET",
    );
    assert(!JSON.stringify(state).includes("not-in-session-evidence"));
    const stopped = await f.post(`protocol-sessions/${sessionId}/stop`);
    assert.equal(stopped.value.recordSaved, true, JSON.stringify(stopped));
    const reset = await f.app.store.get(f.p.id);
    reset.currentEnvironmentId = reset.environments[0].id;
    reset.environments[0].variables.tenant = "environment";
    await f.app.store.save(reset);
  }
  assert(
    f.received
      .filter((x) => x.type !== "sse")
      .every(
        (x) =>
          !x.body.includes("alternate") &&
          !x.body.includes("edited after open") &&
          !x.body.includes("{{missing}}"),
      ),
  );
  const sse = await f.post("protocol-sessions", { definitionId: "sse" });
  assert.equal(sse.status, 200);
  await until(
    async () =>
      (
        await f.request(
          `/api/projects/${f.p.id}/protocol-sessions/${sse.value.id}`,
          undefined,
          "GET",
        )
      ).value.state === "closed",
  );
  assert.equal(
    (await f.post(`protocol-sessions/${sse.value.id}/stop`)).value.recordSaved,
    true,
  );
  assert.equal(f.received.at(-1).body, "environment/0/false//{{notExpanded}}");
  const before = f.connections();
  assert.equal(
    (
      await f.post("protocol-sessions", {
        definitionId: "ws",
        message: "{{missing}}",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/protocol-sessions", {
        ...f.defs[0],
        templateMode: "variables",
      })
    ).status,
    400,
  );
  assert.equal(f.connections(), before);
  const saved = await f.app.store.get(f.p.id);
  for (const record of saved.protocolRuns) validateWireSessionRecord(record);
  assert(
    !JSON.stringify(saved.protocolRuns).includes("not-in-session-evidence"),
  );
  const sessions = new ProtocolSessions();
  const prepared = prepareWireExecution(saved, { definitionId: "tcp" });
  const local = sessions.start(prepared.request, {
    templateContext: prepared.templateContext,
  });
  assert(sessions.get(local.id).templateContext);
  sessions.stop(local.id);
  assert.equal(sessions.get(local.id).templateContext, undefined);
  sessions.close();
});
