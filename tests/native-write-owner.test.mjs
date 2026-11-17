import test from "node:test";
import assert from "node:assert/strict";
import { createNativeWriteOwner } from "../src/native-write-owner.mjs";
import { databaseWriteReceipt } from "../src/database-write-receipts.mjs";
import { nativeWriteDigest } from "../src/native-redis-write-intent.mjs";
function setup({ run, now } = {}) {
  const controller = new AbortController();
  let calls = 0,
    available = true;
  const request = {
    id: "request",
    name: "Native SET",
    method: "GET",
    url: "http://example.invalid/",
    inheritSharedScripts: false,
    nativeTasks: {
      version: 1,
      before: [
        {
          id: "task",
          type: "database",
          enabled: 1,
          data: {
            connectionId: "source",
            query: '["SET","key","value"]',
            resultShape: "redis-value",
            writeIntent: "redis-set",
            isConsoleOutput: -1,
            variables: [],
          },
        },
      ],
      after: [],
    },
  };
  const project = {
    id: "project",
    name: "Project",
    requests: [request],
    environments: [{ id: "environment", name: "Env", variables: { a: 1 } }],
    settings: {
      apipostDatabases: [{ id: "source", name: "Redis", type: "redis" }],
    },
    globalVariables: {},
    history: [{ id: "activity", secret: "activity-body" }],
    runs: [],
    protocolRuns: [],
    configRevision: 1,
    revision: 1,
  };
  const store = {
    get: async (id) => {
      if (!available || id !== project.id) throw Error("private-storage-error");
      return structuredClone(project);
    },
  };
  const target = {
    config: {
      type: "redis",
      host: "127.0.0.1",
      port: 6379,
      database: "0",
      password: "private-password",
    },
    sessionGeneration: "random-generation",
    bindingId: "source",
    signal: controller.signal,
    assertLive() {
      if (controller.signal.aborted) throw Error("revoked");
    },
    async revalidate() {
      this.assertLive();
    },
  };
  const databaseSessions = {
    async captureNativeRedisTarget(projectId, connectionId) {
      assert.equal(projectId, project.id);
      assert.equal(connectionId, "source");
      target.assertLive();
      return target;
    },
  };
  const owner = createNativeWriteOwner({
    store,
    databaseSessions,
    now,
    runPrepared: async (handle, captured, context) => {
      calls++;
      assert.equal(captured.config.password, "private-password");
      return run ? run(handle, captured, context) : outcome(handle);
    },
  });
  return {
    owner,
    project,
    request,
    controller,
    target,
    get calls() {
      return calls;
    },
    storageOff() {
      available = false;
    },
  };
}
function outcome(
  handle,
  { sent = true, status = "passed", recordSaved = true } = {},
) {
  if (sent) handle.consume();
  const review = handle.review;
  return {
    status,
    recordSaved,
    attemptedRecordId: "record",
    ...(recordSaved ? { recordId: "record" } : {}),
    writeReceipts: [
      databaseWriteReceipt(
        {
          projectId: handle.projectId,
          runId: handle.runId,
          preparationId: handle.preparationId,
          receiptId: "receipt",
          phase: review.phase,
          ordinal: review.ordinal,
          taskId: review.taskId,
          connectionId: review.connectionId,
          commandDigest: nativeWriteDigest(review.command),
        },
        sent ? "acknowledged-applied" : "not-sent",
        sent ? "acknowledged" : "cancelled",
      ),
    ],
  };
}
async function authorize(fixture, data = { requestId: "request" }) {
  const prepared = await fixture.owner.prepare("project", data);
  const grant = await fixture.owner.authorize("project", {
    preparationId: prepared.preparationId,
    digest: prepared.digest,
    phase: prepared.review.phase,
    ordinal: prepared.review.ordinal,
    acknowledgeReplacement: true,
  });
  return { prepared, grant };
}

