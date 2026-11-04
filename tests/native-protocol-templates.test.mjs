import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { validateWireRecord } from "../src/wire-evidence.mjs";
import { validateWireSessionRecord } from "../src/wire-session-evidence.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";

const template =
  "{{ 租户 }}|{{a.b}}|{{with-hyphen}}|{{zero}}|{{no}}|{{empty}}|{{nested}}";
const expected = (tenant) => `${tenant}|whole-key|hyphen|0|false||{{$guid}}`;
const headers = { Authorization: "Bearer fictional-runtime-grant" };
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw Error("native template fixture deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(t) {
  const seen = [],
    sockets = new Set();
  let connections = 0;
  const tcp = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (bytes) => {
      seen.push({ type: "tcp", body: bytes.toString() });
      socket.write(bytes);
    });
  });
  const server = http.createServer(async (req, res) => {
    connections++;
    let body = "";
    for await (const bytes of req) body += bytes;
    seen.push({
      type: "sse",
      body,
      url: req.url,
      authorization: req.headers.authorization,
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: " + JSON.stringify(body) + "\n\n");
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    connections++;
    socket.on("error", () => {});
    socket.on("message", (bytes) => {
      seen.push({
        type: "websocket",
        body: bytes.toString(),
        url: req.url,
        authorization: req.headers.authorization,
      });
      socket.send(bytes.toString());
    });
  });
  tcp.listen(0, "127.0.0.1");
  server.listen(0, "127.0.0.1");
  await Promise.all([once(tcp, "listening"), once(server, "listening")]);
  const root = await mkdtemp(path.join(tmpdir(), "native-template-"));
  let app = await createApp({ root, port: 0 });
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await closeApp();
    for (const socket of sockets) socket.destroy();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => tcp.close(resolve)),
      new Promise((resolve) => server.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
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
  const post = (projectId, route, body = {}) =>
    request(`/api/projects/${projectId}/${route}`, body);
  const projects = [],
    sources = [];
  for (const tenant of ["alpha", "beta"]) {
    const p = await app.store.create(tenant);
    const source = nativeProtocolFixture({
      ws: `ws://127.0.0.1:${server.address().port}/echo?x=one`,
      tcp: `127.0.0.1:${tcp.address().port}`,
      sse: `http://127.0.0.1:${server.address().port}/events?x=one`,
    });
    source.project_id = `native-${tenant}`;
    source.apis.forEach((node) => {
      node.project_id = source.project_id;
    });
    source.apis[0].message[0].request.raw = template;
    source.apis[2].request.body.raw = template;
    source.apis[3].request.body.raw = template;
    for (const index of [0, 3])
      source.apis[index].request.header.parameter.push({
        key: "Authorization",
        value: "Bearer fictional-source-never-authority",
        is_checked: 1,
      });
    const original = JSON.stringify(source);
    const imported = await post(p.id, "import", { document: source });
    assert.equal(imported.status, 200, JSON.stringify(imported));
    assert.equal(JSON.stringify(source), original);
    const saved = await app.store.get(p.id);
    saved.globalVariables = {
      租户: "global",
      unused: "unused-context-must-not-leak",
    };
    saved.environments[0].variables = {
      租户: tenant,
      "a.b": "whole-key",
      "with-hyphen": "hyphen",
      zero: 0,
      no: false,
      empty: "",
      nested: "{{$guid}}",
      big: "x".repeat(1048577),
    };
    saved.environments.push({
      id: "alternate",
      name: "alternate",
      variables: { ...saved.environments[0].variables, 租户: "alternate" },
    });
    await app.store.save(saved);
    assert(
      saved.protocols.every(
        (definition) => definition.templateMode === "variables",
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(saved),
      /fictional-source-never-authority/,
    );
    assert.equal(
      saved.settings.apipostProtocolSources.find(
        (s) => s.sourceTargetId === "ws",
      ).source.message[0].request.raw,
      template,
    );
    assert.equal(
      saved.settings.apipostProtocolSources.find(
        (s) => s.sourceTargetId === "tcp-message",
      ).source.request.body.raw,
      template,
    );
    assert.equal(
      saved.settings.apipostProtocolSources.find(
        (s) => s.sourceTargetId === "events",
      ).source.request.body.raw,
      template,
    );
    projects.push(saved);
    sources.push(source);
  }
  return {
    root,
    projects,
    sources,
    seen,
    post,
    request,
    connections: () => connections,
    get app() {
      return app;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
  };
}
const input = (definition, live = false) => ({
  definitionId: definition.id,
  ...(definition.type === "tcp" ? {} : { headers }),
  ...(live
    ? {}
    : {
        ...(definition.type === "websocket" ? { maxMessages: 1 } : {}),
        duration: 1000,
      }),
});
const steps = (p) =>
  p.protocols.map((definition) => ({
    id: definition.type,
    type: "protocol",
    ...(definition.type === "websocket" ? { expectedStatus: "partial" } : {}),
    protocol: {
      definitionId: definition.id,
      ...(definition.type === "websocket" ? { maxMessages: 1 } : {}),
      duration: 1000,
    },
  }));
const credentials = { websocket: { headers }, sse: { headers } };
async function sdkRun(
  f,
  p,
  planId,
  { execute = true, projectId = p.id, bind = true } = {},
) {
  const client = new Client(
    { name: "native-template-fixture", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
      "--project",
      p.id,
      ...(execute ? ["--write", "--execute"] : []),
    ],
    env: { LOCAL_API_DATA: f.root },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (part) => {
    stderr += part;
  });
  try {
    await client.connect(transport);
    return await client.callTool({
      name: "localapi_run_plan",
      arguments: {
        projectId,
        planId,
        ...(bind ? { protocolCredentials: credentials } : {}),
      },
    });
  } finally {
    await client.close();
    assert.doesNotMatch(
      stderr,
      /fictional-runtime-grant|unused-context-must-not-leak/,
    );
  }
}

test(
  "native text templates execute by saved ID and frozen plan through HTTP/SDK, isolate projects, restore and restart",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      [p, other] = f.projects;
    // Concurrent projects resolve the same original payload against different environments.
    for (const type of ["websocket", "tcp", "sse"]) {
      const before = f.seen.length;
      const results = await Promise.all(
        f.projects.map((project) =>
          f.post(
            project.id,
            "protocol",
            input(project.protocols.find((d) => d.type === type)),
          ),
        ),
      );
      for (const result of results) {
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.value.recordSaved, true);
      }
      assert.deepEqual(
        f.seen
          .slice(before)
          .map((wire) => wire.body)
          .sort(),
        [expected("alpha"), expected("beta")].sort(),
      );
    }
    for (const wire of f.seen.filter((wire) => wire.type !== "tcp")) {
      assert.match(wire.url, /\?x=one$/);
      assert.equal(wire.authorization, headers.Authorization);
    }
    let saved = await new Store(f.root).get(p.id);
    assert.deepEqual(saved.protocols, p.protocols);
    for (const record of saved.protocolRuns) {
      validateWireRecord(record);
      assert.equal(record.definition.templateMode, "literal");
      assert.equal(
        record.templateProvenance.environmentId,
        p.environments[0].id,
      );
    }
    const frozen = await f.post(p.id, "plans", {
      name: "native frozen variables",
      steps: steps(p),
    });
    assert.equal(frozen.status, 200, JSON.stringify(frozen));
    saved = await f.app.store.get(p.id);
    for (const definition of saved.protocols) {
      if (definition.type === "sse") definition.body = "edited-live";
      else definition.message = "edited-live";
      if (definition.type === "tcp") definition.port = 1;
      else
        definition.url =
          definition.type === "websocket"
            ? "ws://127.0.0.1:1/edited"
            : "http://127.0.0.1:1/edited";
    }
    await f.app.store.save(saved);
    let before = f.connections();
    assert.equal(
      (await f.post(other.id, "protocol", input(p.protocols[0]))).status,
      400,
    );
    assert.equal(
      (await f.post(p.id, "run", { planId: frozen.value.id })).status,
      400,
    );
    assert.equal(
      (await sdkRun(f, p, frozen.value.id, { execute: false })).isError,
      true,
    );
    assert.equal(
      (await sdkRun(f, p, frozen.value.id, { projectId: other.id })).isError,
      true,
    );
    assert.equal(
      (await sdkRun(f, p, frozen.value.id, { bind: false })).isError,
      true,
    );
    assert.equal(f.connections(), before);
    const run = await f.post(p.id, "run", {
      planId: frozen.value.id,
      protocolCredentials: credentials,
    });
    assert.equal(run.value.status, "passed", JSON.stringify(run));
    assert.equal(run.value.recordSaved, true);
    assert(f.seen.slice(-3).every((wire) => wire.body === expected("alpha")));
    assert(
      run.value.snapshot.steps.every(
        (step) =>
          (step.protocol.message ?? step.protocol.definition.body) === template,
      ),
    );
    for (let restart = 0; restart < 2; restart++) {
      const result = await sdkRun(f, p, frozen.value.id);
      assert.equal(result.isError, undefined, result.content?.[0]?.text);
      const record = JSON.parse(result.content[0].text);
      assert.equal(record.status, "passed");
      assert.equal(record.recordSaved, true);
      assert(f.seen.slice(-3).every((wire) => wire.body === expected("alpha")));
    }
    saved = await f.app.store.get(p.id);
    assert.equal(saved.runs.length, 3);
    saved.protocols = structuredClone(p.protocols);
    saved.environments.push({ id: "missing", name: "missing", variables: {} });
    await f.app.store.save(saved);
    before = f.connections();
    const failed = await f.post(p.id, "run", {
      planId: frozen.value.id,
      environmentId: "missing",
      protocolCredentials: credentials,
    });
    assert.equal(failed.status, 200, JSON.stringify(failed));
    assert.equal(failed.value.status, "failed");
    assert.equal(failed.value.recordSaved, true);
    assert.match(JSON.stringify(failed.value.results), /缺少变量/);
    assert.equal(
      f.connections(),
      before,
      "failed frozen-template resolution must not connect",
    );
    saved = await f.app.store.get(p.id);
    assert.equal(saved.runs.length, 4);
    assert(
      saved.runs.some(
        (run) => run.id === failed.value.id && run.status === "failed",
      ),
    );
    const exported = await f.request(
      `/api/projects/${p.id}/export`,
      undefined,
      "GET",
    );
    const restored = await f.request("/api/restore", {
      document: exported.value,
    });
    assert.equal(restored.status, 201, JSON.stringify(restored));
    assert.deepEqual(restored.value.protocolRuns, saved.protocolRuns);
    assert.deepEqual(restored.value.runs, saved.runs);
    assert.deepEqual(
      restored.value.settings.apipostProtocolSources,
      saved.settings.apipostProtocolSources,
    );
    before = f.connections();
    await f.restart();
    assert.equal(f.connections(), before);
    for (const current of [p, restored.value]) {
      const reloaded = await new Store(f.root).get(current.id);
      assert.deepEqual(reloaded.protocols, p.protocols);
      for (const definition of reloaded.protocols) {
        if (definition.type !== "tcp") {
          const absent = await f.post(current.id, "protocol", {
            definitionId: definition.id,
          });
          assert.equal(absent.status, 400);
          assert.equal(f.connections(), before);
        }
        const result = await f.post(current.id, "protocol", input(definition));
        assert.equal(result.value.recordSaved, true, JSON.stringify(result));
        assert.equal(f.seen.at(-1).body, expected("alpha"));
        before = f.connections();
      }
    }
    assert.doesNotMatch(
      JSON.stringify((await new Store(f.root).get(p.id)).protocolRuns),
      /unused-context-must-not-leak/,
    );
  },
);

test(
  "native live sessions keep the open environment; invalid import/open/send never leaks partial execution",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      [p, other] = f.projects;
    const native = f.sources[0];
    const mutations = [
      (d) => {
        d.apis[0].url += "&tenant={{租户}}";
      },
      (d) => {
        d.apis[0].request.query.parameter[0].value = "{{租户}}";
      },
      (d) => {
        d.apis[0].request.header.parameter[0].value = "{{租户}}";
      },
      (d) => {
        d.apis[0].request.cookie.parameter = [
          { key: "tenant", value: "{{租户}}", is_checked: 1 },
        ];
      },
      (d) => {
        d.apis[1].url = "{{host}}:1234";
      },
      (d) => {
        d.apis[1].url = "127.0.0.1:{{port}}";
      },
      (d) => {
        d.apis[3].request.auth = {
          type: "bearer",
          bearer: { key: "{{租户}}" },
        };
      },
      ...["{{foo()}}", "{{a+b}}", "{{$guid}}"].map((text) => (d) => {
        d.apis[3].request.body.raw = text;
      }),
      (d) => {
        d.apis[2].request.post_tasks = [
          { type: "customScript", data: { script: "throw 1" } },
        ];
      },
    ];
    const unchanged = await f.app.store.get(p.id),
      connections = f.connections();
    for (const mutate of mutations) {
      const bad = structuredClone(native);
      mutate(bad);
      const original = JSON.stringify(bad);
      const rejected = await f.post(p.id, "import", { document: bad });
      assert.equal(rejected.status, 400, JSON.stringify(rejected));
      assert.equal(JSON.stringify(bad), original);
      assert.deepEqual(await f.app.store.get(p.id), unchanged);
    }
    for (const definition of p.protocols) {
      // Missing/oversize SSE bodies are saved native templates, not a forbidden body override.
      for (const text of ["{{missing}}", "{{big}}"]) {
        const changed = await f.app.store.get(p.id);
        const savedDefinition = changed.protocols.find(
          (d) => d.id === definition.id,
        );
        if (definition.type === "sse") savedDefinition.body = text;
        else savedDefinition.message = text;
        await f.app.store.save(changed);
        for (const route of ["protocol", "protocol-sessions"]) {
          const result = await f.post(
            p.id,
            route,
            input(definition, route === "protocol-sessions"),
          );
          assert.equal(result.status, 400, JSON.stringify(result));
          assert.match(result.value.error, /缺少变量|超过/);
        }
      }
      const reset = await f.app.store.get(p.id);
      reset.protocols = structuredClone(p.protocols);
      await f.app.store.save(reset);
    }
    assert.equal(
      f.connections(),
      connections,
      "failed open/one-shot must not connect",
    );
    const sessionIds = [];
    for (const definition of p.protocols.filter((d) => d.type !== "sse")) {
      const opened = await f.post(
        p.id,
        "protocol-sessions",
        input(definition, true),
      );
      assert.equal(opened.status, 200, JSON.stringify(opened));
      const id = opened.value.id;
      sessionIds.push(id);
      const state = () =>
        f.request(
          `/api/projects/${p.id}/protocol-sessions/${id}`,
          undefined,
          "GET",
        );
      await until(async () => (await state()).value.state === "open");
      const changed = await f.app.store.get(p.id);
      changed.currentEnvironmentId = "alternate";
      changed.environments[0].variables.租户 = "edited-after-open";
      changed.protocols.find((d) => d.id === definition.id).message =
        "live-definition-edit";
      await f.app.store.save(changed);
      let count = f.seen.length;
      assert.equal(
        (await f.post(p.id, `protocol-sessions/${id}/send`)).status,
        200,
      );
      await until(() => f.seen.length > count);
      assert.equal(f.seen.at(-1).body, expected("alpha"));
      count = f.seen.length;
      assert.equal(
        (
          await f.post(p.id, `protocol-sessions/${id}/send`, {
            message: "{{ 租户 }}|{{a.b}}",
          })
        ).status,
        200,
      );
      await until(() => f.seen.length > count);
      assert.equal(f.seen.at(-1).body, "alpha|whole-key");
      count = f.seen.length;
      for (const message of ["{{missing}}", "{{big}}"])
        assert.equal(
          (await f.post(p.id, `protocol-sessions/${id}/send`, { message }))
            .status,
          400,
        );
      assert.equal(
        (
          await f.post(other.id, `protocol-sessions/${id}/send`, {
            message: "foreign",
          })
        ).status,
        400,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        f.seen.length,
        count,
        "failed live send must not write on the existing connection",
      );
      assert.equal(
        (await state()).value.events.filter(
          (event) => event.direction === "sent",
        ).length,
        2,
      );
      const stopped = await f.post(p.id, `protocol-sessions/${id}/stop`);
      assert.equal(stopped.value.recordSaved, true, JSON.stringify(stopped));
      const reset = await f.app.store.get(p.id);
      reset.currentEnvironmentId = p.environments[0].id;
      reset.environments[0].variables.租户 = "alpha";
      reset.protocols = structuredClone(p.protocols);
      await f.app.store.save(reset);
    }
    const sse = p.protocols.find((d) => d.type === "sse");
    const opened = await f.post(p.id, "protocol-sessions", input(sse, true));
    assert.equal(opened.status, 200, JSON.stringify(opened));
    sessionIds.push(opened.value.id);
    await until(
      async () =>
        (
          await f.request(
            `/api/projects/${p.id}/protocol-sessions/${opened.value.id}`,
            undefined,
            "GET",
          )
        ).value.state === "closed",
    );
    assert.equal(
      (await f.post(p.id, `protocol-sessions/${opened.value.id}/stop`)).value
        .recordSaved,
      true,
    );
    assert.equal(f.seen.at(-1).body, expected("alpha"));
    const saved = await f.app.store.get(p.id);
    assert.equal(saved.protocolRuns.length, 3);
    for (const record of saved.protocolRuns) validateWireSessionRecord(record);
    assert.doesNotMatch(
      JSON.stringify(saved.protocolRuns),
      /unused-context-must-not-leak|edited-after-open/,
    );
    const backup = await f.request(
      `/api/projects/${p.id}/export`,
      undefined,
      "GET",
    );
    const restored = await f.request("/api/restore", {
      document: backup.value,
    });
    assert.equal(restored.status, 201, JSON.stringify(restored));
    assert.deepEqual(restored.value.protocolRuns, saved.protocolRuns);
    const before = f.connections();
    await f.restart();
    for (const id of sessionIds)
      assert.equal(
        (
          await f.request(
            `/api/projects/${p.id}/protocol-sessions/${id}`,
            undefined,
            "GET",
          )
        ).status,
        400,
      );
    assert.equal(
      f.connections(),
      before,
      "restore/restart does not revive network sessions",
    );
    assert.deepEqual(
      (await new Store(f.root).get(p.id)).protocolRuns,
      saved.protocolRuns,
    );
  },
);
