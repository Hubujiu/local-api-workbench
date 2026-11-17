import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";

for (const mode of ["owner", "SDK HTTP", "SDK stdio", "CLI"])
  test(
    `${mode} TCP runtime rows freeze references, transfer variables and persist receipts`,
    { timeout: 20000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "tcp-row-workflow-"));
      const received = [],
        sockets = new Set();
      const tcp = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => sockets.delete(socket));
        socket.once("data", (data) => {
          received.push(data.toString());
          socket.end(data);
        });
      });
      const peer = http.createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ items: [{ value: "a" }, { value: "b" }] }));
      });
      await Promise.all([
        new Promise((r) => tcp.listen(0, "127.0.0.1", r)),
        new Promise((r) => peer.listen(0, "127.0.0.1", r)),
      ]);
      const app = await createApp({ root, port: 0 });
      let client;
      t.after(async () => {
        await client?.close();
        app.server.closeAllConnections();
        peer.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await Promise.all(
          [app.server, tcp, peer].map((s) => new Promise((r) => s.close(r))),
        );
        await rm(root, { recursive: true, force: true });
      });
      const p = await app.store.create("TCP runtime rows workflow");
      p.protocols.push({
        id: "saved-tcp",
        name: "saved TCP",
        type: "tcp",
        url: "127.0.0.1",
        port: tcp.address().port,
        completion: "end",
        duration: 1000,
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
        const result = await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        return result;
      };
      const url = `http://127.0.0.1:${peer.address().port}`;
      const made = await owner(`projects/${p.id}/plans`, {
        name: "TCP rows",
        steps: [
          {
            id: "producer",
            request: {
              url,
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
                id: "bind",
                request: {
                  url,
                  beforeScript:
                    "pm.environment.set('value', pm.iterationData.get('value'));",
                },
              },
              {
                id: "tcp",
                type: "protocol",
                protocol: { definitionId: "saved-tcp", message: "{{value}}" },
                extract: [{ name: "reply", path: "$.body" }],
              },
            ],
          },
        ],
      });
      // Later project edits cannot redirect the saved plan's frozen transport.
      const edited = await app.store.get(p.id);
      edited.protocols[0].port = 1;
      await app.store.save(edited);
      let run;
      if (mode === "owner")
        run = await owner(`projects/${p.id}/run`, { planId: made.id });
      else if (mode === "CLI") {
        const result = await new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["scripts/run-plan.mjs", "--project", p.id, "--plan", made.id],
            {
              cwd: path.resolve(import.meta.dirname, ".."),
              env: { ...process.env, LOCAL_API_DATA: root },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "",
            stderr = "";
          const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
          child.stdout.on("data", (x) => (stdout += x));
          child.stderr.on("data", (x) => (stderr += x));
          child.on("error", reject);
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
          });
        });
        assert.equal(result.code, 0, result.stderr + result.stdout);
        run = JSON.parse(result.stdout);
      } else {
        client = new Client({ name: "tcp-row-review", version: "1.0.0" });
        let transport;
        if (mode === "SDK HTTP") {
          const config = await owner("mcp/config", {
            enabled: true,
            projects: [p.id],
            write: true,
            execute: true,
            remember: false,
          });
          transport = new StreamableHTTPClientTransport(
            new URL(app.url + "/mcp"),
            {
              requestInit: {
                headers: { Authorization: "Bearer " + config.token },
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
        const result = await client.callTool(
          {
            name: "localapi_run_plan",
            arguments: { projectId: p.id, planId: made.id },
          },
          undefined,
          { timeout: 10000 },
        );
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        run = JSON.parse(result.content[0].text);
      }
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.equal(run.recordSaved, true);
      assert.deepEqual(received, ["a", "b"]);
      assert.equal(run.variables.reply, "b");
      assert.equal(run.results.length, 5);
      assert.equal(
        run.snapshot.steps[1].steps[1].protocol.definitionId,
        undefined,
      );
      assert.equal(
        run.snapshot.steps[1].steps[1].protocol.definition.port,
        tcp.address().port,
      );
      const stored = await app.store.get(p.id);
      assert.equal(stored.runs.length, 1);
      assert.deepEqual(stored.runs[0].results, run.results);
      assert.deepEqual(stored.runs[0].snapshot, run.snapshot);
    },
  );
