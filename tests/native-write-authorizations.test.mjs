import test from "node:test";
import assert from "node:assert/strict";
import { NativeWriteAuthorizations } from "../src/native-write-authorizations.mjs";
import { databaseWriteReceipt } from "../src/database-write-receipts.mjs";
import { nativeWriteDigest } from "../src/native-redis-write-intent.mjs";

const project = "project-a";
const review = () => ({
  phase: "before",
  ordinal: 1,
  taskId: "task",
  connectionId: "source",
  sessionGeneration: "random-session-generation",
  safeTarget: { host: "127.0.0.1", port: 6379, database: 0, ssl: false },
  command: ["SET", "key", "value"],
});
const input = (extra = {}) => ({
  snapshot: { request: { url: "https://example.invalid/", nativeTasks: [] } },
  review: review(),
  binding: { password: "secret-password", host: "private-target" },
  checkAdmission: async () => true,
  checkLive: () => true,
  ...extra,
});
const auth = (prepared) => ({
  digest: prepared.digest,
  phase: prepared.review.phase,
  ordinal: prepared.review.ordinal,
  acknowledgeReplacement: true,
});
async function reserved(ledger, extra) {
  const prepared = await ledger.prepare(project, input(extra));
  const grant = await ledger.authorize(
    project,
    prepared.preparationId,
    auth(prepared),
  );
  const handle = await ledger.reserve(
    project,
    prepared.preparationId,
    grant.token,
  );
  return { prepared, grant, handle };
}
function result(
  handle,
  outcome = "not-sent",
  reason = "not-reached",
  extra = {},
) {
  return {
    writeReceipts: [
      databaseWriteReceipt(
        {
          runId: handle.runId,
          preparationId: handle.preparationId,
          projectId: project,
          receiptId: "receipt",
          phase: "before",
          ordinal: 1,
          taskId: "task",
          connectionId: "source",
          commandDigest: nativeWriteDigest(["SET", "key", "value"]),
        },
        outcome,
        reason,
      ),
    ],
    status: "failed",
    recordSaved: false,
    attemptedRecordId: "record",
    ...extra,
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("owner ledger requires private authorization, reserves once and consumes exactly once", async () => {
  const ledger = new NativeWriteAuthorizations();
  const p = await ledger.prepare(project, input());
  assert.equal(ledger.status(project, p.preparationId).state, "prepared");
  await assert.rejects(ledger.reserve(project, p.preparationId, p.digest));
  await assert.rejects(ledger.reserve(project, p.preparationId, "allowWrite"));
  const grant = await ledger.authorize(project, p.preparationId, auth(p));
  const handle = await ledger.reserve(project, p.preparationId, grant.token);
  await assert.rejects(ledger.reserve(project, p.preparationId, grant.token));
  handle.consume();
  assert.throws(() => handle.consume());
  const terminal = ledger.complete(
    handle,
    result(handle, "acknowledged-applied", "acknowledged"),
  );
  assert.equal(terminal.writeReceipts[0].outcome, "acknowledged-applied");
  assert.equal(terminal.recordSaved, false);
  await assert.rejects(ledger.authorize(project, p.preparationId, auth(p)));
  assert.equal(handle.snapshot, undefined);
  assert.equal(handle.binding, undefined);
});

test("review excludes credentials/private binding and request secrets; deep-frozen snapshot cannot change", async () => {
  const ledger = new NativeWriteAuthorizations();
  const original = input();
  original.review.password = "secret-password";
  original.review.targetHash = "private-target";
  original.snapshot.secret = "snapshot-secret";
  const p = await ledger.prepare(project, original);
  assert.doesNotMatch(
    JSON.stringify(p),
    /secret-password|private-target|snapshot-secret|targetHash/,
  );
  original.snapshot.request.url = "changed";
  original.binding.password = "changed";
  original.review.command[2] = "changed";
  const grant = await ledger.authorize(project, p.preparationId, auth(p));
  const h = await ledger.reserve(project, p.preparationId, grant.token);
  assert.equal(h.snapshot.request.url, "https://example.invalid/");
  assert.equal(h.binding.password, "secret-password");
  assert.equal(h.review.command[2], "value");
  assert.throws(() => {
    h.snapshot.request.url = "mutated";
  });
  assert.doesNotMatch(
    JSON.stringify(ledger.status(project, p.preparationId)),
    /secret|private-target|value|token/,
  );
});

test("authorization binds exact project, digest, phase, ordinal and explicit TTL replacement acknowledgement", async () => {
  const ledger = new NativeWriteAuthorizations();
  const p = await ledger.prepare(project, input());
  for (const bad of [
    { digest: "wrong" },
    { phase: "after" },
    { ordinal: 0 },
    { acknowledgeReplacement: false },
  ])
    await assert.rejects(
      ledger.authorize(project, p.preparationId, { ...auth(p), ...bad }),
    );
  await assert.rejects(ledger.authorize("project-b", p.preparationId, auth(p)));
  assert.throws(() => ledger.status("project-b", p.preparationId));
  assert.throws(() => ledger.revoke("project-b", p.preparationId));
  const grant = await ledger.authorize(project, p.preparationId, auth(p));
  await assert.rejects(
    ledger.reserve("project-b", p.preparationId, grant.token),
  );
  const fresh = new NativeWriteAuthorizations();
  await assert.rejects(fresh.reserve(project, p.preparationId, grant.token));
});

test("concurrent authorization and reservation allow only one transition", async () => {
  const gate = deferred();
  let gateOn = false;
  const ledger = new NativeWriteAuthorizations();
  const p = await ledger.prepare(
    project,
    input({
      checkAdmission: async () => {
        if (gateOn) await gate.promise;
        return true;
      },
    }),
  );
  gateOn = true;
  const pending = [
    ledger.authorize(project, p.preparationId, auth(p)),
    ledger.authorize(project, p.preparationId, auth(p)),
  ];
  gate.resolve();
  const outcomes = await Promise.allSettled(pending);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  const token = outcomes.find((x) => x.status === "fulfilled").value.token;
  const attempts = await Promise.allSettled([
    ledger.reserve(project, p.preparationId, token),
    ledger.reserve(project, p.preparationId, token),
  ]);
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
});

for (const stage of ["authorize", "reserve"])
  test(`queued revoke during ${stage} cannot restore authority`, async () => {
    const gate = deferred();
    let wait = false;
    const ledger = new NativeWriteAuthorizations();
    const p = await ledger.prepare(
      project,
      input({
        checkAdmission: async () => {
          if (wait) await gate.promise;
          return true;
        },
      }),
    );
    const grant =
      stage === "reserve"
        ? await ledger.authorize(project, p.preparationId, auth(p))
        : null;
    wait = true;
    const pending =
      stage === "authorize"
        ? ledger.authorize(project, p.preparationId, auth(p))
        : ledger.reserve(project, p.preparationId, grant.token);
    ledger.revoke(project, p.preparationId);
    gate.resolve();
    await assert.rejects(pending);
    assert.equal(ledger.status(project, p.preparationId).state, "revoked");
  });

test("expiry during async admission is rechecked; reads do not renew authorization", async () => {
  let now = 0,
    wait = false;
  const gate = deferred();
  const ledger = new NativeWriteAuthorizations({ now: () => now });
  const p = await ledger.prepare(
    project,
    input({
      checkAdmission: async () => {
        if (wait) await gate.promise;
        return true;
      },
    }),
  );
  now = 299999;
  assert.equal(ledger.status(project, p.preparationId).expiresAt, 300000);
  wait = true;
  const pending = ledger.authorize(project, p.preparationId, auth(p));
  now = 300000;
  gate.resolve();
  await assert.rejects(pending);
  assert.throws(() => ledger.status(project, p.preparationId));
});

test("session revoke after async lookup blocks reserve and final consume", async () => {
  let live = true;
  const ledger = new NativeWriteAuthorizations();
  const p = await ledger.prepare(project, input({ checkLive: () => live }));
  const grant = await ledger.authorize(project, p.preparationId, auth(p));
  live = false;
  await assert.rejects(ledger.reserve(project, p.preparationId, grant.token));
  live = true;
  await assert.rejects(ledger.reserve(project, p.preparationId, grant.token));
  const { handle: h } = await reserved(ledger, { checkLive: () => live });
  live = false;
  assert.throws(() => h.assertLive());
  assert.throws(() => h.consume());
  ledger.complete(h, result(h));
});

test("definition edits reject new admission but admitted frozen execution does not reread definition", async () => {
  let admission = true,
    reads = 0;
  const ledger = new NativeWriteAuthorizations();
  const options = input({
    checkAdmission: async () => {
      reads++;
      return admission;
    },
  });
  const p = await ledger.prepare(project, options);
  admission = false;
  await assert.rejects(ledger.authorize(project, p.preparationId, auth(p)));
  admission = true;
  const grant = await ledger.authorize(project, p.preparationId, auth(p));
  const h = await ledger.reserve(project, p.preparationId, grant.token);
  const admittedReads = reads;
  admission = false;
  h.assertLive();
  h.consume();
  assert.equal(reads, admittedReads);
  ledger.complete(h, result(h, "acknowledged-applied", "acknowledged"));
});

test("reserved execution survives approval expiry but revoke aborts signal and prohibits dispatch", async () => {
  let now = 0;
  const ledger = new NativeWriteAuthorizations({ now: () => now });
  const { prepared, handle } = await reserved(ledger);
  now = 400000;
  handle.assertLive();
  assert.equal(
    ledger.status(project, prepared.preparationId).state,
    "reserved",
  );
  ledger.revoke(project, prepared.preparationId);
  assert.equal(handle.signal.aborted, true);
  assert.throws(() => handle.consume());
  const status = ledger.complete(handle, result(handle, "not-sent", "revoked"));
  assert.equal(status.writeReceipts[0].outcome, "not-sent");
});

test("post-dispatch revoke and close retain acknowledged fact, even history save failed", async () => {
  const ledger = new NativeWriteAuthorizations();
  const { prepared, handle } = await reserved(ledger);
  handle.consume();
  ledger.revoke(project, prepared.preparationId);
  ledger.close();
  const terminal = ledger.complete(
    handle,
    result(handle, "acknowledged-applied", "acknowledged", {
      persistenceOutcome: {
        code: "PROJECT_COMMIT_UNCERTAIN",
        password: "secret",
        message: "raw",
      },
      response: "large-private-body",
    }),
  );
  assert.equal(terminal.writeReceipts[0].outcome, "acknowledged-applied");
  assert.equal(terminal.persistenceOutcome.code, "PROJECT_COMMIT_UNCERTAIN");
  assert.doesNotMatch(
    JSON.stringify(terminal),
    /password|secret|raw|large-private-body/,
  );
  assert.deepEqual(ledger.status(project, prepared.preparationId), terminal);
  await assert.rejects(ledger.prepare(project, input()));
});

test("closed host cannot finish an in-flight preparation or admission", async () => {
  const gate = deferred();
  const ledger = new NativeWriteAuthorizations();
  const pending = ledger.prepare(
    project,
    input({
      checkAdmission: async () => {
        await gate.promise;
        return true;
      },
    }),
  );
  ledger.close();
  gate.resolve();
  await assert.rejects(pending);
});

test("terminal lookup does not consult storage and does not renew retention or reopen token", async () => {
  let now = 0,
    storage = true;
  const ledger = new NativeWriteAuthorizations({ now: () => now });
  const { prepared, grant, handle } = await reserved(ledger, {
    checkAdmission: async () => storage,
  });
  now = 1234;
  ledger.complete(handle, result(handle));
  storage = false;
  now = 300000;
  assert.equal(
    ledger.status(project, prepared.preparationId).expiresAt,
    301234,
  );
  ledger.revoke(project, prepared.preparationId);
  assert.equal(
    ledger.status(project, prepared.preparationId).expiresAt,
    301234,
  );
  await assert.rejects(
    ledger.reserve(project, prepared.preparationId, grant.token),
  );
  now = 301234;
  assert.throws(() => ledger.status(project, prepared.preparationId));
});

test("20 entry ceiling never evicts active or unexpired terminal outcomes", async () => {
  let now = 0;
  const ledger = new NativeWriteAuthorizations({ now: () => now });
  const { prepared, handle } = await reserved(ledger);
  for (let i = 0; i < 19; i++) await ledger.prepare(project, input());
  await assert.rejects(ledger.prepare(project, input()), {
    code: "NATIVE_WRITE_CAPACITY",
  });
  now = 300001;
  const next = await ledger.prepare(project, input());
  assert.ok(next.preparationId);
  assert.equal(
    ledger.status(project, prepared.preparationId).state,
    "reserved",
  );
  ledger.complete(handle, result(handle));
  for (let i = 0; i < 18; i++) await ledger.prepare(project, input());
  await assert.rejects(ledger.prepare(project, input()), {
    code: "NATIVE_WRITE_CAPACITY",
  });
  assert.equal(
    ledger.status(project, prepared.preparationId).state,
    "completed",
  );
});

test("snapshot and total retained-payload caps reject without leaking oversized secrets", async () => {
  const ledger = new NativeWriteAuthorizations();
  await assert.rejects(
    ledger.prepare(
      project,
      input({ snapshot: { data: "x".repeat(4 * 1024 * 1024) } }),
    ),
    { code: "NATIVE_WRITE_CAPACITY" },
  );
  const large = { data: "x".repeat(3 * 1024 * 1024) };
  await ledger.prepare(project, input({ snapshot: large }));
  await ledger.prepare(project, input({ snapshot: large }));
  await assert.rejects(ledger.prepare(project, input({ snapshot: large })), {
    code: "NATIVE_WRITE_CAPACITY",
  });
  await assert.rejects(
    ledger.prepare(
      project,
      input({
        checkAdmission: async () => {
          throw Error("private password");
        },
      }),
    ),
    (error) => !error.message.includes("private password"),
  );
});

test("invalid manifest/async live guard cannot authorize and extra receipt data cannot enter cache", async () => {
  const ledger = new NativeWriteAuthorizations();
  for (const patch of [
    { ordinal: 16 },
    { phase: "x" },
    { command: ["SET", "key", "value", "NX"] },
    { command: ["SET", "key", "{{secret}}"] },
    { command: ["SET", "key", "\ud800"] },
  ])
    await assert.rejects(
      ledger.prepare(project, input({ review: { ...review(), ...patch } })),
    );
  await assert.rejects(
    ledger.prepare(project, input({ checkLive: async () => true })),
  );
  const { handle } = await reserved(ledger);
  const r = result(handle);
  r.writeReceipts[0] = { ...r.writeReceipts[0], password: "secret" };
  assert.throws(() => ledger.complete(handle, r));
  ledger.complete(handle, result(handle));
});

test("completion requires exact prepared receipt identity and dispatch-consistent outcome", async () => {
  const ledger = new NativeWriteAuthorizations();
  const { handle } = await reserved(ledger);
  for (const [key, value] of Object.entries({
    projectId: "other",
    runId: "other",
    preparationId: "other",
    phase: "after",
    ordinal: 2,
    connectionId: "other",
    taskId: "other",
    commandDigest: "a".repeat(64),
  })) {
    const r = result(handle);
    r.writeReceipts[0] = { ...r.writeReceipts[0], [key]: value };
    assert.throws(() => ledger.complete(handle, r));
  }
  assert.throws(() =>
    ledger.complete(
      handle,
      result(handle, "acknowledged-applied", "acknowledged"),
    ),
  );
  handle.consume();
  const receipt = ledger.complete(
    handle,
    result(handle, "unknown", "transport"),
  );
  assert.equal(receipt.writeReceipts[0].outcome, "unknown");
  assert.deepEqual(ledger.complete(handle, {}), receipt);
});

for (const stage of ["authorize", "reserve"])
  test(`session revoke in final ${stage} microtask gap is rejected`, async () => {
    let live = true,
      race = false;
    const ledger = new NativeWriteAuthorizations();
    const p = await ledger.prepare(
      project,
      input({
        checkLive: () => live,
        checkAdmission: async () => {
          if (race)
            queueMicrotask(() =>
              queueMicrotask(() => {
                live = false;
              }),
            );
          return true;
        },
      }),
    );
    const grant =
      stage === "reserve"
        ? await ledger.authorize(project, p.preparationId, auth(p))
        : null;
    race = true;
    await assert.rejects(
      stage === "authorize"
        ? ledger.authorize(project, p.preparationId, auth(p))
        : ledger.reserve(project, p.preparationId, grant.token),
    );
  });
test("safe target identity is explicit in owner review and excludes TLS CA and password", async () => {
  const ledger = new NativeWriteAuthorizations();
  const i = input();
  i.review.safeTarget = {
    host: "redis.internal",
    port: 6380,
    database: 2,
    ssl: true,
    password: "secret",
    ca: "private-ca",
  };
  const p = await ledger.prepare(project, i);
  assert.deepEqual(p.review.safeTarget, {
    host: "redis.internal",
    port: 6380,
    database: 2,
    ssl: true,
  });
  assert.doesNotMatch(JSON.stringify(p), /private-ca|password/);
  await assert.rejects(
    ledger.prepare(
      project,
      input({
        review: {
          ...review(),
          safeTarget: { host: "", port: 0, database: -1, ssl: false },
        },
      }),
    ),
  );
});

test("pending preparations reserve aggregate bytes before their asynchronous admission", async () => {
  const ledger = new NativeWriteAuthorizations();
  const gate = deferred();
  const options = () =>
    input({
      snapshot: { data: "x".repeat(3 * 1024 * 1024) },
      checkAdmission: async () => {
        await gate.promise;
        return true;
      },
    });
  const a = ledger.prepare(project, options()),
    b = ledger.prepare(project, options());
  await assert.rejects(ledger.prepare(project, options()), {
    code: "NATIVE_WRITE_CAPACITY",
  });
  gate.resolve();
  await Promise.all([a, b]);
});
test("pending entry ceiling is counted and failed admissions release reserved capacity", async () => {
  const ledger = new NativeWriteAuthorizations();
  const gate = deferred();
  const pending = Array.from({ length: 20 }, () =>
    ledger.prepare(
      project,
      input({
        checkAdmission: async () => {
          await gate.promise;
          return false;
        },
      }),
    ),
  );
  const settled = Promise.allSettled(pending);
  await assert.rejects(ledger.prepare(project, input()), {
    code: "NATIVE_WRITE_CAPACITY",
  });
  gate.resolve();
  assert.ok((await settled).every((x) => x.status === "rejected"));
  assert.ok((await ledger.prepare(project, input())).preparationId);
});
test("consumed slot can truthfully finish not-sent after synchronous final guard cancellation", async () => {
  const ledger = new NativeWriteAuthorizations();
  const { handle, prepared, grant } = await reserved(ledger);
  handle.consume();
  ledger.revoke(project, prepared.preparationId);
  assert.equal(
    ledger.complete(handle, result(handle, "not-sent", "cancelled"))
      .writeReceipts[0].outcome,
    "not-sent",
  );
  await assert.rejects(
    ledger.reserve(project, prepared.preparationId, grant.token),
  );
});

test("host release hook runs once on expiry/revoke/completion and waits for active close drain", async () => {
  let now = 0;
  const released = [];
  const ledger = new NativeWriteAuthorizations({ now: () => now });
  const p = await ledger.prepare(
    project,
    input({ onRelease: (id) => released.push(id) }),
  );
  ledger.revoke(project, p.preparationId);
  ledger.revoke(project, p.preparationId);
  assert.deepEqual(released, [p.preparationId]);
  const exp = await ledger.prepare(
    project,
    input({ onRelease: (id) => released.push(id) }),
  );
  now = 300001;
  assert.throws(() => ledger.status(project, exp.preparationId));
  assert.ok(released.includes(exp.preparationId));
  const { prepared, handle } = await reserved(ledger, {
    onRelease: (id) => released.push(id),
  });
  ledger.close();
  assert.ok(!released.includes(prepared.preparationId));
  ledger.complete(handle, result(handle, "not-sent", "cancelled"));
  assert.equal(released.filter((x) => x === prepared.preparationId).length, 1);
});

test("outer host preparation tickets reserve capacity before project IO and release on failure", async () => {
  const ledger = new NativeWriteAuthorizations();
  const ticket = ledger.beginPreparation();
  assert.throws(() => ledger.beginPreparation(), {
    code: "NATIVE_WRITE_CAPACITY",
  });
  const options = input();
  const p = await ledger.prepare(project, { ...options, reservation: ticket });
  assert.equal(Object.isFrozen(options.snapshot), true);
  ledger.cancelPreparation(ticket);
  const next = ledger.beginPreparation();
  ledger.cancelPreparation(next);
  assert.equal(ledger.status(project, p.preparationId).state, "prepared");
  await assert.rejects(
    ledger.prepare(project, { ...input(), reservation: ticket }),
  );
});

test("outer preparation ticket cannot be reused concurrently or publish after cancellation", async () => {
  const ledger = new NativeWriteAuthorizations();
  const ticket = ledger.beginPreparation();
  const gate = deferred();
  const pending = ledger.prepare(project, {
    ...input({
      checkAdmission: async () => {
        await gate.promise;
        return true;
      },
    }),
    reservation: ticket,
  });
  await assert.rejects(
    ledger.prepare(project, { ...input(), reservation: ticket }),
  );
  ledger.cancelPreparation(ticket);
  assert.throws(() => ledger.beginPreparation(), {
    code: "NATIVE_WRITE_CAPACITY",
  });
  gate.resolve();
  await assert.rejects(pending);
  const replacement = ledger.beginPreparation();
  ledger.cancelPreparation(replacement);
});

test("host releases ticket after validation failure before asynchronous admission", async () => {
  const ledger = new NativeWriteAuthorizations();
  const ticket = ledger.beginPreparation();
  await assert.rejects(
    ledger.prepare(project, { ...input(), review: {}, reservation: ticket }),
  );
  ledger.cancelPreparation(ticket);
  const next = ledger.beginPreparation();
  ledger.cancelPreparation(next);
});
