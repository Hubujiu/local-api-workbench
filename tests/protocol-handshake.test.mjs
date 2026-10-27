import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";
import {
  importIntoProject,
  restoreProject,
  snapshotPlan,
  runPlan,
} from "../src/core.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";
import {
  normalizeHandshake,
  resolveHandshake,
} from "../src/protocol-handshake.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";
const row = (key, value, is_checked = 1) => ({
  key,
  value,
  is_checked,
  field_type: "string",
  schema: { type: "string" },
});
test(
  "native handshake import freezes safe metadata and requires isolated runtime credentials for real WS/SSE, save/restore/restart",
  { timeout: 20000 },
  async (t) => {
    const seen = [],
      upstream = http.createServer((req, res) => {
        seen.push({ type: "sse", headers: req.headers });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"result":"ok"}\n\n');
      });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (socket, req) => {
      seen.push({ type: "websocket", headers: req.headers });
      socket.on("message", () => {
        socket.send("ok");
        socket.close();
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = upstream.address().port,
      root = await mkdtemp(path.join(os.tmpdir(), "handshake-"));
    let app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      for (const s of wss.clients) s.terminate();
      wss.close();
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const source = nativeProtocolFixture({
      ws: `ws://127.0.0.1:${port}/ws?x=one`,
      sse: `http://127.0.0.1:${port}/events?x=one`,
    });
    source.apis = source.apis.filter((n) =>
      ["websocket2", "sse"].includes(n.target_type),
    );
    source.apis[0].request.header.parameter = [
      row("X-Fixture", "SOURCE-CUSTOM-SECRET"),
      row("X-Disabled", "DISABLED-SECRET", 0),
      row("", "BLANK-SECRET", 0),
      row("   ", "WHITESPACE-SECRET"),
    ];
    source.apis[0].request.cookie.parameter = [
      row("fixtureCookie", "SOURCE-COOKIE-SECRET"),
    ];
    source.apis[1].request.header.parameter = [
      row("Accept", "text/event-stream"),
    ];
    source.apis[1].request.auth = {
      type: "bearer",
      bearer: { key: "SOURCE-BEARER-SECRET" },
    };
    const original = JSON.stringify(source),
      p = await app.store.create("Handshake");
    importIntoProject(p, source);
    await app.store.save(p);
    assert.equal(JSON.stringify(source), original);
    assert.doesNotMatch(
      JSON.stringify(p),
      /SOURCE-.*?-SECRET|DISABLED-SECRET|BLANK-SECRET|WHITESPACE-SECRET/,
    );
    const ws = p.protocols.find((x) => x.type === "websocket"),
      sse = p.protocols.find((x) => x.type === "sse");
    assert.deepEqual(ws.handshake.requiredHeaders, ["cookie", "x-fixture"]);
    assert.deepEqual(sse.handshake, {
      headers: { accept: "text/event-stream" },
      requiredHeaders: ["authorization"],
    });
    const plan = snapshotPlan({
      name: "Frozen",
      steps: p.protocols.map((definition, i) => ({
        id: "step" + i,
        type: "protocol",
        protocol: { definition },
        assertions: [],
      })),
    });
    const creds = Object.fromEntries(
      plan.steps.map((step) => [
        step.id,
        {
          headers:
            step.protocol.definition.type === "websocket"
              ? {
                  "X-Fixture": "runtime-custom",
                  Cookie: "fixtureCookie=a b%2F",
                }
              : { Authorization: "Bearer runtime-token" },
        },
      ]),
    );
    let prior = 0;
    await assert.rejects(
      runPlan(
        snapshotPlan({
          name: "Preflight",
          steps: [
            {
              request: { name: "Must not execute", url: "http://127.0.0.1:1/" },
            },
            ...plan.steps,
          ],
        }),
        {},
        async () => {
          prior++;
          return {};
        },
        { executeProtocol: executeWireFlow },
      ),
      /缺少协议运行时Header/,
    );
    assert.equal(prior, 0);
    assert.equal(seen.length, 0);
    ws.handshake.requiredHeaders.push("x-added-after-freeze");
    assert.equal(
      plan.steps
        .find((x) => x.protocol.definition.type === "websocket")
        .protocol.definition.handshake.requiredHeaders.includes(
          "x-added-after-freeze",
        ),
      false,
    );
    ws.handshake.requiredHeaders.pop();
    const restored = restoreProject(p);
    await app.store.save(restored);
    const ownerHeaders = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
    for (const current of [p, restored]) {
      for (const definition of current.protocols) {
        const url = app.url + "/api/projects/" + current.id + "/protocol";
        const missing = await fetch(url, {
          method: "POST",
          headers: ownerHeaders,
          body: JSON.stringify({ definitionId: definition.id }),
        });
        assert.equal(missing.status, 400);
        const headers =
          definition.type === "websocket"
            ? { "X-Fixture": "runtime-custom", Cookie: "fixtureCookie=a b%2F" }
            : { Authorization: "Bearer runtime-token" };
        const response = await fetch(url, {
          method: "POST",
          headers: ownerHeaders,
          body: JSON.stringify({ definitionId: definition.id, headers }),
        });
        assert.equal(response.status, 200, await response.text());
      }
    }
    const run = await runPlan(plan, {}, () => {}, {
      executeProtocol: executeWireFlow,
      protocolCredentials: creds,
    });
    assert.equal(run.status, "passed");
    assert.equal(seen.length, 6);
    for (const wire of seen)
      if (wire.type === "websocket") {
        assert.equal(wire.headers["x-fixture"], "runtime-custom");
        assert.equal(wire.headers.cookie, "fixtureCookie=a b%2F");
        assert.equal(wire.headers["x-disabled"], undefined);
      } else {
        assert.equal(wire.headers.accept, "text/event-stream");
        assert.equal(wire.headers.authorization, "Bearer runtime-token");
      }
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const current = await app.store.get(p.id);
    current.plans = [plan];
    await app.store.save(current);
    const config = await (
      await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          enabled: true,
          projects: [p.id],
          write: true,
          execute: true,
          remember: false,
        }),
      })
    ).json();
    const client = new Client(
      { name: "handshake-fixture", version: "1" },
      { capabilities: {} },
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
      );
      const invoke = (projectId, credentials) =>
        client.callTool({
          name: "localapi_execute_flow",
          arguments: {
            projectId,
            planId: plan.id,
            ...(credentials ? { protocolCredentials: credentials } : {}),
          },
        });
      assert.equal((await invoke(restored.id, creds)).isError, true);
      assert.equal((await invoke(p.id)).isError, true);
      assert.equal(seen.length, 6);
      const executed = await invoke(p.id, creds);
      assert.notEqual(executed.isError, true, executed.content[0].text);
      assert.equal(JSON.parse(executed.content[0].text).status, "passed");
      assert.equal(seen.length, 8);
    } finally {
      await client.close();
    }
    const sessionURL = app.url + "/api/projects/" + p.id + "/protocol-sessions";
    const missingSession = await fetch(sessionURL, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ definitionId: sse.id }),
    });
    assert.equal(missingSession.status, 400);
    assert.equal(seen.length, 8);
    const started = await fetch(sessionURL, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        definitionId: sse.id,
        headers: { Authorization: "Bearer runtime-token" },
      }),
    });
    assert.equal(started.status, 200);
    const session = await started.json();
    const deadline = Date.now() + 3000;
    let state;
    do {
      state = await (
        await fetch(sessionURL + "/" + session.id, { headers: ownerHeaders })
      ).json();
      if (state.state === "closed") break;
      await new Promise((r) => setTimeout(r, 10));
    } while (Date.now() < deadline);
    assert.equal(state.state, "closed");
    const finalized = await (
      await fetch(sessionURL + "/" + session.id + "/stop", {
        method: "POST",
        headers: ownerHeaders,
        body: "{}",
      })
    ).json();
    assert.equal(finalized.recordSaved, true);
    assert.equal(seen.length, 9);
    assert.equal(seen.at(-1).headers.accept, "text/event-stream");
    const saved = await app.store.get(p.id);
    assert.doesNotMatch(
      JSON.stringify(saved),
      /SOURCE-.*?-SECRET|DISABLED-SECRET|BLANK-SECRET|WHITESPACE-SECRET|runtime-token|runtime-custom|fixtureCookie=a b/,
    );
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    app = await createApp({ root, port: 0 });
    assert.deepEqual((await app.store.get(p.id)).protocols, p.protocols);
    assert.equal(
      (await new Store(root).get(restored.id)).protocolRuns.length,
      2,
    );
  },
);
test("handshake bounds, case collisions, safe persistence and old definition shape stay strict", () => {
  const old = normalizeProtocol({ type: "sse", url: "http://localhost/" });
  assert.equal(Object.hasOwn(old, "handshake"), false);
  assert.throws(
    () => normalizeHandshake({ headers: { Authorization: "secret" } }, "sse"),
    /运行时/,
  );
  for (const headers of [
    { Accept: "a", accept: "b" },
    { "sec-websocket-key": "x" },
    { Host: "evil" },
    { "X-Test": "bad\r\nvalue" },
  ])
    assert.throws(() => resolveHandshake({ type: "sse" }, headers));
  assert.deepEqual(
    resolveHandshake(
      {
        type: "sse",
        handshake: {
          headers: { accept: "a" },
          requiredHeaders: ["authorization"],
        },
      },
      { ACCEPT: "b", Authorization: "token" },
    ),
    { accept: "b", authorization: "token" },
  );
  assert.throws(
    () =>
      resolveHandshake(
        {
          type: "sse",
          handshake: { headers: {}, requiredHeaders: ["authorization"] },
        },
        { authorization: " " },
      ),
    /缺少/,
  );
  assert.throws(
    () =>
      normalizeHandshake(
        { headers: {}, requiredHeaders: ["Cookie", "cookie"] },
        "websocket",
      ),
    /重复/,
  );
});

test("handshake validation budgets include required names and SSE default Accept", () => {
  const required = Array.from({ length: 50 }, (_, i) => "x-" + i);
  assert.throws(
    () => normalizeHandshake({ headers: {}, requiredHeaders: required }, "sse"),
    /超限/,
  );
  assert.throws(
    () =>
      normalizeHandshake(
        { headers: { accept: "text/plain" }, requiredHeaders: required },
        "websocket",
      ),
    /超限/,
  );
  assert.throws(
    () =>
      normalizeHandshake(
        { headers: {}, requiredHeaders: ["x-" + "a".repeat(8200)] },
        "websocket",
      ),
    /超限/,
  );
  assert.throws(
    () =>
      resolveHandshake(
        { type: "sse" },
        Object.fromEntries(required.map((k) => [k, "x"])),
      ),
    /超限/,
  );
});
