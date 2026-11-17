import test from "node:test";
import assert from "node:assert/strict";
import {
  createSocketIOState,
  selectSocketIO,
  invalidateSocketIO,
  createSocketIOController,
  renderSocketIO,
} from "../public/socketio-workbench.js";
const definition = {
  id: "d",
  name: "example",
  url: "http://localhost:3000",
  path: "/socket.io/",
  events: null,
  version: 4,
  transport: "websocket",
  handshake: { headers: [] },
};
const snap = (state = "open") => ({
  id: "s",
  type: "socketio",
  state,
  definition,
  events: [],
  bytes: 0,
  truncated: false,
  connected: state === "open",
});
function fixture(overrides = {}) {
  const state = createSocketIOState();
  selectSocketIO(state, definition);
  const requests = [],
    busy = [],
    saved = [],
    evidence = [];
  const options = {
    state,
    definitions: [definition],
    assertCurrent() {},
    setBusy: (...x) => busy.push(x),
    saveDefinition: async (d) => (saved.push(d), d),
    post: async (...x) => (requests.push(x), snap()),
    get: async () => [],
    uid: () => "new",
    persistEvidence(s) {
      evidence.push({
        uncertainStart: s.uncertainStart,
        uncertainSessions: [...s.uncertainSessions],
      });
      return true;
    },
    ...overrides,
  };
  return {
    state,
    requests,
    busy,
    saved,
    evidence,
    controller: createSocketIOController(options),
    options,
  };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
test("definition save excludes runtime and retains handshake", async () => {
  const f = fixture();
  for (const k of ["auth", "query", "headers"])
    f.controller.edit(k, '{"token":"private"}');
  f.controller.edit("key", "private-key");
  f.controller.edit("events", '["reply"]');
  await f.controller.save();
  assert.equal(f.saved.length, 1);
  assert.deepEqual(f.saved[0].handshake, definition.handshake);
  assert.deepEqual(f.saved[0].events, ["reply"]);
  assert.equal(JSON.stringify(f.saved).includes("private"), false);
  assert.equal(f.state.draftDirty, false);
});
test("partial events JSON remains editable and rejected only at save", async () => {
  const f = fixture();
  f.controller.edit("events", "[");
  assert.equal(f.state.eventsText, "[");
  await assert.rejects(f.controller.save());
  assert.equal(f.saved.length, 0);
});
test("saved switch requires explicit discard and keeps old draft", () => {
  const f = fixture({ confirmDiscard: () => false });
  f.controller.edit("name", "changed");
  assert.equal(f.controller.select(""), false);
  assert.equal(f.state.definition.name, "changed");
});
test("definition switch keeps uncertainty and session", () => {
  const f = fixture({ confirmDiscard: () => true });
  f.state.uncertainStart = true;
  f.state.uncertainSessions = ["s"];
  f.state.session = snap();
  f.controller.select("");
  assert.equal(f.state.uncertainStart, true);
  assert.deepEqual(f.state.uncertainSessions, ["s"]);
  assert.equal(f.state.session.id, "s");
});
test("connect marks recoverable intent before posting and gates duplicate", async () => {
  const held = deferred();
  let calls = 0;
  const f = fixture({
    post: async () => {
      calls++;
      assert.equal(f.state.uncertainStart, true);
      return held.promise;
    },
  });
  const first = f.controller.connect();
  await assert.rejects(f.controller.connect());
  assert.equal(calls, 1);
  held.resolve(snap("connecting"));
  await first;
  assert.equal(f.state.session.state, "connecting");
  assert.equal(f.state.uncertainStart, false);
  assert.equal(f.evidence[0].uncertainStart, true);
  assert.equal(f.evidence.at(-1).uncertainStart, false);
});
test("storage failure blocks connect before network", async () => {
  const f = fixture({ persistEvidence: () => false });
  await f.controller.connect();
  assert.equal(f.requests.length, 0);
  assert.equal(f.state.uncertainStart, true);
});
test("missing evidence callback blocks new effects", async () => {
  const f = fixture({ persistEvidence: undefined });
  await f.controller.connect();
  assert.equal(f.requests.length, 0);
});
test("unknown connect does not retry or claim listed session", async () => {
  let calls = 0;
  const f = fixture({
    post: async () => {
      calls++;
      throw Error("lost");
    },
    get: async () => [snap()],
  });
  await f.controller.connect();
  await f.controller.list();
  assert.equal(f.state.session, null);
  assert.equal(f.state.uncertainStart, true);
  await assert.rejects(f.controller.connect());
  assert.equal(calls, 1);
  f.controller.chooseSession("s");
  assert.equal(f.state.session.id, "s");
  await assert.rejects(f.controller.send());
});
test("late connect does not update current selection", async () => {
  const held = deferred();
  const f = fixture({ post: () => held.promise });
  const p = f.controller.connect();
  invalidateSocketIO(f.state);
  held.resolve(snap());
  await p;
  assert.equal(f.state.session, null);
  assert.equal(f.state.lateResult.id, "s");
  assert.equal(f.state.uncertainStart, true);
});
test("leave panel clears runtime but keeps evidence", () => {
  const f = fixture();
  for (const k of ["auth", "query", "headers", "ca", "cert", "key"])
    f.state[k] = "private";
  f.state.uncertainStart = true;
  invalidateSocketIO(f.state);
  for (const k of ["auth", "query", "headers"]) assert.equal(f.state[k], "{}");
  for (const k of ["ca", "cert", "key"]) assert.equal(f.state[k], "");
  assert.equal(f.state.uncertainStart, true);
});
test("dirty definition never connects", async () => {
  const f = fixture();
  f.controller.edit("name", "dirty");
  await assert.rejects(f.controller.connect());
  assert.equal(f.requests.length, 0);
});
test("send ack stores exact receipt and clears temporary unknown marker", async () => {
  const receipt = {
    status: "acknowledged",
    remoteOutcome: "acknowledged",
    args: [{ ok: true }],
  };
  const f = fixture({ post: async () => receipt });
  f.state.session = snap();
  f.state.event = "echo";
  f.state.args = '[{"value":1}]';
  await f.controller.send();
  assert.deepEqual(f.state.result, receipt);
  assert.deepEqual(f.state.uncertainSessions, []);
  assert.deepEqual(f.evidence[0].uncertainSessions, ["s"]);
});
for (const status of ["sent", "ack-timeout", "disconnected"]) {
  test(
    status + " blocks repeat and read-only refresh cannot erase unknown",
    async () => {
      let calls = 0;
      const f = fixture({
        post: async () => {
          calls++;
          return { status, remoteOutcome: "unknown" };
        },
        get: async () => snap(),
      });
      f.state.session = snap();
      f.state.event = "echo";
      await f.controller.send();
      await f.controller.poll();
      assert.deepEqual(f.state.uncertainSessions, ["s"]);
      await assert.rejects(f.controller.send());
      assert.equal(calls, 1);
    },
  );
}
test("failed send does not auto retry", async () => {
  let calls = 0;
  const f = fixture({
    post: async () => {
      calls++;
      throw Error("lost");
    },
  });
  f.state.session = snap();
  f.state.event = "echo";
  await f.controller.send();
  await assert.rejects(f.controller.send());
  assert.equal(calls, 1);
});
test("storage failure blocks send", async () => {
  const f = fixture({ persistEvidence: () => false });
  f.state.session = snap();
  await f.controller.send();
  assert.equal(f.requests.length, 0);
});
test("session mismatched definition cannot send", async () => {
  const f = fixture();
  f.state.session = { ...snap(), definition: { ...definition, id: "other" } };
  await assert.rejects(f.controller.send());
  assert.equal(f.requests.length, 0);
});
test("stop works while send pending, blocks duplicate and retains unknown", async () => {
  const held = deferred(),
    stopped = deferred();
  let stopCalls = 0;
  const f = fixture({
    post: (path) => {
      if (path.endsWith("/send")) return held.promise;
      stopCalls++;
      return stopped.promise;
    },
  });
  f.state.session = snap();
  f.state.event = "echo";
  const send = f.controller.send();
  const stop = f.controller.stop();
  await f.controller.stop();
  assert.equal(stopCalls, 1);
  held.resolve({ status: "disconnected", remoteOutcome: "unknown" });
  await send;
  assert.equal(
    f.busy.some((x) => x[0] === false),
    false,
  );
  stopped.resolve({ ...snap("closed"), recordSaved: true });
  await stop;
  assert.equal(f.state.session.state, "closed");
  assert.deepEqual(f.state.uncertainSessions, ["s"]);
  assert.equal(f.busy.at(-1)[0], false);
});
test("stop record failure is not a transport failure or success claim", async () => {
  const f = fixture({
    post: async () => ({ ...snap("closed"), recordSaved: false }),
  });
  f.state.session = snap();
  await f.controller.stop();
  assert.equal(f.state.session.state, "closed");
  assert.match(f.state.notice, /记录未保存/);
  assert.deepEqual(f.state.uncertainSessions, ["s"]);
});
test("GET closed never implies record saved", async () => {
  const f = fixture({ get: async () => snap("closed") });
  f.state.session = snap();
  await f.controller.poll();
  assert.equal(f.state.session.recordSaved, undefined);
  assert.match(f.state.notice, /不会.*补存/);
});
test("read-only list and refresh do not POST", async () => {
  const f = fixture({
    get: async (path) => (path === "socketio-sessions" ? [snap()] : snap()),
  });
  await f.controller.list();
  f.controller.chooseSession("s");
  await f.controller.poll();
  assert.equal(f.requests.length, 0);
});
test("render escapes payload and states limitations", () => {
  const f = fixture();
  f.state.definition.name = '<img src=x onerror="bad">';
  f.state.session = { ...snap(), events: [{ args: ["<script>bad</script>"] }] };
  const html = renderSocketIO(f.state, [f.state.definition]);
  assert.equal(html.includes("<script>bad"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /本地提交不代表远端业务成功/);
  assert.match(html, /不会自动|不自动/);
});

test("same ID with changed target cannot send on stale session", async () => {
  const f = fixture();
  f.state.session = {
    ...snap(),
    definition: { ...definition, url: "http://localhost:9000" },
  };
  await assert.rejects(f.controller.send());
  assert.equal(f.requests.length, 0);
});

test("stop persistence failure survives a later send ack", async () => {
  const held = deferred();
  const f = fixture({
    post: (path) =>
      path.endsWith("/send")
        ? held.promise
        : Promise.resolve({ ...snap("closed"), recordSaved: false }),
  });
  f.state.session = snap();
  f.state.event = "echo";
  const p = f.controller.send();
  await f.controller.stop();
  held.resolve({
    status: "acknowledged",
    remoteOutcome: "acknowledged",
    args: [],
  });
  await p;
  assert.deepEqual(f.state.uncertainSessions, ["s"]);
  assert.deepEqual(f.state.stopProblems, ["s"]);
  assert.equal(f.state.stopReceipts.s.recordSaved, false);
  assert.match(renderSocketIO(f.state), /停止或记录保存仍需核对/);
});
test("lost stop survives later send ack", async () => {
  const held = deferred();
  const f = fixture({
    post: (path) =>
      path.endsWith("/send") ? held.promise : Promise.reject(Error("lost")),
  });
  f.state.session = snap();
  f.state.event = "echo";
  const p = f.controller.send();
  await f.controller.stop();
  held.resolve({
    status: "acknowledged",
    remoteOutcome: "acknowledged",
    args: [],
  });
  await p;
  assert.deepEqual(f.state.uncertainSessions, ["s"]);
  assert.deepEqual(f.state.stopProblems, ["s"]);
});

test("inconsistent send receipt fails closed", async () => {
  const f = fixture({
    post: async () => ({ status: "sent", remoteOutcome: "acknowledged" }),
  });
  f.state.session = snap();
  await f.controller.send();
  assert.deepEqual(f.state.uncertainSessions, ["s"]);
  assert.equal(f.state.result, null);
});

test("stop intent persists before dispatch and success does not erase prior send unknown", async () => {
  const f = fixture({
    post: async () => {
      assert.deepEqual(f.evidence.at(-1).uncertainSessions, ["s"]);
      assert.deepEqual(f.state.stopProblems, ["s"]);
      return { ...snap("closed"), recordSaved: true };
    },
  });
  f.state.session = snap();
  f.state.uncertainSessions = ["s"];
  await f.controller.stop();
  assert.deepEqual(f.state.stopProblems, []);
  assert.deepEqual(f.state.uncertainSessions, ["s"]);
});
test("ordinary successful stop clears only its own pending markers", async () => {
  const f = fixture({
    post: async () => ({ ...snap("closed"), recordSaved: true }),
  });
  f.state.session = snap();
  await f.controller.stop();
  assert.deepEqual(f.state.stopProblems, []);
  assert.deepEqual(f.state.uncertainSessions, []);
});
test("unavailable recovery storage does not prevent safety stop and warns", async () => {
  let calls = 0;
  const f = fixture({
    persistEvidence: () => false,
    post: async () => {
      calls++;
      return { ...snap("closed"), recordSaved: true };
    },
  });
  f.state.session = snap();
  await f.controller.stop();
  assert.equal(calls, 1);
  assert.match(f.state.notice, /恢复标记保存失败/);
});

test("restored stop problems block new effects but allow read-only recovery", async () => {
  const f = fixture({ get: async () => [] });
  f.state.stopProblems = ["s"];
  await assert.rejects(f.controller.save());
  await assert.rejects(f.controller.connect());
  await assert.rejects(f.controller.send());
  await f.controller.list();
  assert.equal(f.requests.length, 0);
  assert.equal(f.saved.length, 0);
});

test("incoming ack uses current evidence once and distinguishes local receipt", async () => {
  const calls = [];
  const f = fixture({
    post: async (...x) => (calls.push(x), { acknowledged: true }),
  });
  f.state.session = {
    ...snap(),
    events: [
      { direction: "received", ackId: "a", event: "question", args: [] },
    ],
  };
  f.state.incomingAckId = "a";
  f.state.incomingAckArgs = '[{"answer":42}]';
  const c = createSocketIOController(f.options);
  await c.acknowledge();
  assert.deepEqual(calls, [
    ["socketio-sessions/s/ack", { ackId: "a", args: [{ answer: 42 }] }],
  ]);
  assert.equal(f.state.result.remoteOutcome, "unknown");
  await assert.rejects(c.acknowledge());
  assert.equal(calls.length, 1);
});
test("lost incoming ack receipt blocks resend and survives view invalidation", async () => {
  let calls = 0;
  const f = fixture({
    post: async () => {
      calls++;
      throw Error("lost");
    },
  });
  f.state.session = {
    ...snap(),
    events: [{ direction: "received", ackId: "a" }],
  };
  f.state.incomingAckId = "a";
  const c = createSocketIOController(f.options);
  await c.acknowledge();
  invalidateSocketIO(f.state);
  assert.deepEqual(f.state.uncertainSessions, ["s"]);
  await assert.rejects(c.acknowledge());
  assert.equal(calls, 1);
});
test("unknown or foreign incoming ID and oversized arrays never dispatch", async () => {
  let calls = 0;
  const f = fixture({ post: async () => calls++ });
  f.state.session = snap();
  f.state.incomingAckId = "foreign";
  const c = createSocketIOController(f.options);
  await assert.rejects(c.acknowledge());
  f.state.session.events = [{ direction: "received", ackId: "a" }];
  f.state.incomingAckId = "a";
  f.state.incomingAckArgs = JSON.stringify(Array(101).fill(0));
  await assert.rejects(c.acknowledge());
  assert.equal(calls, 0);
});
function ackFixture(overrides = {}) {
  const f = fixture(overrides);
  f.state.session = {
    ...snap(),
    events: [{ direction: "received", ackId: "a" }],
  };
  f.state.incomingAckId = "a";
  return f;
}
test("ack duplicate clicks dispatch once while pending", async () => {
  const d = deferred();
  let calls = 0;
  const f = ackFixture({
    post: async () => {
      calls++;
      return d.promise;
    },
  });
  const p = f.controller.acknowledge();
  await assert.rejects(f.controller.acknowledge());
  d.resolve({ acknowledged: true });
  await p;
  assert.equal(calls, 1);
});
test("ack storage unavailable never dispatches", async () => {
  let calls = 0;
  const f = ackFixture({
    post: async () => calls++,
    persistEvidence: () => false,
  });
  await f.controller.acknowledge();
  assert.equal(calls, 0);
  assert.deepEqual(f.state.uncertainSessions, ["s"]);
});
test("expired ack refusal remains visible unknown and does not replay", async () => {
  let calls = 0;
  const f = ackFixture({
    post: async () => {
      calls++;
      throw Error("确认标识不存在或已过期");
    },
  });
  await f.controller.acknowledge();
  assert.match(f.state.notice, /已过期/);
  await assert.rejects(f.controller.acknowledge());
  assert.equal(calls, 1);
});
test("late ack cannot change newer view or remove its unknown evidence", async () => {
  const d = deferred();
  const f = ackFixture({ post: () => d.promise });
  const p = f.controller.acknowledge();
  invalidateSocketIO(f.state);
  d.resolve({ acknowledged: true });
  await p;
  assert.equal(f.state.result, null);
  assert.deepEqual(f.state.uncertainSessions, ["s"]);
});
test("stop remains available during incoming ack and late ack cannot clear stop failure", async () => {
  const d = deferred();
  const f = ackFixture({
    post: (path) =>
      path.endsWith("/ack") ? d.promise : Promise.reject(Error("lost stop")),
  });
  const p = f.controller.acknowledge();
  await f.controller.stop();
  d.resolve({ acknowledged: true });
  await p;
  assert.deepEqual(f.state.stopProblems, ["s"]);
  assert.deepEqual(f.state.uncertainSessions, ["s"]);
});

test("incoming ack local receipt quota fails closed without dropping evidence", async () => {
  const f = ackFixture();
  f.state.incomingAckReceipts = Array.from({ length: 1000 }, (_, i) => ({
    sessionId: "s",
    ackId: String(i),
  }));
  await assert.rejects(f.controller.acknowledge(), /1000/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.state.incomingAckReceipts.length, 1000);
});