test("owner prepare and authorization have zero effects and freeze one effective request", async () => {
  const f = setup({
    run: async (h) => {
      assert.equal(h.snapshot.plan.steps.length, 1);
      assert.equal(h.snapshot.variables.a, 1);
      assert.equal(h.snapshot.projectSnapshot.history, undefined);
      assert.equal(
        h.snapshot.plan.steps[0].request.url,
        "http://example.invalid/",
      );
      return outcome(h);
    },
  });
  const { prepared, grant } = await authorize(f);
  assert.equal(f.calls, 0);
  assert.deepEqual(prepared.review.safeTarget, {
    host: "127.0.0.1",
    port: 6379,
    database: 0,
    ssl: false,
  });
  assert.doesNotMatch(
    JSON.stringify(prepared),
    /private-password|activity-body/,
  );
  const result = await f.owner.execute("project", {
    preparationId: prepared.preparationId,
    token: grant.token,
  });
  assert.equal(f.calls, 1);
  assert.equal(result.writeReceipts[0].outcome, "acknowledged-applied");
  assert.equal(
    f.owner.status("project", { preparationId: prepared.preparationId })
      .recordSaved,
    true,
  );
  await assert.rejects(
    f.owner.execute("project", {
      preparationId: prepared.preparationId,
      token: grant.token,
    }),
  );
});

test("old tokens fail after edited or archived source/project; wrong-token attempt does not burn grant", async () => {
  const f = setup();
  const { prepared, grant } = await authorize(f);
  await assert.rejects(
    f.owner.execute("project", {
      preparationId: prepared.preparationId,
      token: "wrong",
    }),
  );
  f.project.settings.apipostDatabases[0].name = "edited";
  await assert.rejects(
    f.owner.execute("project", {
      preparationId: prepared.preparationId,
      token: grant.token,
    }),
  );
  f.project.settings.apipostDatabases[0].name = "Redis";
  await assert.rejects(
    f.owner.execute("project", {
      preparationId: prepared.preparationId,
      token: grant.token,
    }),
  );
  assert.equal(f.calls, 0);
  const second = await authorize(f);
  f.project.archived = true;
  await assert.rejects(
    f.owner.execute("project", {
      preparationId: second.prepared.preparationId,
      token: second.grant.token,
    }),
  );
});

test("status and revoke remain owner/project bound without readable storage", async () => {
  const f = setup({ run: async (h) => outcome(h, { recordSaved: false }) });
  const { prepared, grant } = await authorize(f);
  await f.owner.execute("project", {
    preparationId: prepared.preparationId,
    token: grant.token,
  });
  f.storageOff();
  const status = f.owner.status("project", {
    preparationId: prepared.preparationId,
  });
  assert.equal(status.recordSaved, false);
  assert.equal(status.writeReceipts[0].outcome, "acknowledged-applied");
  assert.throws(() =>
    f.owner.status("other", { preparationId: prepared.preparationId }),
  );
  assert.equal(
    f.owner.revoke("project", { preparationId: prepared.preparationId }).state,
    "completed",
  );
});

test("explicit captured-session revoke invalidates authorization immediately", async () => {
  const f = setup();
  const { prepared, grant } = await authorize(f);
  f.controller.abort();
  assert.equal(
    f.owner.status("project", { preparationId: prepared.preparationId }).state,
    "revoked",
  );
  await assert.rejects(
    f.owner.execute("project", {
      preparationId: prepared.preparationId,
      token: grant.token,
    }),
  );
  assert.equal(f.calls, 0);
});

test("caller cancellation still enters host finalizer for not-sent receipt", async () => {
  const abort = new AbortController();
  abort.abort();
  const f = setup({
    run: async (h, target, { signal }) => {
      assert.equal(signal.aborted, true);
      return outcome(h, {
        sent: false,
        status: "cancelled",
        recordSaved: false,
      });
    },
  });
  const { prepared, grant } = await authorize(f);
  const result = await f.owner.execute(
    "project",
    { preparationId: prepared.preparationId, token: grant.token },
    { signal: abort.signal },
  );
  assert.equal(result.writeReceipts[0].outcome, "not-sent");
  assert.equal(
    f.owner.status("project", { preparationId: prepared.preparationId }).state,
    "completed",
  );
});

