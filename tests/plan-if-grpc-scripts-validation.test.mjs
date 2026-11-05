import test from "node:test";
import assert from "node:assert/strict";
import { validatePlanGrpcScripts } from "../src/grpc-plan-scripts.mjs";
const scripts = { version: 1, before: "", after: "" };
const gate = (steps) => ({ type: "if", enabled: false, steps });
test("grpcScripts validation traverses disabled IF and repeat descendants", () => {
  const wrap = (leaf) => [gate([{ type: "repeat", steps: [gate([leaf])] }])];
  validatePlanGrpcScripts(wrap({ type: "grpc", grpcScripts: scripts }));
  assert.throws(
    () =>
      validatePlanGrpcScripts(
        wrap({ type: "grpc", grpcScripts: { ...scripts, version: 2 } }),
      ),
    /gRPC脚本/,
  );
  assert.throws(
    () => validatePlanGrpcScripts(wrap({ type: "http", grpcScripts: scripts })),
    /仅可用于/,
  );
  assert.throws(
    () => validatePlanGrpcScripts([{ ...gate([]), grpcScripts: scripts }]),
    /仅可用于/,
  );
  let reads = 0;
  const accessor = { type: "grpc" };
  Object.defineProperty(accessor, "grpcScripts", {
    enumerable: true,
    get() {
      reads++;
      return scripts;
    },
  });
  assert.throws(() => validatePlanGrpcScripts(wrap(accessor)), /普通JSON/);
  assert.equal(reads, 0);
});

test("plain non-IF unscripted gRPC keeps legacy unknown-commit continuation", async () => {
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const { ProjectCommitUncertain } = await import(
    "../src/project-commit-outcome.mjs"
  );
  const plan = snapshotPlan({
    steps: [
      {
        id: "rpc",
        type: "grpc",
        grpc: {
          definition: {
            target: "grpc://127.0.0.1:5000",
            proto:
              'syntax="proto3"; package fixture; message Payload { string text=1; } service Echo { rpc Unary(Payload) returns (Payload); }',
            service: "fixture.Echo",
            method: "Unary",
            timeoutMs: 1000,
          },
          messages: [{}],
        },
        extract: [{ name: "reply", path: "$[0].text", scope: "environment" }],
      },
      { id: "tail", request: { url: "http://fixture.invalid" } },
    ],
  });
  let http = 0,
    rpc = 0;
  const run = await runPlan(
    plan,
    {},
    async () => {
      http++;
      return { status: 200, headers: {}, body: "{}", duration: 0 };
    },
    {
      executeGrpc: async () => {
        rpc++;
        return {
          status: { code: 0, details: "" },
          messages: [{ text: "reply" }],
          metadata: [],
          trailers: [],
          durationMs: 0,
        };
      },
      onScopeChanges: async () => {
        throw new ProjectCommitUncertain("fixture", Error("unknown"));
      },
    },
  );
  assert.equal(rpc, 1);
  assert.equal(http, 1);
  assert.equal(run.results.length, 2);
  assert.equal(run.results[0].scopeCommit.outcome, "unknown");
  assert.notEqual(run.stopReason, "scope-commit-unknown");
  assert.equal(run.variables.reply, undefined);
});
