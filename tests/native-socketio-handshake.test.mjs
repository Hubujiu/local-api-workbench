import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Server } from "socket.io";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import {
  importIntoProject,
  restoreProject,
  runPlan,
  snapshotPlan,
} from "../src/core.mjs";
import { executeSocketIOFlow } from "../src/socketio-plan.mjs";
import { extendedProtocolFixture } from "./fixtures/apipost-extended-protocols.mjs";
test(
  "native Socket.IO handshake inputs preserve frozen events with ephemeral credentials over SDK and restart",
  { timeout: 20000 },
  async (t) => {
    const seen = [],
      server = http.createServer(),
      io = new Server(server, { maxHttpBufferSize: 65536 });
    io.on("connection", (s) => {
      seen.push(s.handshake.headers);
      s.on("fixture", (data, ack) => ack({ ok: true, data }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const root = await mkdtemp(path.join(os.tmpdir(), "socketio-handshake-"));
    let app = await createApp({ root, port: 0 });
    const client = new Client(
      { name: "socketio-handshake-fixture", version: "1" },
      { capabilities: {} },
    );
    t.after(async () => {
      await client.close().catch(() => {});
      await new Promise((r) => io.close(r));
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const source = extendedProtocolFixture({
      socketio: `http://127.0.0.1:${server.address().port}`,
    });
    source.apis = source.apis.filter((n) => n.target_type === "socketio");
    source.apis[0].request.header.parameter = [
      { key: "X-Fixture", value: "SOURCE-SECRET", is_checked: 1 },
      { key: "User-Agent", value: "FixtureAgent", is_checked: 1 },
    ];
    source.apis[0].request.cookie.parameter = [
      { key: "fixtureCookie", value: "COOKIE-SECRET", is_checked: 1 },
    ];
    const original = JSON.stringify(source),
      p = await app.store.create("Socket.IO");
    importIntoProject(p, source);
    await app.store.save(p);
    assert.equal(JSON.stringify(source), original);
    assert.doesNotMatch(JSON.stringify(p), /SOURCE-SECRET|COOKIE-SECRET/);
    const plan = p.plans[0],
      definition = plan.steps[0].socketio.definition;
    assert.deepEqual(definition.handshake.requiredHeaders, [
      "cookie",
      "x-fixture",
    ]);
    const credentials = {
      [plan.steps[0].id]: {
        headers: {
          "X-Fixture": "runtime-value",
          Cookie: "fixtureCookie=a b%2F",
        },
      },
    };
    let sent = 0;
    await assert.rejects(
      runPlan(
        snapshotPlan({
          name: "Zero network",
          steps: [{ request: { url: "http://127.0.0.1:1" } }, ...plan.steps],
        }),
        {},
        async () => {
          sent++;
          return {};
        },
        { executeSocketIO: executeSocketIOFlow },
      ),
      /缺少协议运行时Header/,
    );
    assert.equal(sent, 0);
    assert.equal(seen.length, 0);
    const restored = restoreProject(p);
    await app.store.save(restored);
    const ownerHeaders = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
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
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    const call = (projectId, creds) =>
      client.callTool({
        name: "localapi_execute_flow",
        arguments: {
          projectId,
          planId: plan.id,
          ...(creds ? { socketioCredentials: creds } : {}),
        },
      });
    assert.equal((await call(restored.id, credentials)).isError, true);
    assert.equal((await call(p.id)).isError, true);
    assert.equal(seen.length, 0);
    const result = await call(p.id, credentials);
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.equal(JSON.parse(result.content[0].text).status, "passed");
    const local = await runPlan(restored.plans[0], {}, () => {}, {
      executeSocketIO: executeSocketIOFlow,
      socketioCredentials: credentials,
    });
    assert.equal(local.status, "passed");
    assert.equal(seen.length, 2);
    for (const headers of seen) {
      assert.equal(headers["x-fixture"], "runtime-value");
      assert.equal(headers.cookie, "fixtureCookie=a b%2F");
      assert.equal(headers["user-agent"], "FixtureAgent");
    }
    const saved = await app.store.get(p.id);
    assert.doesNotMatch(
      JSON.stringify(saved),
      /SOURCE-SECRET|COOKIE-SECRET|runtime-value|fixtureCookie=a b/,
    );
    await client.close();
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    app = await createApp({ root, port: 0 });
    assert.deepEqual(
      (await app.store.get(p.id)).settings.socketioDefinitions,
      p.settings.socketioDefinitions,
    );
    assert.equal((await app.store.get(p.id)).runs.length, 1);
  },
);

test(
  "explicit Accept survives real v2 and v4 polling handshakes and acknowledgments",
  { timeout: 10000 },
  async (t) => {
    const seen = [],
      server = http.createServer(),
      io = new Server(server, { allowEIO3: true });
    io.on("connection", (s) => {
      seen.push(s.handshake.headers.accept);
      s.on("fixture", (data, ack) => ack({ ok: true }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((r) => io.close(r)));
    for (const version of [2, 4]) {
      const result = await executeSocketIOFlow({
        definition: {
          id: "io" + version,
          url: `http://127.0.0.1:${server.address().port}`,
          version,
          transport: "polling",
          handshake: {
            headers: { accept: "application/x-fixture" },
            requiredHeaders: [],
          },
        },
        commands: [
          {
            type: "emit",
            event: "fixture",
            args: ["message"],
            ackTimeoutMs: 1000,
          },
        ],
        timeoutMs: 3000,
      });
      assert.equal(result.status, "passed");
    }
    assert.deepEqual(seen, ["application/x-fixture", "application/x-fixture"]);
  },
);
