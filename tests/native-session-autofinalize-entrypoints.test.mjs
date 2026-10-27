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
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { validateWireSessionRecord } from "../src/wire-session-evidence.mjs";
import { protocolEvidenceHash } from "../src/wire-evidence.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";
const template = "{{租户}}|{{zero}}|{{no}}",
  grant = "Bearer fictional-session-transient";
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw Error("native session acceptance deadline");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function decode(r) {
  assert.equal(r.isError, undefined, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
}
test(
  "native template remote sessions auto-save before read-only SDK history and inert restore",
  { timeout: 30000 },
  async (t) => {
    const seen = [],
      sockets = new Set(),
      pending = [];
    let connections = 0;
    const tcp = net.createServer((s) => {
      connections++;
      sockets.add(s);
      s.on("error", () => {});
      s.on("close", () => sockets.delete(s));
      s.once("data", (b) => {
        seen.push(b.toString());
        s.end(b);
      });
    });
    const upstream = http.createServer(async (req, res) => {
      connections++;
      let body = "";
      for await (const b of req) body += b;
      assert.equal(req.headers.authorization, grant);
      seen.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      pending.push(() => res.end("data: " + body + "\n\n"));
    });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (s, req) => {
      connections++;
      assert.equal(req.headers.authorization, grant);
      s.on("error", () => {});
      s.once("message", (b) => {
        seen.push(b.toString());
        s.send(b.toString(), () => s.close());
      });
    });
    tcp.listen(0, "127.0.0.1");
    upstream.listen(0, "127.0.0.1");
    await Promise.all([once(tcp, "listening"), once(upstream, "listening")]);
    const root = await mkdtemp(path.join(tmpdir(), "native-auto-session-"));
    let app = await createApp({ root, port: 0 });
    const closeApp = async () => {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
    };
    t.after(async () => {
      await closeApp();
      for (const s of sockets) s.destroy();
      for (const s of wss.clients) s.terminate();
      await new Promise((r) => wss.close(r));
      upstream.closeAllConnections();
      await Promise.all([
        new Promise((r) => tcp.close(r)),
        new Promise((r) => upstream.close(r)),
      ]);
      await rm(root, { recursive: true, force: true });
    });
    const request = async (route, body, method = "POST") => {
      const r = await fetch(app.url + route, {
        method,
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, value: await r.json() };
    };
    const projects = [];
    for (const tenant of ["alpha", "beta"]) {
      const p = await app.store.create(tenant);
      const source = nativeProtocolFixture({
        ws: `ws://127.0.0.1:${upstream.address().port}/echo?x=one`,
        tcp: `127.0.0.1:${tcp.address().port}`,
        sse: `http://127.0.0.1:${upstream.address().port}/events?x=one`,
      });
      source.apis[0].message[0].request.raw = template;
      source.apis[2].request.body.raw = template;
      source.apis[3].request.body.raw = template;
      for (const i of [0, 3])
        source.apis[i].request.header.parameter.push({
          key: "Authorization",
          value: "Bearer fictional-source-discard",
          is_checked: 1,
        });
      const original = JSON.stringify(source);
      const imported = await request(`/api/projects/${p.id}/import`, {
        document: source,
      });
      assert.equal(imported.status, 200, JSON.stringify(imported));
      assert.equal(JSON.stringify(source), original);
      const saved = await app.store.get(p.id);
      saved.globalVariables = { unused: "unused-session-context-secret" };
      saved.environments[0].variables = { 租户: tenant, zero: 0, no: false };
      saved.environments.push({
        id: "alternate",
        name: "alternate",
        variables: { 租户: "alternate" },
      });
      await app.store.save(saved);
      assert.doesNotMatch(JSON.stringify(saved), /fictional-source-discard/);
      projects.push({ ...saved, tenant });
    }
    const excluded = await app.store.create("excluded");
    assert.equal(connections, 0, "import must not connect");
    const ids = new Map(projects.map((p) => [p.id, []]));
    for (const p of projects)
      for (const definition of p.protocols) {
        const prefix = `/api/projects/${p.id}/protocol-sessions`;
        const reset = await app.store.get(p.id);
        reset.protocols = structuredClone(p.protocols);
        reset.environments = structuredClone(p.environments);
        await app.store.save(reset);
        const opened = await request(prefix, {
          definitionId: definition.id,
          environmentId: p.environments[0].id,
          ...(definition.type === "tcp"
            ? {}
            : { headers: { Authorization: grant } }),
        });
        assert.equal(opened.status, 200, JSON.stringify(opened));
        const id = opened.value.id;
        ids.get(p.id).push(id);
        await until(
          async () =>
            (await request(`${prefix}/${id}`, undefined, "GET")).value.state ===
            "open",
        );
        const changed = await app.store.get(p.id);
        changed.currentEnvironmentId = "alternate";
        changed.environments[0].variables.租户 = "edited-after-open";
        for (const d of changed.protocols)
          if (d.type === "sse") d.body = "edited-live";
          else d.message = "edited-live";
        await app.store.save(changed);
        assert.equal(
          (
            await request(
              `/api/projects/${excluded.id}/protocol-sessions/${id}`,
              undefined,
              "GET",
            )
          ).status,
          400,
        );
        if (definition.type === "sse") {
          await until(() => pending.length > 0);
          pending.shift()();
        } else
          assert.equal((await request(`${prefix}/${id}/send`, {})).status, 200);
        // Deliberately never call /stop: disk proof must come from remote completion.
        await until(async () =>
          (await new Store(root).get(p.id)).protocolRuns.some(
            (r) => r.id === id,
          ),
        );
        const records = (await new Store(root).get(p.id)).protocolRuns.filter(
          (r) => r.id === id,
        );
        assert.equal(records.length, 1);
        const record = records[0];
        validateWireSessionRecord(record);
        assert.equal(record.mode, "session");
        assert.equal(record.status, "completed");
        assert.equal(record.result.closeReason, "remote");
        assert.equal(
          record.templateProvenance.environmentId,
          p.environments[0].id,
        );
        assert.equal(
          record.templateProvenance.sourceDefinitionHash,
          protocolEvidenceHash(definition),
        );
        assert(
          record.result.events.some(
            (e) =>
              e.direction === "received" &&
              e.data.includes(`${p.tenant}|0|false`),
          ),
        );
        if (definition.type !== "sse")
          assert(
            record.result.events.some(
              (e) => e.direction === "sent" && e.data === `${p.tenant}|0|false`,
            ),
          );
        assert.equal(seen.at(-1), `${p.tenant}|0|false`);
        await until(
          async () =>
            (await request(`${prefix}/${id}`, undefined, "GET")).value
              .recordSaved === true,
        );
        const terminal = (await request(`${prefix}/${id}`, undefined, "GET"))
          .value;
        assert.equal(terminal.recordId, id);
        assert.equal(terminal.closeReason, "remote");
      }
    assert.equal(connections, 6);
    const persisted = new Map();
    for (const p of projects) {
      const saved = await new Store(root).get(p.id);
      assert.deepEqual(
        saved.protocolRuns.map((r) => r.id).sort(),
        ids.get(p.id).sort(),
      );
      assert.doesNotMatch(
        JSON.stringify(saved.protocolRuns),
        /fictional-session-transient|fictional-source-discard|unused-session-context-secret|edited-after-open|edited-live|templateContext/,
      );
      persisted.set(p.id, saved.protocolRuns);
    }
    async function history(transport, allowed) {
      const client = new Client(
        { name: "native-session-history", version: "1" },
        { capabilities: {} },
      );
      try {
        if (transport === "http") {
          const config = await request("/api/mcp/config", {
            enabled: true,
            projects: allowed,
            write: false,
            execute: false,
            remember: false,
          });
          assert.equal(config.status, 200);
          await client.connect(
            new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
              requestInit: {
                headers: { Authorization: "Bearer " + config.value.token },
              },
            }),
          );
        } else {
          const channel = new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
              ...allowed.flatMap((id) => ["--project", id]),
            ],
            env: { LOCAL_API_DATA: root },
            stderr: "pipe",
          });
          channel.stderr.resume();
          await client.connect(channel);
        }
        const call = (name, args) =>
          client.callTool({ name: "localapi_" + name, arguments: args });
        for (const projectId of allowed) {
          const listed = decode(
            await call("list_protocol_runs", { projectId }),
          );
          assert.deepEqual(
            listed.map((r) => r.id).sort(),
            persisted
              .get(projectId)
              .map((r) => r.id)
              .sort(),
          );
          for (const record of persisted.get(projectId))
            assert.deepEqual(
              decode(
                await call("get_protocol_run", {
                  projectId,
                  recordId: record.id,
                }),
              ),
              record,
            );
        }
        assert.equal(
          (await call("list_protocol_runs", { projectId: excluded.id }))
            .isError,
          true,
        );
        assert.equal(
          (
            await call("get_protocol_run", {
              projectId: allowed[0],
              recordId: ids.get(projects[1].id)[0],
            })
          ).isError,
          true,
        );
      } finally {
        await client.close();
      }
    }
    await history(
      "http",
      projects.map((p) => p.id),
    );
    await history(
      "stdio",
      projects.map((p) => p.id),
    );
    const backup = await request(
      `/api/projects/${projects[0].id}/export`,
      undefined,
      "GET",
    );
    assert.equal(backup.status, 200);
    const restored = await request("/api/restore", { document: backup.value });
    assert.equal(restored.status, 201, JSON.stringify(restored));
    assert.deepEqual(
      restored.value.protocolRuns,
      persisted.get(projects[0].id),
    );
    persisted.set(restored.value.id, restored.value.protocolRuns);
    await closeApp();
    app = await createApp({ root, port: 0 });
    for (const p of projects) {
      assert.deepEqual(
        (await new Store(root).get(p.id)).protocolRuns,
        persisted.get(p.id),
      );
      for (const id of ids.get(p.id))
        assert.equal(
          (
            await request(
              `/api/projects/${p.id}/protocol-sessions/${id}`,
              undefined,
              "GET",
            )
          ).status,
          400,
        );
    }
    await history("http", [restored.value.id]);
    await history("stdio", [restored.value.id]);
    assert.deepEqual((await new Store(root).get(excluded.id)).protocolRuns, []);
    assert.equal(
      connections,
      6,
      "history, restore and restart never replay network sessions",
    );
  },
);
