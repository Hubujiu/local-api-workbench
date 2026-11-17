import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { openWebSocket } from "../src/websocket-client.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";
const cwd = fileURLToPath(new URL("..", import.meta.url));
async function cli(root, projectId, planId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/run-plan.mjs", "--project", projectId, "--plan", planId],
      {
        cwd,
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("CLI timeout"));
    }, 15000);
    child.stdout.on("data", (b) => {
      out += b;
      if (Buffer.byteLength(out) > 2 * 1024 * 1024) {
        child.kill();
        reject(Error("CLI output limit"));
      }
    });
    child.stderr.on("data", (b) => {
      err += b;
      if (Buffer.byteLength(err) > 16384) {
        child.kill();
        reject(Error("CLI stderr limit"));
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, err);
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}
for (const transport of ["http", "stdio"])
  for (const format of ["apipost", "apipost-directory"])
    test(
      `WS complete group ${transport}/${format}: two generations, owner SDK CLI frozen backup restart`,
      { timeout: 30000 },
      async (t) => {
        const root = await mkdtemp(path.join(tmpdir(), "ws-export-")),
          seen = [];
        const peer = http.createServer(),
          wss = new WebSocketServer({ server: peer });
        wss.on("connection", (socket, req) =>
          socket.on("message", (data, binary) => {
            seen.push({
              text: data.toString(),
              binary,
              header: req.headers["accept-language"],
              url: req.url,
              auth: req.headers.authorization,
            });
            socket.send(data, { binary: false }, () =>
              socket.close(1000, "echo complete"),
            );
          }),
        );
        peer.listen(0, "127.0.0.1");
        await once(peer, "listening");
        let app = await createApp({ root, port: 0 });
        const clients = [];
        async function stop() {
          app.server.closeAllConnections();
          await new Promise((r) => app.server.close(r));
        }
        t.after(async () => {
          await Promise.all(clients.map((c) => c.close().catch(() => {})));
          await stop();
          for (const s of wss.clients) s.terminate();
          await new Promise((r) => wss.close(r));
          await new Promise((r) => peer.close(r));
          await rm(root, { recursive: true, force: true });
        });
        const call = async (route, body, status = 200) => {
          const r = await fetch(app.url + route, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const value = await r.json();
          assert.equal(r.status, status, JSON.stringify(value));
          return value;
        };
        const source = nativeProtocolFixture({
          ws: `ws://127.0.0.1:${peer.address().port}/echo?x=one&x=one&raw=%2f`,
        });
        source.apis = [source.apis[0]];
        source.apis[0].request.query.parameter.push(
          { key: "x", value: "one", is_checked: 1 },
          { key: "raw", value: "/", is_checked: 1 },
          { key: "extra", value: "雪 /+", is_checked: 1 },
        );
        source.apis[0].request.header.parameter = [
          { key: "Accept-Language", value: "zh-CN", is_checked: 1 },
        ];
        source.apis[0].message.push({
          param_id: "second",
          name: "Unicode",
          request: { mode: "text", raw: "雪😀 second" },
          response: { mode: "text", raw: "inert example" },
        });
        source.apis[0].message.push({
          param_id: "empty",
          name: "Empty text",
          request: { mode: "text", raw: "" },
          response: { mode: "text", raw: "inert empty example" },
        });
        const original = structuredClone(source),
          p = await app.store.create("source"),
          other = await app.store.create("other");
        await call(`/api/projects/${p.id}/import`, { document: source });
        const before = await app.store.get(p.id),
          untouched = await app.store.get(other.id);
        let current = p;
        for (let generation = 0; generation < 2; generation++) {
          const document = await call(
              `/api/projects/${current.id}/export?format=${format}`,
            ),
            next = await app.store.create("generation");
          await call(`/api/projects/${next.id}/import`, { document });
          current = next;
        }
        assert.equal(seen.length, 0, "conversion never executes");
        const saved = await app.store.get(current.id);
        assert.equal(saved.protocols[2].sendEmptyMessage, true);
        assert.equal(saved.protocols[2].templateMode, undefined);
        assert.deepEqual(
          saved.settings.apipostProtocolSources[0].source.message,
          source.apis[0].message,
        );
        const plan = await call(`/api/projects/${current.id}/plans`, {
          name: "frozen WS group",
          steps: saved.protocols.map((d) => ({
            type: "protocol",
            protocol: { definitionId: d.id, duration: 1000 },
          })),
        });
        const runIds = [];
        function verify(run) {
          assert.equal(run.status, "passed", JSON.stringify(run));
          assert.equal(run.recordSaved, true);
          assert.deepEqual(run.snapshot.steps, plan.steps);
          assert.equal(run.results.length, 3);
          for (const result of run.results) {
            assert.equal(result.status, "passed");
            assert.equal(result.protocolResult.result.messages.length, 1);
          }
          runIds.push(run.id);
        }
        verify(
          await call(`/api/projects/${current.id}/run`, { planId: plan.id }),
        );
        const client = new Client(
          { name: "ws-export", version: "1" },
          { capabilities: {} },
        );
        clients.push(client);
        if (transport === "http") {
          const config = await call("/api/mcp/config", {
            enabled: true,
            projects: [current.id],
            write: true,
            execute: true,
            remember: false,
          });
          await client.connect(
            new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
              requestInit: {
                headers: { Authorization: "Bearer " + config.token },
              },
            }),
          );
        } else
          await client.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [
                path.join(cwd, "src/mcp.mjs"),
                "--project",
                current.id,
                "--write",
                "--execute",
              ],
              env: { LOCAL_API_DATA: root },
              stderr: "pipe",
            }),
          );
        const result = await client.callTool({
          name: "localapi_run_plan",
          arguments: { projectId: current.id, planId: plan.id },
        });
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        verify(JSON.parse(result.content[0].text));
        assert.equal(
          (
            await client.callTool({
              name: "localapi_run_plan",
              arguments: { projectId: other.id, planId: plan.id },
            })
          ).isError,
          true,
        );
        await client.close();
        const live = await app.store.get(current.id);
        for (const d of live.protocols) {
          d.url = "ws://127.0.0.1:1/changed";
          d.message = "live-edited";
        }
        await app.store.save(live);
        const count = seen.length;
        for (const f of ["apipost", "apipost-directory"])
          await call(
            `/api/projects/${current.id}/export?format=${f}`,
            undefined,
            400,
          );
        assert.equal(seen.length, count);
        verify(await cli(root, current.id, plan.id));
        const backup = await call(`/api/projects/${current.id}/export`),
          restored = await call("/api/restore", { document: backup }, 201);
        await stop();
        app = await createApp({ root, port: 0 });
        assert.equal(seen.length, 9, "restart does not replay");
        verify(await cli(root, restored.id, plan.id));
        assert.equal(seen.length, 12);
        assert.deepEqual(
          seen.map((v) => v.text),
          Array.from({ length: 4 }, () => [
            "wire-payload",
            "雪😀 second",
            "",
          ]).flat(),
        );
        for (const item of seen) {
          assert.equal(item.binary, false);
          assert.equal(item.header, "zh-CN");
          assert.equal(
            item.url,
            "/echo?x=one&x=one&raw=%2f&extra=%E9%9B%AA+%2F%2B",
          );
          assert.equal(item.auth, undefined);
        }
        const disk = await new Store(root).get(restored.id);
        assert.deepEqual(disk.runs.map((r) => r.id).sort(), runIds.sort());
        assert.deepEqual(disk.plans, backup.plans);
        assert.deepEqual(await new Store(root).get(other.id), untouched);
        assert.deepEqual(await new Store(root).get(p.id), before);
        assert.deepEqual(source, original);
      },
    );

test(
  "plaintext WS redirect toward WSS never connects to target",
  { timeout: 10000 },
  async (t) => {
    let connections = 0,
      requests = 0;
    const target = http.createServer();
    target.on("connection", () => connections++);
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const source = http.createServer((req, res) => {
      requests++;
      res.writeHead(302, {
        Location: `wss://127.0.0.1:${target.address().port}/upgrade`,
      });
      res.end();
    });
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    t.after(async () => {
      await Promise.all([
        new Promise((r) => source.close(r)),
        new Promise((r) => target.close(r)),
      ]);
    });
    const socket = openWebSocket({
      url: `ws://127.0.0.1:${source.address().port}/`,
    });
    const [error] = await once(socket, "error");
    assert.match(error.message, /302/);
    assert.equal(requests, 1);
    assert.equal(connections, 0);
  },
);