test("prepare rejects authority fields/multiple writes/missing request without effects or raw errors", async () => {
  const f = setup();
  await assert.rejects(
    f.owner.prepare("project", { requestId: "request", allowWrite: true }),
  );
  await assert.rejects(
    f.owner.prepare("project", { requestId: "missing" }),
    (e) => e.code === "NATIVE_WRITE_DENIED",
  );
  f.request.nativeTasks.before.push(
    structuredClone(f.request.nativeTasks.before[0]),
  );
  await assert.rejects(f.owner.prepare("project", { requestId: "request" }));
  assert.equal(f.calls, 0);
  f.storageOff();
  await assert.rejects(
    f.owner.prepare("project", { requestId: "request" }),
    (e) => !e.message.includes("private-storage-error"),
  );
});

test("execution accepts no replacement plan or command; terminal expiry never grants replay", async () => {
  let now = 0;
  const f = setup({ now: () => now });
  const { prepared, grant } = await authorize(f);
  await assert.rejects(
    f.owner.execute("project", {
      preparationId: prepared.preparationId,
      token: grant.token,
      request: { url: "http://other.invalid" },
    }),
  );
  await f.owner.execute("project", {
    preparationId: prepared.preparationId,
    token: grant.token,
  });
  now = 300000;
  assert.throws(() =>
    f.owner.status("project", { preparationId: prepared.preparationId }),
  );
  await assert.rejects(
    f.owner.execute("project", {
      preparationId: prepared.preparationId,
      token: grant.token,
    }),
  );
});

test("owner reserves shared ledger capacity before blocked project IO", async () => {
  let finish;
  let gets = 0;
  const gate = new Promise((r) => {
    finish = r;
  });
  const owner = createNativeWriteOwner({
    store: {
      get: async () => {
        gets++;
        await gate;
        throw Error("missing");
      },
    },
    databaseSessions: {},
    runPrepared: async () => {
      throw Error("must not execute");
    },
  });
  const first = owner.prepare("project", { requestId: "request" });
  await assert.rejects(owner.prepare("project", { requestId: "request" }), {
    code: "NATIVE_WRITE_CAPACITY",
  });
  assert.equal(gets, 1);
  finish();
  await assert.rejects(first);
  await assert.rejects(owner.prepare("project", { requestId: "request" }), {
    code: "NATIVE_WRITE_DENIED",
  });
  assert.equal(gets, 2);
});

test("admitted frozen definition does not gain automatic archive cancellation", async () => {
  const f = setup({
    run: async (handle) => {
      f.project.archived = true;
      f.project.requests[0].url = "http://edited.invalid/";
      handle.assertLive();
      assert.equal(
        handle.snapshot.plan.steps[0].request.url,
        "http://example.invalid/",
      );
      return outcome(handle);
    },
  });
  const { prepared, grant } = await authorize(f);
  const result = await f.owner.execute("project", {
    preparationId: prepared.preparationId,
    token: grant.token,
  });
  assert.equal(result.writeReceipts[0].outcome, "acknowledged-applied");
});

test("session revoke after dispatch preserves finalized ACK and releases target listener only at completion", async () => {
  const f = setup({
    run: async (handle, target, { signal }) => {
      const result = outcome(handle, { recordSaved: false });
      f.controller.abort();
      assert.equal(signal.aborted, true);
      return result;
    },
  });
  const { prepared, grant } = await authorize(f);
  const result = await f.owner.execute("project", {
    preparationId: prepared.preparationId,
    token: grant.token,
  });
  assert.equal(result.writeReceipts[0].outcome, "acknowledged-applied");
  assert.equal(
    f.owner.status("project", { preparationId: prepared.preparationId })
      .revoked,
    true,
  );
});
