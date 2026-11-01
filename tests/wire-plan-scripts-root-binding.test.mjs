// CI-only: production worker/runtime imports must never be run locally.
import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { runScript } from "../src/scripts.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";

const wireContext = {
  protocol: "tcp",
  phase: "before",
  request: {
    host: "127.0.0.1",
    port: 50051,
    completion: "end",
    duration: 1000,
    message: "fixture",
  },
};
const grpcContext = {
  protocol: "grpc",
  phase: "before",
  request: {
    target: "grpc://127.0.0.1:50051",
    service: "fixture.Echo",
    method: "Unary",
    timeoutMs: 1000,
    messages: [],
  },
};
const input = {
  allowNetwork: false,
  request: { id: "wire", name: "wire" },
  variables: {},
  scopes: { globals: {}, environment: {}, runtime: {}, hidden: [] },
};

test("wire host rejects root native capabilities before task compilation or worker admission", () => {
  for (const key of [
    "cookieSession",
    "databaseQuery",
    "nativeWrite",
    "nativePhase",
    "databaseOrdinals",
    "nativeWaits",
    "responseAssertions",
    "responseExtractions",
    "requestSnapshot",
    "databaseOperations",
    "databaseTaskCount",
    "responseHeaderEvidence",
    "responseCookieEvidence",
  ])
    for (const value of [null, 0, [], {}])
      assert.throws(
        () =>
          runScript("", input, { wireContext, requestLimit: 0, [key]: value }),
        /协议脚本不能绑定/,
        key,
      );
  for (const key of ["collectionId", "collection", "collectionTypes"])
    assert.throws(
      () =>
        runScript(
          "",
          { ...input, scopes: { ...input.scopes, [key]: {} } },
          { wireContext, requestLimit: 0 },
        ),
      /协议脚本不能绑定/,
    );
});

async function workerRejection(t, additions) {
  // Intentionally no compiled engine: a forbidden binding must stop before
  // loading libraries or constructing a VM, independent of the host guard.
  const worker = new Worker(
    new URL("../src/script-worker.mjs", import.meta.url),
    {
      workerData: {
        input,
        code: "throw Error('must never execute');",
        wireContext,
        requestLimit: 0,
        ...additions,
      },
    },
  );
  t.after(() => worker.terminate());
  const messages = [];
  await new Promise((resolve, reject) => {
    worker.on("message", (message) => messages.push(message));
    worker.once("error", reject);
    worker.once("exit", (code) =>
      code ? reject(Error("worker exit " + code)) : resolve(),
    );
  });
  assert.equal(messages.length, 1, JSON.stringify(messages));
  assert.equal(messages[0].scriptStage, "bootstrap");
  assert.match(messages[0].error, /协议.*(绑定|上下文|执行入口)/);
  assert.equal(messages[0].result, undefined);
}

test(
  "wire worker independently rejects mixed modes, native tasks and collection bindings before VM creation",
  { timeout: 30000 },
  async (t) => {
    for (const additions of [
      { grpcContext },
      { nativeWaits: [] },
      { databaseTaskCount: 0 },
      { input: { ...input, wireContext } },
      {
        input: {
          ...input,
          scopes: { ...input.scopes, collectionId: "A", collection: {} },
        },
      },
    ])
      await workerRejection(t, additions);
  },
);

test("shared wire phases reject forged collection scopes before PRE publication or any transport", async () => {
  for (const before of [
    "scopeState.collectionId='A';scopeState.collection={secret:'forged'};",
    "scopeState.collectionTypes={secret:'string'};",
  ]) {
    let calls = 0,
      commits = 0;
    const run = await runPlan(
      snapshotPlan({
        steps: [
          {
            id: "wire",
            type: "protocol",
            protocol: {
              definition: { type: "tcp", url: "127.0.0.1", port: 50051 },
              message: "fixture",
            },
            protocolScripts: { version: 1, before, after: "" },
          },
        ],
      }),
      {},
      async () => {
        throw Error("unexpected HTTP");
      },
      {
        executeProtocol: async () => {
          calls++;
          throw Error("unexpected wire");
        },
        onScopeChanges: async () => {
          commits++;
        },
      },
    );
    assert.equal(run.status, "failed", JSON.stringify(run));
    assert.match(run.results[0].error, /collection/i);
    assert.equal(calls, 0);
    assert.equal(commits, 0);
    assert.equal(run.variables.secret, undefined);
  }
});
