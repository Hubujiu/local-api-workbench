// Root-only acceptance: PR19 progress stops intersect native aliases, repeat and PR30.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rename, writeFile, rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan, restoreProject } from "../src/core.mjs";
import { createMCP } from "../src/mcp.mjs";
import { MCPActivity } from "../src/mcp-activity.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
for (const native of [false, true])
  for (const kind of ["api", "flow"])
    for (const unknown of [false, true])
      test(`${native ? "native" : "canonical"} ${kind} progress fail-stop with ${unknown ? "actual unknown commit" : "stdio failure"} preserves restart/restore evidence`, async (t) => {
        const root = await mkdtemp(path.join(tmpdir(), "combined-progress-"));
        const journal = path.join(root, ".mcp-activities");
        let hits = 0,
          tcpHits = 0,
          client,
          activity,
          broken = false;
        const tcp = net.createServer((socket) => {
          tcpHits++;
          socket.on("data", (data) => socket.end(data));
        });
        await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
        const peer = http.createServer(async (_req, res) => {
          hits++;
          try {
            await rename(journal, journal + "-kept");
            await writeFile(journal, "owned path obstacle");
            broken = true;
            res.setHeader("content-type", "application/json");
            res.end('{"token":"committed-token","proof":"real-response"}');
          } catch (error) {
            res.destroy(error);
          }
        });
        await new Promise((r) => peer.listen(0, "127.0.0.1", r));
        t.after(async () => {
          await client?.close().catch(() => {});
          await activity?.finish(true).catch(() => {});
          peer.closeAllConnections();
          await new Promise((r) => peer.close(r));
          await new Promise((r) => tcp.close(r));
          await rm(root, { recursive: true, force: true });
        });
        const store = new Store(root);
        const project = await store.create("target"),
          other = await store.create("isolated");
        const isolated = await store.get(other.id);
        const request = {
          id: "request",
          name: "first HTTP",
          url: "http://127.0.0.1:" + peer.address().port,
          extract: [{ name: "token", path: "$.token", scope: "environment" }],
        };
        const wire = {
          id: "tcp",
          type: "protocol",
          protocol: {
            definition: {
              type: "tcp",
              url: "127.0.0.1",
              port: tcp.address().port,
            },
            message: "real-wire",
          },
        };
        const steps = [wire, { id: "http", request }];
        project.requests = [request];
        project.plans = [
          snapshotPlan({
            id: "flow",
            name: "mixed stop",
            steps: native
              ? [...steps, { id: "later", request }]
              : [
                  wire,
                  {
                    id: "repeat",
                    type: "repeat",
                    count: 3,
                    steps: [{ id: "http", request }],
                  },
                  { id: "later", request },
                ],
          }),
        ];
        await store.save(project);
        const tool = (native ? "apipost_" : "localapi_") + "execute_" + kind;
        const args = native
          ? {
              project_id: project.id,
              ...(kind === "api"
                ? { target_id: request.id }
                : { flow_id: "flow" }),
            }
          : {
              projectId: project.id,
              ...(kind === "api" ? { apiId: request.id } : { planId: "flow" }),
            };
        const connect = async (grant) => {
          const c = new Client({ name: "combined-progress", version: "1" });
          await c.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [
                fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
                "--project",
                grant,
                "--write",
                "--execute",
              ],
              env: { LOCAL_API_DATA: root },
              stderr: "pipe",
            }),
          );
          return c;
        };
        let receipt,
          savedId,
          typedFailure,
          attempts = 0;
        const history = path.join(store.directory(project.id), "history");
        if (unknown) {
          // Real save/read remain intact. Obstruct the owned history path only
          // after its read, so the actual transaction is journalled then fails.
          const originalSave = store.save,
            originalRead = store.readUnlocked;
          store.save = async function (p, options) {
            if (p.id !== project.id || !options?.activity)
              return originalSave.call(this, p, options);
            attempts++;
            this.readUnlocked = async function (id) {
              const prior = await originalRead.call(this, id);
              this.readUnlocked = originalRead;
              await rename(history, history + "-kept");
              await writeFile(history, "owned history obstacle");
              return prior;
            };
            try {
              return await originalSave.call(this, p, options);
            } catch (error) {
              typedFailure = error;
              throw error;
            } finally {
              this.readUnlocked = originalRead;
            }
          };
          activity = await new MCPActivity(root, {
            tool,
            projectId: project.id,
          }).start();
          const dispatch = createMCP({
            store,
            projects: [project.id],
            write: true,
            execute: true,
            onProgress: (p) => activity.update(p),
          });
          receipt = decode(
            (
              await dispatch({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: tool, arguments: args },
              })
            ).result,
          );
          store.save = originalSave;
          assert.equal(receipt.status, "failed");
          assert.equal(
            native ? receipt.record_saved : receipt.recordSaved,
            false,
          );
          assert.equal(native ? receipt.record_id : receipt.recordId, null);
          const outcome = native
            ? receipt.persistence_outcome
            : receipt.persistenceOutcome;
          assert.equal(outcome.code, "PROJECT_COMMIT_UNCERTAIN");
          assert.equal(outcome.commit_outcome, "unknown");
          assert.equal(outcome.retry_safe, false);
          assert.equal(outcome.project_id, project.id);
          assert(typedFailure instanceof ProjectCommitUncertain);
          assert.equal(attempts, 1);
          savedId = native
            ? receipt.attempted_record_id
            : receipt.attemptedRecordId;
          assert(savedId);
          assert.equal(JSON.stringify(outcome).includes(root), false);
          if (native) assert.deepEqual(receipt.failed, []);
          else {
            assert.equal(
              receipt.progressFailure.code,
              "EXECUTION_PROGRESS_FAILED",
            );
            assert.equal(receipt.results.at(-1).response.status, 200);
          }
          assert(
            JSON.parse(
              await readFile(
                path.join(store.directory(project.id), ".transaction.json"),
                "utf8",
              ),
            ),
          );
          await rm(history);
          await rename(history + "-kept", history);
        } else {
          client = await connect(project.id);
          await assert.rejects(
            client.callTool({ name: tool, arguments: args }),
            /Execution\/progress\/output failed/,
          );
          await client.close();
        }
        assert.equal(broken, true);
        assert.equal(hits, 1);
        assert.equal(tcpHits, kind === "flow" ? 1 : 0);
        await rm(journal);
        await rename(journal + "-kept", journal);
        const recovered = await new Store(root).get(project.id);
        assert.equal(
          recovered.environments[0].variables.token,
          "committed-token",
        );
        const records = kind === "api" ? recovered.history : recovered.runs;
        assert.equal(records.length, 1);
        const record = records[0],
          last = kind === "api" ? record : record.results.at(-1);
        if (savedId) assert.equal(record.id, savedId);
        assert.equal(record.status, "failed");
        assert.equal(last.error, undefined);
        assert.equal(last.response.status, 200);
        assert.equal(JSON.parse(last.response.body).proof, "real-response");
        assert.equal(last.progressFailure.code, "EXECUTION_PROGRESS_FAILED");
        assert.equal(last.progressFailure.retry_safe, false);
        if (kind === "flow") {
          assert.equal(record.results.length, 2);
          assert(record.results.every((r) => r.status === "passed"));
          assert.equal(record.results[0].protocolResult.status, "completed");
          assert.equal(
            record.results[0].protocolResult.result.body,
            "real-wire",
          );
          assert.equal(record.stopReason, "progress-failure");
          assert.deepEqual(record.snapshot, project.plans[0]);
          if (!native) {
            assert.equal(record.results[0].repeat, undefined);
            assert(record.results[1].repeat);
          }
        }
        assert.deepEqual(await store.get(other.id), isolated);
        const restored = restoreProject(JSON.parse(JSON.stringify(recovered)));
        await new Store(root).save(restored);
        for (const target of [project.id, restored.id]) {
          await client?.close();
          client = await connect(target);
          const list = decode(
            await client.callTool({
              name: "localapi_list_execution_runs",
              arguments: { projectId: target },
            }),
          );
          assert.equal(list.length, 1);
          assert.equal(list[0].id, record.id);
          const detail = decode(
            await client.callTool({
              name: "localapi_get_execution_result",
              arguments: { projectId: target, runId: record.id },
            }),
          );
          assert.deepEqual(detail, record);
          if (native) {
            const { run } = decode(
              await client.callTool({
                name: "apipost_get_execution_result",
                arguments: { project_id: target, run_id: record.id },
              }),
            );
            assert.deepEqual(run, {
              ...record,
              run_id: record.id,
              project_id: target,
              workbench_evidence_format: 1,
            });
          }
        }
        await client.close();
        client = await connect(other.id);
        const denied = await client.callTool({
          name: "localapi_get_execution_result",
          arguments: { projectId: project.id, runId: record.id },
        });
        assert.equal(denied.isError, true);
        assert.match(denied.content[0].text, /未授权/);
        assert.equal(hits, 1);
        assert.equal(tcpHits, kind === "flow" ? 1 : 0);
      });
