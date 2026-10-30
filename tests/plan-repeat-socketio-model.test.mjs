// Inspected pure graph/connection admission; no sessions, app or transport starts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRepeatGraph,
  planLeaves,
  activePlanLeaves,
  planOccurrences,
} from "../src/plan-repeat.mjs";
import { SocketIOSessions } from "../src/socketio.mjs";
import { socketioPlanCredentials } from "../src/socketio-plan.mjs";
const leaf = () => ({
  id: "socket",
  type: "socketio",
  socketio: {
    definition: {
      id: "saved",
      url: "http://127.0.0.1:3000",
      version: 4,
      transport: "websocket",
      handshake: { requiredHeaders: ["authorization"] },
    },
    commands: [{ type: "wait", event: "hello", timeoutMs: 1000 }],
  },
});
const graph = () => [
  {
    id: "group",
    type: "repeat",
    count: 2,
    steps: [
      leaf(),
      { id: "http", request: { url: "http://localhost/consume" } },
    ],
  },
];
const credentials = () => ({
  socket: {
    headers: { authorization: "fixture-only" },
    auth: { token: "fixture-auth" },
    query: { token: "fixture-query" },
  },
});
test("Socket.IO repeat retains exact ordered occurrence identity and stable leaf binding", () => {
  const steps = graph(),
    before = structuredClone(steps);
  assert.equal(validateRepeatGraph(steps, { requireIds: true }), true);
  assert.deepEqual(
    planLeaves(steps).map((x) => x.id),
    ["socket", "http"],
  );
  assert.deepEqual(activePlanLeaves(steps), planLeaves(steps));
  assert.deepEqual(
    planOccurrences(steps).map((x) => x.repeat.occurrenceId),
    [
      '["group","socket",0]',
      '["group","http",0]',
      '["group","socket",1]',
      '["group","http",1]',
    ],
  );
  assert.deepEqual(steps, before);
});
test("Socket.IO repeat references require freezing and preserve strict wrappers and budgets", () => {
  const steps = graph();
  steps[0].steps[0].socketio = { definitionId: "saved" };
  assert.equal(validateRepeatGraph(steps), true);
  assert.throws(
    () => validateRepeatGraph(steps, { requireIds: true }),
    /冻结前/,
  );
  steps[0].steps[0].socketio.definition = {};
  assert.throws(() => validateRepeatGraph(steps), /混合/);
  for (const key of ["auth", "headers", "scripts", "nativeMCP"]) {
    const bad = graph();
    bad[0].steps[0][key] = {};
    assert.throws(() => validateRepeatGraph(bad));
  }
  const nested = graph();
  nested[0].steps[0] = {
    id: "nested",
    type: "repeat",
    count: 1,
    steps: [leaf()],
  };
  assert.throws(() => validateRepeatGraph(nested));
  const duplicate = graph();
  duplicate[0].steps[0].id = "group";
  assert.throws(() => validateRepeatGraph(duplicate), /重复/);
  const count = graph();
  count[0].count = 101;
  assert.throws(() => validateRepeatGraph(count));
  const bytes = graph();
  bytes[0].steps[0].socketio.commands = [
    { type: "emit", event: "payload", args: ["x".repeat(3 * 1024 * 1024)] },
  ];
  assert.throws(() => validateRepeatGraph(bytes), /4MiB/);
});
test("Socket.IO required header preflight traverses active groups, supplied maps bind all leaves", () => {
  const plan = { steps: graph() },
    input = credentials();
  assert.throws(() => socketioPlanCredentials(plan));
  const result = socketioPlanCredentials(plan, input);
  assert.deepEqual(result.get("socket"), input.socket);
  input.socket.auth.token = "changed";
  assert.equal(result.get("socket").auth.token, "fixture-auth");
  assert.throws(() =>
    socketioPlanCredentials(plan, {
      '["group","socket",0]': credentials().socket,
    }),
  );
  plan.steps[0].enabled = false;
  assert.equal(socketioPlanCredentials(plan).size, 0);
  assert.equal(socketioPlanCredentials(plan, credentials()).size, 1);
  plan.steps[0].enabled = true;
  plan.steps[0].steps[0].enabled = false;
  assert.equal(socketioPlanCredentials(plan).size, 0);
});
test("Socket.IO repeat retains v2 auth boundary and controlled transport/TLS fields", () => {
  const plan = { steps: graph() };
  for (const extra of [
    { url: "http://elsewhere" },
    { transport: "auto" },
    { version: 2 },
    { query: { EIO: "3" } },
    { headers: { authorization: "x", connection: "upgrade" } },
    { tls: { rejectUnauthorized: false } },
    { tls: { ca: "cleartext-forbidden" } },
  ])
    assert.throws(() =>
      socketioPlanCredentials(plan, {
        socket: { ...credentials().socket, ...extra },
      }),
    );
  const v2 = plan.steps[0].steps[0].socketio.definition;
  v2.version = 2;
  assert.throws(() => socketioPlanCredentials(plan, credentials()), /v2/);
  const compatible = credentials();
  delete compatible.socket.auth;
  assert.equal(socketioPlanCredentials(plan, compatible).size, 1);
  v2.url = "https://localhost";
  assert.throws(
    () =>
      socketioPlanCredentials(plan, {
        socket: { ...compatible.socket, tls: { key: "x" } },
      }),
    /同时/,
  );
});

test("Socket.IO release settles disconnect before removing catch-all and ordinary listeners", () => {
  const sessions = new SocketIOSessions(),
    events = [];
  const state = {
    socket: {
      io: { engine: { transport: { name: "polling" } } },
      disconnect() {
        events.push("disconnect/ack-settle");
      },
      offAny() {
        events.push("offAny");
      },
      removeAllListeners() {
        events.push("removeAllListeners");
      },
    },
  };
  sessions.release(state);
  assert.deepEqual(events, [
    "disconnect/ack-settle",
    "offAny",
    "removeAllListeners",
  ]);
  assert.equal(state.socket, null);
  assert.equal(state.transport, "polling");
  sessions.release(state);
  assert.equal(events.length, 3);
});
