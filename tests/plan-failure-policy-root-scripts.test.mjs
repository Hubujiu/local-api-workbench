// CI-only: production QuickJS PRE/POST execution with injected protocol peers.
// These are script/core boundary contracts, not real gRPC/TCP transport acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";

const http = (id) => ({ id, request: { url: "http://127.0.0.1:1/" + id } });
const scripts = (phase) => ({
  version: 1,
  before:
    phase === "before" ? 'pm.environment.set("unconfirmed","before");' : "",
  after: phase === "after" ? 'pm.environment.set("unconfirmed","after");' : "",
});
const grpc = (phase) => ({
  id: "rpc",
  type: "grpc",
  grpcScripts: scripts(phase),
  grpc: {
    definition: {
      id: "echo",
      target: "grpc://127.0.0.1:5000",
      proto:
        'syntax="proto3"; package fixture; message Payload { string text=1; } service Echo { rpc Unary(Payload) returns (Payload); }',
      service: "fixture.Echo",
      method: "Unary",
      timeoutMs: 1000,
    },
    messages: [{ text: "actual-boundary" }],
  },
});
const wire = (phase) => ({
  id: "wire",
  type: "protocol",
  protocolScripts: scripts(phase),
  protocol: {
    definition: { id: "echo", type: "tcp", url: "127.0.0.1", port: 4000 },
    message: "actual-boundary",
    duration: 1000,
  },
});
for (const value of [undefined, "continue", "stop"])
  for (const kind of ["grpc", "wire"])
    for (const phase of ["before", "after"])
      for (const cancel of [false, true])
        test(`${value ?? "omitted"} ${kind} ${phase} unknown scope commit retains hard-stop evidence${cancel ? " when observer cancels" : ""}`, async () => {
          let protocolCalls = 0,
            tailCalls = 0,
            commits = 0,
            reports = 0;
          const controller = new AbortController();
          const run = await runPlan(
            snapshotPlan({
              ...(value === undefined ? {} : { failurePolicy: value }),
              steps: [
                kind === "grpc" ? grpc(phase) : wire(phase),
                http("never"),
              ],
            }),
            {},
            async () => {
              tailCalls++;
              return { status: 200, headers: {}, body: "{}" };
            },
            {
              signal: controller.signal,
              executeGrpc: async () => {
                protocolCalls++;
                return {
                  status: { code: 0, details: "" },
                  messages: [{ text: "completed" }],
                  durationMs: 1,
                  metadata: [],
                  trailers: [],
                };
              },
              executeProtocol: async () => {
                protocolCalls++;
                return {
                  type: "tcp",
                  status: "completed",
                  durationMs: 1,
                  result: {
                    body: "completed",
                    base64: "Y29tcGxldGVk",
                    size: 9,
                    timedOut: false,
                    partial: false,
                  },
                };
              },
              onScopeChanges: async () => {
                commits++;
                throw new ProjectCommitUncertain(
                  "owned-fixture",
                  Error("unconfirmed"),
                );
              },
              onStep: (record) => {
                reports++;
                assert.equal(record.scopeCommit.outcome, "unknown");
                if (cancel) controller.abort();
              },
            },
          );
          assert.equal(run.status, cancel ? "cancelled" : "failed");
          assert.equal(
            run.stopReason,
            value === "stop" ? "scope-commit-unknown" : undefined,
          );
          assert.equal(run.failureStop, undefined);
          assert.equal(run.progressFailure, undefined);
          assert.deepEqual(
            [protocolCalls, tailCalls, commits, reports],
            [phase === "after" ? 1 : 0, 0, 1, 1],
          );
          assert.equal(run.results.length, 1);
          assert.deepEqual(run.results[0].scopeCommit, {
            outcome: "unknown",
            retrySafe: false,
            phase,
          });
          assert.equal(run.variables.unconfirmed, undefined);
          if (phase === "after") {
            if (kind === "grpc")
              assert.equal(run.results[0].grpcResult.status.code, 0);
            else
              assert.equal(run.results[0].protocolResult.status, "completed");
          }
        });

for (const value of [undefined, "continue", "stop"])
  test(`${value ?? "omitted"} cannot bypass native response extraction hard stop`, async () => {
    let calls = 0,
      commits = 0;
    const plan = snapshotPlan({
      ...(value === undefined ? {} : { failurePolicy: value }),
      steps: [
        {
          id: "native",
          request: {
            url: "http://127.0.0.1:1/completed",
            inheritSharedScripts: false,
            nativeTasks: {
              version: 1,
              before: [],
              after: [
                {
                  id: "pick",
                  type: "pickVars",
                  enabled: 1,
                  data: {
                    source: "responseJson",
                    variables: [
                      {
                        name: "mustNotPublish",
                        expression: "$.missing",
                        type: "envVars",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
        http("never"),
      ],
    });
    const run = await runPlan(
      plan,
      {},
      async () => {
        calls++;
        return { status: 200, headers: {}, body: '{"accepted":true}' };
      },
      {
        onScopeChanges: async () => {
          commits++;
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(commits, 0);
    assert.equal(run.status, "failed");
    assert.equal(run.failureStop, undefined);
    assert.match(run.results[0].error, /pickVars响应路径不存在/);
    assert.equal(run.results[0].response.body, '{"accepted":true}');
    assert.equal(run.variables.mustNotPublish, undefined);
    assert.equal(run.results.length, 1);
  });
