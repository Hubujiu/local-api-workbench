import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rename, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store, executeRequest } from "../src/runtime.mjs";
import { snapshotPlan, runPlan } from "../src/core.mjs";
const main = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const decode = (response) => {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
};
for (const kind of ["api", "flow"])
  for (const status of [200, 503])
    test(`stdio ${kind} preserves ${status} response after genuine progress journal failure and never replays`, async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "progress-evidence-"));
      const journal = path.join(root, ".mcp-activities"),
        parked = journal + "-parked";
      let fault = false,
        connections = 0,
        client;
      const peer = http.createServer(async (_req, res) => {
        connections++;
        try {
          if (!fault) {
            await rename(journal, parked);
            await writeFile(journal, "test-owned path obstacle");
            fault = true;
          }
          res.writeHead(status, { "content-type": "application/json" });
          res.end(
            '{"value":"committed-before-progress","proof":"actual-peer-response"}',
          );
        } catch (error) {
          res.destroy(error);
        }
      });
      await new Promise((r) => peer.listen(0, "127.0.0.1", r));
      t.after(async () => {
        await client?.close().catch(() => {});
        peer.closeAllConnections();
        await new Promise((r) => peer.close(r));
        await rm(root, { recursive: true, force: true });
      });
      const store = new Store(root),
        project = await store.create("allowed"),
        other = await store.create("other");
      const otherBefore = await store.get(other.id);
      const request = {
        id: "first",
        name: "first",
        url: `http://127.0.0.1:${peer.address().port}/first`,
        extract: [{ name: "saved", path: "$.value", scope: "environment" }],
      };
      project.requests = [request];
      project.plans = [
        snapshotPlan({
          id: "flow",
          name: "two steps",
          steps: [
            { id: "first-step", request },
            {
              id: "later-step",
              request: {
                name: "must-not-run",
                url: `http://127.0.0.1:${peer.address().port}/later`,
              },
            },
          ],
        }),
      ];
      await store.save(project);
      async function connect(grant = project.id) {
        const c = new Client({ name: "progress-evidence", version: "1" });
        await c.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [main, "--project", grant, "--write", "--execute"],
            env: { LOCAL_API_DATA: root },
            stderr: "pipe",
          }),
        );
        return c;
      }
      client = await connect();
      // Final activity flush still fails closed with the existing single RPC error.
      await assert.rejects(
        client.callTool({
          name: `localapi_execute_${kind}`,
          arguments: {
            projectId: project.id,
            ...(kind === "api" ? { apiId: request.id } : { planId: "flow" }),
          },
        }),
        /Execution\/progress\/output failed/,
      );
      assert.equal(connections, 1);
      assert.equal(fault, true);
      const saved = await new Store(root).get(project.id);
      assert.equal(
        saved.environments[0].variables.saved,
        "committed-before-progress",
      );
      const records = kind === "api" ? saved.history : saved.runs;
      if (!records.length)
        t.diagnostic(
          "RED: actual peer response and environment commit completed, progress ENOTDIR stopped execution, but no result was persisted",
        );
      assert.equal(
        records.length,
        1,
        "completed response must have a recoverable terminal record",
      );
      const record = records[0],
        result = kind === "api" ? record : record.results[0];
      assert.equal(record.status, "failed");
      assert.equal(result.response.status, status);
      assert.equal(
        JSON.parse(result.response.body).proof,
        "actual-peer-response",
      );
      assert.equal(
        result.error,
        undefined,
        "progress failure is not an HTTP error",
      );
      assert.equal(result.progressFailure.code, "EXECUTION_PROGRESS_FAILED");
      assert.equal(result.progressFailure.retry_safe, false);
      assert.equal(
        JSON.stringify(result.progressFailure).includes(root),
        false,
      );
      if (kind === "flow") {
        assert.equal(record.results.length, 1);
        assert.equal(result.status, status === 200 ? "passed" : "failed");
        assert.equal(record.stopReason, "progress-failure");
        assert.deepEqual(record.progressFailure, result.progressFailure);
      }
      assert.deepEqual(await store.get(other.id), otherBefore);
      await client.close();
      await rm(journal);
      await rename(parked, journal);
      client = await connect();
      const list = decode(
        await client.callTool({
          name: "localapi_list_execution_runs",
          arguments: { projectId: project.id },
        }),
      );
      assert.equal(list.length, 1);
      assert.equal(list[0].id, record.id);
      const detail = decode(
        await client.callTool({
          name: "localapi_get_execution_result",
          arguments: { projectId: project.id, runId: record.id },
        }),
      );
      assert.deepEqual(detail, record);
      await client.close();
      client = await connect(other.id);
      const denied = await client.callTool({
        name: "localapi_get_execution_result",
        arguments: { projectId: project.id, runId: record.id },
      });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /未授权/);
      assert.equal(
        connections,
        1,
        "recovery and evidence readback must not repeat network effects",
      );
    });

test("external cancellation wins over a real post-response progress filesystem failure", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "progress-cancel-"));
  const journal = path.join(root, ".mcp-activities");
  let requests = 0;
  const peer = http.createServer((_req, res) => {
    requests++;
    res.end("completed");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const { MCPActivity } = await import("../src/mcp-activity.mjs");
  const activity = await new MCPActivity(root, {
    tool: "localapi_execute_flow",
    projectId: "p",
  }).start();
  const controller = new AbortController();
  const run = await runPlan(
    snapshotPlan({
      name: "cancel at observer",
      steps: [1, 2].map((n) => ({
        id: "step-" + n,
        request: { url: "http://127.0.0.1:" + peer.address().port },
      })),
    }),
    {},
    executeRequest,
    {
      signal: controller.signal,
      onStep: async () => {
        await rename(journal, journal + "-parked");
        await writeFile(journal, "owned obstacle");
        controller.abort();
        await activity.update({ completed: 1, total: 2 });
      },
    },
  );
  assert.equal(run.status, "cancelled");
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].status, "passed");
  assert.equal(run.results[0].response.body, "completed");
  assert.equal(run.results[0].error, undefined);
  assert.equal(run.progressFailure.code, "EXECUTION_PROGRESS_FAILED");
  assert.equal(requests, 1);
});
