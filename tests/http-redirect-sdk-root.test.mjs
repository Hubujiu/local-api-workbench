// Cross-feature acceptance: real official SDK cancellation, redirect partial
// responses, persisted evidence chunks and native compatibility projection.
// All requests are script-free; no database, XML or VM workload is executed.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";
const repo = path.resolve(import.meta.dirname, "..");
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function waitFor(check, description) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw Error("Missing real server observation: " + description);
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// Observe only after the genuine runtime response callback has installed its
// consumers, and after an actual body chunk reached those consumers. No return
// values, timers, bytes, signals or outcomes are replaced.
function observePartialResponse(base, marker) {
  const original = http.request;
  http.request = function (...args) {
    if (args[0]?.href === base + "/partial" && typeof args[2] === "function") {
      const callback = args[2];
      args[2] = function (...responseArgs) {
        const output = Reflect.apply(callback, this, responseArgs);
        responseArgs[0].once("data", () => writeFileSync(marker, "received"));
        return output;
      };
    }
    return Reflect.apply(original, this, args);
  };
  return () => {
    http.request = original;
  };
}

async function readback(client, projectId, run) {
  const call = (name, args) =>
    client.callTool({
      name: "localapi_" + name,
      arguments: { projectId, ...args },
    });
  const stored = decode(await call("get_execution_result", { runId: run.id }));
  assert.deepEqual(stored, run);
  const bytes = Buffer.from(JSON.stringify(run), "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const pieces = [];
  let offsetBytes = 0;
  do {
    const chunk = decode(
      await call("get_execution_result_chunk", {
        runId: run.id,
        offsetBytes,
        maxBytes: 1024,
        ...(offsetBytes ? { expectedSha256: hash } : {}),
      }),
    );
    assert.equal(chunk.sha256, hash);
    assert.equal(chunk.totalBytes, bytes.length);
    assert.equal(chunk.offsetBytes, offsetBytes);
    const piece = Buffer.from(chunk.data, "base64");
    assert.equal(piece.length, chunk.chunkBytes);
    assert(piece.length > 0 && piece.length <= 1024);
    pieces.push(piece);
    offsetBytes += piece.length;
    assert.equal(chunk.nextOffsetBytes, offsetBytes);
    assert.equal(chunk.eof, offsetBytes === bytes.length);
  } while (offsetBytes < bytes.length);
  assert(
    pieces.length > 1,
    "exercise digest-bound continuation rather than one chunk",
  );
  assert.deepEqual(Buffer.concat(pieces), bytes);
}

for (const kind of ["http", "stdio"])
  test(
    `${kind}: SDK cancellation after second-hop headers saves true partial response and native failures expose bounded projection`,
    { timeout: 25000 },
    async (t) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "redirect root SDK space#-"),
      );
      const marker = path.join(root, "partial-received");
      let client,
        restoreObserver = () => {},
        partial;
      const messages = [],
        wire = [],
        foreignWire = [];
      const foreign = http.createServer((req, res) => {
        foreignWire.push(req.url);
        res.end("not allowed");
      });
      await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
      const foreignURL = `http://127.0.0.1:${foreign.address().port}`;
      const prefix = '{"value":"actual partial';
      const origin = http.createServer((req, res) => {
        wire.push(req.url);
        if (req.url === "/start") {
          res.writeHead(302, { Location: "/partial" });
          res.end("first actual hop");
        } else if (req.url === "/partial") {
          partial = res;
          res.writeHead(404, {
            "Content-Type": "application/json",
            "x-actual-hop": "second",
          });
          res.write(prefix); // deliberately not end: client must cancel the real stream
        } else if (req.url === "/blocked") {
          res.writeHead(302, { Location: foreignURL + "/denied" });
          res.end("actual blocked redirect");
        } else res.end("healthy");
      });
      await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${origin.address().port}`;
      const app = await createApp({ root, port: 0 });
      const store = app.store;
      const project = await store.create("Redirect SDK root");
      const environmentId = project.environments[0].id;
      project.globalVariables = { guard: "unchanged" };
      const redirect = { mode: "same-origin", maxHops: 3 };
      project.plans = [
        snapshotPlan({
          id: "cancel-redirect",
          name: "Cancel real second-hop body",
          environmentId,
          steps: [
            {
              request: {
                id: "partial-request",
                name: "Partial",
                url: base + "/start",
                redirect,
                timeout: 15000,
                assertions: [{ target: "status", op: "eq", value: 404 }],
                extract: [{ name: "guard", path: "$.value", scope: "global" }],
                after: [{ type: "set", name: "late", value: "must-not-run" }],
              },
            },
            { request: { name: "Must not run", url: base + "/later" } },
          ],
        }),
        snapshotPlan({
          id: "native-blocked",
          name: "Native failure projection",
          environmentId,
          steps: [
            {
              expectedStatus: 302,
              request: {
                id: "blocked-request",
                name: "Blocked",
                url: base + "/blocked",
                redirect,
                assertions: [{ target: "status", op: "eq", value: 302 }],
              },
            },
          ],
        }),
      ];
      await store.save(project);
      async function owner(route, body) {
        const result = await fetch(app.url + route, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        assert(result.ok, await result.clone().text());
        return result.json();
      }
      t.after(async () => {
        partial?.destroy();
        await client?.close().catch(() => {});
        restoreObserver();
        // Drain the actual lifecycle before removing the Store directory.
        let error;
        try {
          await waitFor(
            async () =>
              !(await owner("/api/mcp/config")).activities.some(
                (row) => row.status === "running",
              ),
            "activity cleanup",
          );
        } catch (caught) {
          error = caught;
        }
        await Promise.all([close(app.server), close(origin), close(foreign)]);
        await rm(root, { recursive: true, force: true });
        if (error) throw error;
      });
      client = new Client({ name: "redirect-root-sdk", version: "1.0.0" });
      let transport;
      if (kind === "http") {
        restoreObserver = observePartialResponse(base, marker);
        const config = await owner("/api/mcp/config", {
          enabled: true,
          projects: [project.id],
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
      } else {
        const preload = path.join(root, "observe partial#.mjs");
        await writeFile(
          preload,
          `import http from 'node:http';\nimport {writeFileSync} from 'node:fs';\n(${observePartialResponse.toString()})(${JSON.stringify(base)},${JSON.stringify(marker)});\n`,
        );
        transport = new StdioClientTransport({
          command: process.execPath,
          args: [
            "--import",
            pathToFileURL(preload).href,
            path.join(repo, "src/mcp.mjs"),
            "--project",
            project.id,
            "--write",
            "--execute",
          ],
          env: { LOCAL_API_DATA: root },
          stderr: "pipe",
        });
        transport.stderr?.resume();
      }
      const originalSend = transport.send;
      transport.send = function (...args) {
        const pending = Reflect.apply(originalSend, this, args);
        messages.push(structuredClone(args[0]));
        return pending;
      };
      await client.connect(transport);
      const controller = new AbortController();
      const settled = client
        .callTool(
          {
            name: "localapi_execute_flow",
            arguments: { projectId: project.id, planId: "cancel-redirect" },
          },
          undefined,
          { signal: controller.signal },
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      await waitFor(async () => {
        try {
          return (await readFile(marker, "utf8")) === "received";
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      }, "actual second-hop partial body received by runtime");
      assert.deepEqual(wire, ["/start", "/partial"]);
      controller.abort();
      const run = await waitFor(
        async () =>
          (await new Store(root).get(project.id)).runs.find(
            (row) => row.planId === "cancel-redirect",
          ),
        "durable terminal run, not only SDK rejection",
      );
      const rpc = await settled;
      assert.match(rpc.error?.message || "", /abort|cancel/i);
      const sent = messages.find(
        (message) =>
          message.method === "tools/call" &&
          message.params?.name === "localapi_execute_flow",
      );
      assert(sent);
      assert(
        messages.some(
          (message) =>
            message.method === "notifications/cancelled" &&
            message.params.requestId === sent.id,
        ),
      );
      assert.equal(run.status, "cancelled");
      assert.equal(run.results.length, 1);
      const result = run.results[0];
      assert.equal(result.status, "failed");
      assert.equal(result.response.status, 404);
      assert.equal(result.response.headers["x-actual-hop"], "second");
      assert.equal(result.response.request.url, base + "/partial");
      assert.equal(result.response.body, prefix);
      assert.equal(result.redirectFailure.code, "REQUEST_CANCELLED");
      assert.equal(result.redirectFailure.reason, "cancelled");
      assert.equal(result.redirectFailure.responseComplete, false);
      assert.equal(result.redirectFailure.retry_safe, false);
      assert.equal(result.redirectFailure.requestStarted, true);
      assert.equal(result.redirectFailure.attemptedUrl, base + "/partial");
      assert.equal(result.redirectFailure.trace[0].status, 302);
      assert.equal(result.redirectFailure.trace[0].url, base + "/start");
      assert.deepEqual(result.assertions, []);
      assert.deepEqual(result.extracted, {});
      assert.equal(run.variables.guard, "unchanged");
      assert.equal(run.variables.late, undefined);
      await waitFor(async () => {
        const activities =
          kind === "stdio"
            ? await readMCPActivities(root)
            : (await owner("/api/mcp/config")).activities;
        return activities.some(
          (row) =>
            row.projectId === project.id &&
            (row.executionStatus ?? row.status) === "cancelled" &&
            row.recordSaved === true,
        );
      }, "server confirmed persisted cancellation activity");
      await client.ping();
      await readback(client, project.id, run);
      assert.deepEqual(
        wire,
        ["/start", "/partial"],
        "readback/chunks do not replay",
      );
      const native = decode(
        await client.callTool({
          name: "apipost_execute_flow",
          arguments: { project_id: project.id, flow_id: "native-blocked" },
        }),
      );
      assert.equal(native.status, "failed");
      assert.equal(native.total, 1);
      assert.equal(native.failed.length, 1);
      assert.equal(native.failed[0].status_code, 302);
      assert.equal(
        native.failed[0].workbench_redirect_failure.reason,
        "origin",
      );
      assert.equal(
        native.failed[0].workbench_redirect_failure.retry_safe,
        false,
      );
      const nativeRun = (await store.get(project.id)).runs.find(
        (row) => row.id === native.run_id,
      );
      assert(nativeRun);
      assert.deepEqual(
        native.failed[0].workbench_redirect_failure,
        nativeRun.results[0].redirectFailure,
      );
      await readback(client, project.id, nativeRun);
      assert.deepEqual(wire, ["/start", "/partial", "/blocked"]);
      assert.deepEqual(foreignWire, []);
      assert.deepEqual((await store.get(project.id)).globalVariables, {
        guard: "unchanged",
      });
    },
  );
