// CI-only root integration. Real QuickJS, grpc-js, owner HTTP and Store writes.
// Do not execute locally as part of syntax or audited pure-helper checks.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";

const protoFile = new URL("./fixtures/grpc.proto", import.meta.url),
  proto = await readFile(protoFile, "utf8");
async function bounded(promise, label, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error(label + " timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Wrap only the scope save interleaving. Execution and the persistence outcome
// are real; the acknowledgement gate never substitutes a fabricated save result.
function scopeGate(store, projectId, phase, boundary) {
  const original = store.save,
    ready = Promise.withResolvers(),
    release = Promise.withResolvers();
  let attempts = 0,
    signal,
    actualError;
  ready.promise.catch(() => {});
  store.save = async function (candidate, options) {
    if (
      candidate.id !== projectId ||
      options?.activity ||
      attempts ||
      !candidate.environments.some(
        (environment) => environment.variables.scopeGate === phase,
      )
    )
      return original.call(this, candidate, options);
    attempts++;
    signal = options?.signal;
    try {
      if (boundary === "acknowledgement") {
        const result = await original.call(this, candidate, options);
        ready.resolve({ committed: true });
        await bounded(release.promise, "scope acknowledgement release");
        return result;
      }
      const unlock = await acquireFileLock(this.lockFile(projectId));
      let settled = false;
      const pending = original.call(this, candidate, options).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error) => {
          settled = true;
          return { error };
        },
      );
      try {
        // The original save is admitted to Store's queue behind an actually
        // owned file lock, not a timer pretending that a commit has started.
        await new Promise((resolve) => setImmediate(resolve));
        ready.resolve({ committed: false, settled });
        await bounded(release.promise, "scope lock release");
      } finally {
        await unlock();
      }
      const outcome = await pending;
      if (outcome.error) throw outcome.error;
      return outcome.value;
    } catch (error) {
      actualError = error;
      ready.reject(error);
      throw error;
    }
  };
  return {
    ready: ready.promise,
    release: () => release.resolve(),
    undo: () => {
      store.save = original;
    },
    get attempts() {
      return attempts;
    },
    get signal() {
      return signal;
    },
    get actualError() {
      return actualError;
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "grpc-script-root-cancel-")),
    rpc = new grpc.Server(),
    seen = [];
  let app, gate, pending;
  t.after(async () => {
    gate?.release();
    if (pending)
      await bounded(
        pending.catch(() => {}),
        "cancelled owner cleanup",
      ).catch(() => {});
    gate?.undo();
    rpc.forceShutdown();
    if (app?.server.listening) {
      app.server.closeAllConnections();
      await bounded(
        new Promise((resolve) => app.server.close(resolve)),
        "owner close",
      );
    }
    await rm(root, { recursive: true, force: true });
  });
  const pkg = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(protoFile), {
      longs: String,
      bytes: String,
      defaults: true,
    }),
  );
  rpc.addService(pkg.fixture.Echo.service, {
    Unary(call, done) {
      seen.push(call.request.text);
      const metadata = new grpc.Metadata();
      metadata.set("x-private", "root-cancel-metadata-sentinel");
      call.sendMetadata(metadata);
      done(null, { text: "real-rpc-token", count: seen.length });
    },
  });
  const port = await new Promise((resolve, reject) =>
    rpc.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  app = await createApp({ root, port: 0 });
  const owner = async (route, method = "GET", body, status = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  return {
    root,
    seen,
    owner,
    get app() {
      return app;
    },
    definition: {
      id: "echo",
      name: "Cancellation echo",
      target: `grpc://127.0.0.1:${port}`,
      proto,
      service: "fixture.Echo",
      method: "Unary",
      timeoutMs: 3000,
    },
    installGate(projectId, phase, boundary) {
      gate = scopeGate(app.store, projectId, phase, boundary);
      return gate;
    },
    run(projectId, planId) {
      pending = owner(`/api/projects/${projectId}/run`, "POST", {
        planId,
        runId: "grpc-root-cancel",
      });
      pending.catch(() => {});
      return pending;
    },
    async restart() {
      gate?.undo();
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app = await createApp({ root, port: 0 });
    },
  };
}

for (const boundary of ["lock", "acknowledgement"])
  test(
    `nested scripted gRPC cancellation at real Store ${boundary} boundary distinguishes unwritten and confirmed PRE/POST scopes`,
    { timeout: 40000 },
    async (t) => {
      for (const phase of ["before", "after"])
        await t.test(phase, { timeout: 20000 }, async (t) => {
          const f = await fixture(t),
            project = await f.app.store.create("gRPC root cancellation");
          Object.assign(project.environments[0].variables, {
            preEnv: "old-pre",
            postEnv: "old-post",
            token: "old-token",
          });
          project.globalVariables = {
            preGlobal: "old-pre-global",
            postGlobal: "old-post-global",
          };
          await f.app.store.save(project);
          const scripted = {
            id: "scripted",
            type: "grpc",
            grpc: {
              definition: f.definition,
              messages: [{ text: "{{preRuntime}}" }],
            },
            grpcScripts: {
              version: 1,
              before: [
                "apt.setVar('preRuntime','before-confirmed');",
                "pm.environment.set('preEnv','before-confirmed');",
                "pm.globals.set('preGlobal','before-confirmed');",
                "pm.environment.set('scopeGate','before');",
                "console.log('pre-finished');",
              ].join("\n"),
              after: [
                "pm.test('real result',()=>pm.expect(grpc.result.status.code).to.equal(0));",
                "apt.setVar('postRuntime','after-confirmed');",
                "pm.environment.set('postEnv','after-confirmed');",
                "pm.globals.set('postGlobal','after-confirmed');",
                "pm.environment.set('scopeGate','after');",
                "console.log('post-finished');",
              ].join("\n"),
            },
            extract: [
              { name: "token", path: "$[0].text", scope: "environment" },
              { name: "extractedRuntime", path: "$[0].count" },
            ],
          };
          const plan = await f.owner(
            `/api/projects/${project.id}/plans`,
            "POST",
            {
              id: "nested-cancel",
              name: "Must stop before every later occurrence",
              environmentId: project.environments[0].id,
              steps: [
                {
                  id: "outer",
                  type: "repeat",
                  count: 2,
                  steps: [
                    {
                      id: "inner",
                      type: "repeat",
                      count: 2,
                      steps: [
                        scripted,
                        {
                          id: "later",
                          type: "grpc",
                          grpc: {
                            definition: f.definition,
                            messages: [{ text: "must-not-run" }],
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          );
          const baseline = await f.app.store.get(project.id),
            gate = f.installGate(project.id, phase, boundary),
            running = f.run(project.id, plan.id),
            checkpoint = await bounded(gate.ready, "scope gate readiness");
          assert(gate.signal instanceof AbortSignal);
          assert.equal(gate.signal.aborted, false);
          assert.equal(gate.attempts, 1);
          assert.equal(checkpoint.committed, boundary === "acknowledgement");
          if (boundary === "lock") assert.equal(checkpoint.settled, false);
          else {
            // This separate Store read proves the real save completed before
            // cancellation; an invoked save callback alone proves no write.
            const committed = await new Store(f.root).get(project.id);
            assert.equal(committed.environments[0].variables.scopeGate, phase);
            assert.equal(
              committed.configRevision,
              baseline.configRevision + (phase === "before" ? 1 : 2),
            );
          }
          assert.deepEqual(
            f.seen,
            phase === "before" ? [] : ["before-confirmed"],
          );
          await f.owner("/api/cancel", "POST", { id: "grpc-root-cancel" });
          assert.equal(gate.signal.aborted, true);
          gate.release();
          const run = await bounded(running, "cancelled owner result");
          assert.equal(run.status, "cancelled", JSON.stringify(run));
          assert.equal(run.recordSaved, true, JSON.stringify(run));
          assert.equal(run.results.length, 1);
          assert.equal(gate.attempts, 1, "scope callback must not replay");
          if (boundary === "lock")
            assert.equal(gate.actualError?.code, "STORE_SAVE_ABORTED");
          else assert.equal(gate.actualError, undefined);
          const result = run.results[0],
            preKept = phase === "after" || boundary === "acknowledgement",
            postKept = phase === "after" && boundary === "acknowledgement";
          assert.equal(result.stepId, "scripted");
          assert.deepEqual(result.repeat, {
            groupId: "inner",
            childId: "scripted",
            iteration: 0,
            occurrenceId: JSON.stringify([
              [
                ["outer", 0],
                ["inner", 0],
              ],
              "scripted",
            ]),
            path: [
              { groupId: "outer", iteration: 0 },
              { groupId: "inner", iteration: 0 },
            ],
          });
          assert.equal(result.type, "grpc");
          assert.equal(result.response, undefined);
          assert.equal(result.scopeCommit, undefined);
          assert.equal(result.status, postKept ? "passed" : "failed");
          assert.deepEqual(
            result.extracted,
            postKept
              ? {
                  token: "real-rpc-token",
                  extractedRuntime: 1,
                }
              : {},
          );
          assert.equal(Boolean(result.grpcResult), phase === "after");
          if (phase === "after") {
            assert.equal(result.grpcResult.status.code, 0);
            assert.equal(result.grpcResult.messages[0].text, "real-rpc-token");
            assert.deepEqual(result.grpcResult.metadata, []);
            assert.deepEqual(result.grpcResult.trailers, []);
          }
          assert.equal(
            run.variables.preRuntime,
            preKept ? "before-confirmed" : undefined,
          );
          assert.equal(
            run.variables.postRuntime,
            postKept ? "after-confirmed" : undefined,
          );
          assert.equal(
            run.variables.extractedRuntime,
            postKept ? 1 : undefined,
          );
          assert.equal(
            run.variables.preEnv,
            preKept ? "before-confirmed" : "old-pre",
          );
          assert.equal(
            run.variables.postEnv,
            postKept ? "after-confirmed" : "old-post",
          );
          assert.equal(
            run.variables.token,
            postKept ? "real-rpc-token" : "old-token",
          );
          const saved = await new Store(f.root).get(project.id);
          assert.equal(
            saved.configRevision,
            baseline.configRevision + Number(preKept) + Number(postKept),
          );
          assert.equal(
            saved.environments[0].variables.preEnv,
            run.variables.preEnv,
          );
          assert.equal(
            saved.environments[0].variables.postEnv,
            run.variables.postEnv,
          );
          assert.equal(
            saved.environments[0].variables.token,
            run.variables.token,
          );
          assert.equal(
            saved.globalVariables.preGlobal,
            preKept ? "before-confirmed" : "old-pre-global",
          );
          assert.equal(
            saved.globalVariables.postGlobal,
            postKept ? "after-confirmed" : "old-post-global",
          );
          assert.deepEqual(saved.plans, baseline.plans);
          const durable = saved.runs.find((item) => item.id === run.id);
          assert(durable);
          assert.deepEqual(durable.results, run.results);
          assert.deepEqual(durable.snapshot.steps, plan.steps);
          assert.equal(durable.planHash, run.planHash);
          assert(
            !JSON.stringify(saved).includes("root-cancel-metadata-sentinel"),
          );
          await f.restart();
          const restarted = await f.owner(`/api/projects/${project.id}`);
          assert.deepEqual(restarted.runs, saved.runs);
          assert.deepEqual(restarted.environments, saved.environments);
          assert.deepEqual(
            f.seen,
            phase === "before" ? [] : ["before-confirmed"],
            "save acknowledgement, read and restart never replay or start a later occurrence",
          );
        });
    },
  );
