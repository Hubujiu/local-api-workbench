import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";

for (const mode of ["owner", "SDK HTTP", "SDK stdio", "CLI"])
  test(
    `${mode} WebSocket runtime rows freeze references and rows, reuse transient leaf credentials and persist receipts`,
    { timeout: 20000 },
    async (t) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "websocket-row-workflow-"),
      );
      const received = [],
        consumed = [],
        sockets = new Set();
      let connections = 0,
        requests = 0;
      const websocket = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      websocket.on("connection", (socket, request) => {
        connections++;
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => sockets.delete(socket));
        socket.once("message", (data) => {
          const message = data.toString();
          received.push({
            message,
            authorization: request.headers.authorization,
          });
          socket.send(`reply-${message}`);
          socket.close(1000, "done");
        });
      });
      const peer = http.createServer((req, res) => {
        requests++;
        if (req.url === "/consume") consumed.push(req.headers["x-reply"]);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            items:
              req.url === "/produce"
                ? [{ value: "a" }, { value: "b" }]
                : [{ value: "replacement" }],
          }),
        );
      });
      await Promise.all([
        new Promise((r) => websocket.on("listening", r)),
        new Promise((r) => peer.listen(0, "127.0.0.1", r)),
      ]);
      const app = await createApp({ root, port: 0 });
      let client;
      t.after(async () => {
        await client?.close();
        app.server.closeAllConnections();
        peer.closeAllConnections();
        for (const socket of sockets) socket.terminate();
        await Promise.all(
          [app.server, websocket, peer].map(
            (s) => new Promise((r) => s.close(r)),
          ),
        );
        await rm(root, { recursive: true, force: true });
      });
      const p = await app.store.create("WebSocket runtime rows workflow");
      const websocketURL = `ws://127.0.0.1:${websocket.address().port}`;
      p.protocols.push({
        id: "saved-websocket",
        name: "saved WebSocket",
        type: "websocket",
        url: websocketURL,
        duration: 1000,
        handshake: { requiredHeaders: ["authorization"] },
      });
      await app.store.save(p);
      const owner = async (route, body) => {
        const response = await fetch(`${app.url}/api/${route}`, {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      };
      const url = `http://127.0.0.1:${peer.address().port}`;
      const made = await owner(`projects/${p.id}/plans`, {
        name: "WebSocket rows",
        steps: [
          {
            id: "producer",
            request: {
              url: `${url}/produce`,
              extract: [{ name: "items", source: "json", path: "$.items" }],
            },
          },
          {
            id: "rows",
            type: "repeat",
            rowsFrom: { scope: "runtime", name: "items" },
            maxRows: 3,
            steps: [
              {
                id: "wire",
                type: "protocol",
                protocol: {
                  definitionId: "saved-websocket",
                  message: "{{value}}",
                },
                protocolScripts: {
                  version: 1,
                  before: "apt.setVar('value', pm.iterationData.get('value'));",
                  after:
                    "pm.test('row reply', () => pm.expect(wire.result.result.messages[0].data).to.equal('reply-' + pm.iterationData.get('value')));",
                },
                extract: [{ name: "reply", path: "$.messages[0].data" }],
              },
              {
                id: "consume",
                request: {
                  url: `${url}/consume`,
                  headers: [{ key: "X-Reply", value: "{{reply}}" }],
                  // Replacing the source cannot change this group's already frozen rows.
                  extract: [{ name: "items", source: "json", path: "$.items" }],
                },
              },
            ],
          },
        ],
      });
      assert.equal(made.status, 200, JSON.stringify(made.value));
      const plan = made.value;
      const edited = await app.store.get(p.id);
      edited.protocols[0].url = "ws://127.0.0.1:1";
      await app.store.save(edited);

      if (mode.startsWith("SDK")) {
        client = new Client({ name: "websocket-row-review", version: "1.0.0" });
        let transport;
        if (mode === "SDK HTTP") {
          const config = await owner("mcp/config", {
            enabled: true,
            projects: [p.id],
            write: true,
            execute: true,
            remember: false,
          });
          assert.equal(config.status, 200);
          transport = new StreamableHTTPClientTransport(
            new URL(app.url + "/mcp"),
            {
              requestInit: {
                headers: { Authorization: "Bearer " + config.value.token },
              },
            },
          );
        } else
          transport = new StdioClientTransport({
            command: process.execPath,
            args: [
              path.resolve(import.meta.dirname, "../src/mcp.mjs"),
              "--project",
              p.id,
              "--write",
              "--execute",
            ],
            env: { ...process.env, LOCAL_API_DATA: root },
            stderr: "pipe",
          });
        await client.connect(transport, { timeout: 5000 });
      }
      const invoke = async (protocolCredentials) => {
        const args = {
          projectId: p.id,
          planId: plan.id,
          ...(protocolCredentials ? { protocolCredentials } : {}),
        };
        if (mode === "owner") {
          const result = await owner(`projects/${p.id}/run`, args);
          return { ok: result.status === 200, run: result.value };
        }
        if (client) {
          const result = await client.callTool(
            { name: "localapi_run_plan", arguments: args },
            undefined,
            { timeout: 10000 },
          );
          return {
            ok: result.isError !== true,
            run: result.isError ? result : JSON.parse(result.content[0].text),
          };
        }
        return new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "scripts/run-plan.mjs",
              "--project",
              p.id,
              "--plan",
              plan.id,
              "--credentials-stdin",
            ],
            {
              cwd: path.resolve(import.meta.dirname, ".."),
              env: { ...process.env, LOCAL_API_DATA: root },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          let stdout = "",
            stderr = "";
          const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
          child.stdout.on("data", (x) => (stdout += x));
          child.stderr.on("data", (x) => (stderr += x));
          child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child.stdin.on("error", () => {});
          child.stdin.end(
            JSON.stringify(protocolCredentials ? { protocolCredentials } : {}),
          );
          child.on("close", (code) => {
            clearTimeout(timer);
            try {
              resolve({
                ok: code === 0,
                run: code === 0 ? JSON.parse(stdout) : stderr + stdout,
              });
            } catch (e) {
              reject(e);
            }
          });
        });
      };
      for (const credentials of [
        undefined,
        { '["rows","wire",0]': {} },
        { wire: { headers: { Host: "forbidden" } } },
      ]) {
        assert.equal((await invoke(credentials)).ok, false);
        assert.equal(connections, 0);
        assert.equal(requests, 0);
      }
      const secrets = [
        "Bearer rows-private-first",
        "Bearer rows-private-second",
      ];
      const runs = [];
      for (const secret of secrets) {
        const outcome = await invoke({
          wire: { headers: { Authorization: secret } },
        });
        assert.equal(outcome.ok, true, JSON.stringify(outcome.run));
        const run = outcome.run;
        runs.push(run);
        assert.equal(run.status, "passed", JSON.stringify(run));
        assert.equal(run.recordSaved, true);
        assert.equal(run.recordId, run.id);
        assert.equal(run.variables.reply, "reply-b");
        assert.deepEqual(run.variables.items, [{ value: "replacement" }]);
        assert.equal(run.results.length, 5);
        assert.deepEqual(
          run.results.slice(1).map((r) => [r.stepId, r.repeat.iteration]),
          [
            ["wire", 0],
            ["consume", 0],
            ["wire", 1],
            ["consume", 1],
          ],
        );
        assert.equal(
          new Set(run.results.slice(1).map((r) => r.repeat.occurrenceId)).size,
          4,
        );
        assert.equal(
          run.snapshot.steps[1].steps[0].protocol.definitionId,
          undefined,
        );
        assert.equal(
          run.snapshot.steps[1].steps[0].protocol.definition.url,
          websocketURL,
        );
        assert.deepEqual(received.slice(-2), [
          { message: "a", authorization: secret },
          { message: "b", authorization: secret },
        ]);
        assert.deepEqual(consumed.slice(-2), ["reply-a", "reply-b"]);
        assert.equal(connections, runs.length * 2);
        const stored = await new Store(root).get(p.id);
        const receipt = stored.runs.find((r) => r.id === run.id);
        assert.deepEqual(receipt.results, run.results);
        assert.deepEqual(receipt.snapshot, run.snapshot);
        for (const credential of secrets) {
          assert.ok(!JSON.stringify(run).includes(credential));
          assert.ok(!JSON.stringify(stored).includes(credential));
        }
        const priorRequests = requests;
        assert.equal((await invoke()).ok, false); // No credentials survive into a later invocation.
        assert.equal(requests, priorRequests);
        assert.equal(connections, runs.length * 2);
      }
      assert.equal(runs[0].planHash, runs[1].planHash);
      assert.equal((await new Store(root).get(p.id)).runs.length, 2);
    },
  );
