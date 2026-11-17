// Real official HTTP SDK + owned loopback effects. Revocation does not undo a
// completed request or accepted variable commit. No provider or original runtime.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";
import { observeToolCall } from "./helpers/mcp-cancellation-observation.mjs";
import { storedJSON } from "./helpers/stored-json.mjs";

function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function waitFor(read, predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  throw Error(label);
}
async function bytes(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const name = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await bytes(name)
      : (await readFile(name)).toString("base64");
  }
  return result;
}
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const gate = (id, steps) => ({
  id,
  type: "if",
  condition: { op: "eq", left: { literal: true }, right: { literal: true } },
  steps,
});

for (const { action, failurePolicy } of ["sdk-cancel", "owner-revoke"].flatMap(
  (action) =>
    [undefined, "stop"].map((failurePolicy) => ({ action, failurePolicy })),
))
  for (const missingFile of [false, true])
    test(
      `official SDK IF ${action} with ${failurePolicy || "default continue"} retains completed effects with ${missingFile ? "actual missing-file save refusal" : "durable terminal history"}`,
      { timeout: 20000 },
      async (t) => {
        const root = await mkdtemp(path.join(tmpdir(), "if-revoke-sdk-"));
        const entered = Promise.withResolvers(),
          closed = Promise.withResolvers(),
          appendTerminal = Promise.withResolvers(),
          retainedAppendTerminal = Promise.withResolvers();
        const seen = [],
          clients = [],
          attempted = [];
        let app,
          held,
          observation,
          retainedObservation,
          deniedObservation,
          retainedAppendInput,
          removed,
          originalAppend,
          appendSettled = false,
          retainedAppendSettled = false,
          denialConfirmed = false,
          effects = 0;
        const abort = new AbortController();
        const peer = http.createServer((request, response) => {
          seen.push(request.url);
          if (request.url === "/held") {
            held = response;
            request.socket.once("close", closed.resolve);
            entered.resolve();
            return;
          }
          if (request.url === "/accepted") effects++;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              effect: "committed-before-revocation",
              path: request.url,
            }),
          );
        });
        const closeApp = async () => {
          if (!app) return;
          const current = app;
          app = undefined;
          const closing = new Promise((resolve, reject) =>
            current.server.close((error) =>
              error ? reject(error) : resolve(),
            ),
          );
          current.server.closeIdleConnections();
          try {
            await bounded(closing, "owned app did not close");
          } catch (error) {
            current.server.closeAllConnections();
            throw error;
          }
        };
        t.after(async () => {
          // server.close synchronously aborts the real MCP execution registry.
          // Start it before touching held responses so cleanup cannot launch a
          // later IF child after an assertion/setup failure.
          const closing = closeApp().then(
            () => undefined,
            (error) => error,
          );
          abort.abort();
          const failures = [];
          const settle = async (operation) => {
            try {
              await operation();
            } catch (error) {
              failures.push(error);
            }
          };
          await settle(() =>
            Promise.all(clients.splice(0).map((client) => client.close())),
          );
          if (held && !held.destroyed) held.destroy();
          if (observation)
            await settle(() =>
              bounded(observation.completion, "SDK cleanup did not settle"),
            );
          if (retainedObservation)
            await settle(() =>
              bounded(
                retainedObservation.completion,
                "retained SDK cleanup did not settle",
              ),
            );
          if (deniedObservation) {
            await settle(() =>
              bounded(
                deniedObservation.completion,
                "denied SDK cleanup did not settle",
              ),
            );
            if (!denialConfirmed)
              failures.push(
                Error(
                  "Denied-call server outcome was not confirmed; preserve owned fixture",
                ),
              );
          }
          const closeFailure = await closing;
          if (closeFailure) failures.push(closeFailure);
          // A client rejection is not a join of the cancelled server handler.
          // Keep the fixture if its actual append never reached a terminal state.
          if (observation && !appendSettled)
            await settle(() =>
              bounded(
                appendTerminal.promise,
                "server append did not settle during cleanup",
              ),
            );
          if (retainedObservation && !retainedAppendSettled)
            await settle(() =>
              bounded(
                retainedAppendTerminal.promise,
                "retained server append did not settle during cleanup",
              ),
            );
          peer.closeAllConnections();
          if (peer.listening)
            await settle(() => new Promise((resolve) => peer.close(resolve)));
          // Keep the owned fixture if a handler did not settle, rather than race
          // real persistence with deletion of its files.
          if (!failures.length)
            await rm(root, { recursive: true, force: true });
          assert.deepEqual(failures, []);
        });
        await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
        app = await createApp({ root, port: 0 });
        const origin = `http://127.0.0.1:${peer.address().port}`;
        const a = await app.store.create("Revoked conditional workflow"),
          b = await app.store.create("Retained project");
        const leaf = (id, suffix, extract = []) => ({
          id,
          request: {
            id: "owned-api",
            name: id,
            method: "POST",
            url: origin + suffix,
            timeout: 10000,
            extract,
          },
        });
        const accepted = leaf("completed", "/accepted", [
          {
            name: "acceptedEffect",
            source: "json",
            path: "$.effect",
            scope: "environment",
          },
        ]);
        a.requests = [structuredClone(accepted.request)];
        a.plans = [
          snapshotPlan({
            id: "conditional",
            name: "cancel within IF",
            ...(failurePolicy ? { failurePolicy } : {}),
            steps: [
              gate("outer", [
                {
                  id: "repeat",
                  type: "repeat",
                  count: 2,
                  steps: [
                    accepted,
                    leaf("held", "/held"),
                    leaf("never-child", "/never-child"),
                  ],
                },
              ]),
              gate("never-condition", [leaf("never-tail", "/never-tail")]),
              leaf("never-ordinary-tail", "/never-ordinary-tail"),
            ],
          }),
        ];
        b.plans = [
          snapshotPlan({
            id: "retained",
            steps: [leaf("retained", "/retained")],
          }),
        ];
        await app.store.save(a);
        await app.store.save(b);
        const otherBefore = await app.store.get(b.id),
          otherBytes = await bytes(app.store.directory(b.id));
        const owner = async (config) => {
          const response = await fetch(app.url + "/api/mcp/config", {
            method: config === undefined ? "GET" : "POST",
            signal: AbortSignal.timeout(5000),
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            ...(config === undefined ? {} : { body: JSON.stringify(config) }),
          });
          const value = await response.json();
          assert.equal(response.status, 200, JSON.stringify(value));
          return value;
        };
        const policy = {
          enabled: true,
          remember: true,
          write: true,
          execute: true,
          projects: [a.id, b.id],
        };
        const config = await owner(policy);
        const connect = async (token) => {
          const client = new Client({
            name: "if-revocation-fixture",
            version: "1",
          });
          clients.push(client);
          await client.connect(
            new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
              requestInit: { headers: { Authorization: "Bearer " + token } },
            }),
            { timeout: 5000 },
          );
          return client;
        };
        const client = await connect(config.token);
        // Capture only the actual production append input. Return/error and all
        // save, read, lock and journal behavior remain the real Store methods.
        originalAppend = app.store.append;
        app.store.append = async function (projectId, field, record, ...rest) {
          const observed = projectId === a.id && field === "runs";
          if (observed) attempted.push(structuredClone(record));
          try {
            return await originalAppend.call(
              this,
              projectId,
              field,
              record,
              ...rest,
            );
          } finally {
            if (observed) {
              appendSettled = true;
              appendTerminal.resolve();
            }
          }
        };
        observation = observeToolCall(
          client.callTool(
            {
              name: "localapi_run_plan",
              arguments: { projectId: a.id, planId: "conditional" },
            },
            undefined,
            {
              ...(action === "sdk-cancel" ? { signal: abort.signal } : {}),
              timeout: 15000,
            },
          ),
        );
        await bounded(entered.promise, "real second HTTP child did not begin");
        observation.assertPending();
        assert.deepEqual(seen, ["/accepted", "/held"]);
        assert.equal(effects, 1);
        const committed = await app.store.get(a.id);
        assert.equal(
          committed.environments[0].variables.acceptedEffect,
          "committed-before-revocation",
        );
        assert.equal(committed.runs.length, 0);
        const directory = app.store.directory(a.id);
        if (missingFile) {
          const manifest = JSON.parse(
            await readFile(path.join(directory, "project.json"), "utf8"),
          );
          assert(manifest.collections.requests.includes("owned-api"));
          const file = path.join(
            directory,
            "apis",
            "key-" + Buffer.from("owned-api").toString("base64url") + ".json",
          );
          removed = { file, content: await readFile(file) };
          await rm(file);
          removed.damagedBytes = await bytes(directory);
        }
        observation.assertPending();
        if (action === "sdk-cancel") abort.abort();
        else await owner({ ...policy, projects: [b.id] });
        const terminal = await bounded(
          observation.completion,
          "SDK cancellation/revocation did not settle",
        );
        assert.equal(terminal.kind, "rejected");
        assert.match(
          terminal.reason.message,
          action === "sdk-cancel"
            ? /abort|cancel/i
            : /MCP authorization changed/,
        );
        if (action === "owner-revoke")
          assert.equal(terminal.reason.code, -32000);
        await bounded(closed.promise, "held network request was not aborted");
        const state = await waitFor(
          owner,
          (value) =>
            value.activities.some(
              (entry) =>
                entry.projectId === a.id &&
                entry.tool === "localapi_run_plan" &&
                entry.status !== "running",
            ),
          "server terminal activity was not published",
        );
        const activity = state.activities.find(
          (entry) =>
            entry.projectId === a.id && entry.tool === "localapi_run_plan",
        );
        assert.equal(activity.recordSaved, !missingFile);
        assert.equal(activity.status, missingFile ? "failed" : "cancelled");
        assert.equal(activity.executionStatus, "cancelled");
        if (missingFile) assert.match(activity.persistenceError, /保存失败/);
        assert.equal(JSON.stringify(activity).includes(root), false);
        assert.deepEqual(seen, ["/accepted", "/held"]);
        assert.equal(attempted.length, 1);
        const run = attempted[0];
        assert.equal(run.status, "cancelled");
        assert.equal(run.snapshot.failurePolicy, failurePolicy);
        assert.equal(
          Object.hasOwn(run.snapshot, "failurePolicy"),
          failurePolicy === "stop",
        );
        assert.equal(run.stopReason, undefined);
        assert.equal(Object.hasOwn(run, "failureStop"), false);
        assert.deepEqual(
          run.conditionResults.map((entry) => [entry.stepId, entry.matched]),
          [["outer", true]],
        );
        assert.deepEqual(
          run.results.map((entry) => entry.stepId),
          ["completed", "held"],
        );
        assert.equal(run.results[0].status, "passed");
        assert.equal(run.results[0].response.status, 200);
        assert.equal(
          JSON.parse(run.results[0].response.body).effect,
          "committed-before-revocation",
        );
        assert.equal(run.results[0].repeat.iteration, 0);
        assert.equal(run.results[1].repeat.iteration, 0);
        assert.equal(run.results[1].status, "failed");
        assert.equal(run.results[1].response, undefined);
        if (missingFile) {
          assert.deepEqual(await bytes(directory), removed.damagedBytes);
          await assert.rejects(
            readFile(path.join(directory, ".transaction.json")),
            { code: "ENOENT" },
          );
          await assert.rejects(readFile(removed.file), { code: "ENOENT" });
          // Repair only this test's removed bytes, after the failed save settled.
          await writeFile(removed.file, removed.content);
          assert.deepEqual(await app.store.get(a.id), committed);
        } else {
          const saved = await app.store.get(a.id);
          assert.equal(saved.runs.length, 1);
          assert.deepEqual(saved.runs[0], storedJSON(run));
        }
        assert.deepEqual(await app.store.get(b.id), otherBefore);
        assert.deepEqual(await bytes(app.store.directory(b.id)), otherBytes);
        const expected = await app.store.get(a.id);
        await Promise.all(clients.splice(0).map((item) => item.close()));
        app.store.append = originalAppend;
        originalAppend = undefined;
        await closeApp();
        app = await createApp({ root, port: 0 });
        assert.deepEqual(await new Store(root).get(a.id), expected);
        assert.equal(
          effects,
          1,
          "restart cannot roll back or repeat the accepted effect",
        );
        assert.deepEqual(seen, ["/accepted", "/held"]);
        const restarted = await owner();
        assert.deepEqual(
          restarted.projects,
          action === "owner-revoke" ? [b.id] : [a.id, b.id],
        );
        const fresh = await connect(restarted.token);
        if (action === "owner-revoke") {
          deniedObservation = observeToolCall(
            fresh.callTool(
              {
                name: "localapi_run_plan",
                arguments: { projectId: a.id, planId: "conditional" },
              },
              undefined,
              { timeout: 5000 },
            ),
          );
          const deniedTerminal = await bounded(
            deniedObservation.completion,
            "revoked project denial did not settle",
          );
          assert.equal(
            deniedTerminal.kind,
            "fulfilled",
            deniedTerminal.reason?.message,
          );
          assert.equal(deniedTerminal.value.isError, true);
          assert.match(deniedTerminal.value.content[0].text, /项目未授权/);
          // Only an explicit server denial proves this negative call did not
          // enter execution. A timeout/transport failure must retain the fixture.
          denialConfirmed = true;
        }
        const retainedAppend = app.store.append;
        app.store.append = async function (projectId, field, record, ...rest) {
          const observed = projectId === b.id && field === "runs";
          if (observed) retainedAppendInput = structuredClone(record);
          try {
            return await retainedAppend.call(
              this,
              projectId,
              field,
              record,
              ...rest,
            );
          } finally {
            if (observed) {
              retainedAppendSettled = true;
              retainedAppendTerminal.resolve();
            }
          }
        };
        retainedObservation = observeToolCall(
          fresh.callTool(
            {
              name: "localapi_run_plan",
              arguments: { projectId: b.id, planId: "retained" },
            },
            undefined,
            { timeout: 5000 },
          ),
        );
        const retainedTerminal = await bounded(
          retainedObservation.completion,
          "retained SDK execution did not settle",
        );
        assert.equal(
          retainedTerminal.kind,
          "fulfilled",
          retainedTerminal.reason?.message,
        );
        const retained = decode(retainedTerminal.value);
        assert.equal(retainedAppendSettled, true);
        assert.deepEqual(
          (await app.store.get(b.id)).runs[0],
          storedJSON(retainedAppendInput),
        );
        assert.equal(retained.status, "passed");
        assert.equal(retained.recordSaved, true);
        assert.deepEqual(seen, ["/accepted", "/held", "/retained"]);
        assert.equal(effects, 1);
        assert.deepEqual(await app.store.get(a.id), expected);
      },
    );
