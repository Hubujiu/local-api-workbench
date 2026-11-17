import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";
import { ProtocolSessionIntents } from "../src/protocol-session-intents.mjs";
import { createApp } from "../src/server.mjs";
const definition = { type: "tcp", host: "127.0.0.1", port: 1 };
function fake() {
  const sessions = new Map();
  let calls = 0;
  return {
    sessions,
    get calls() {
      return calls;
    },
    start(input, { onAllocated }) {
      calls++;
      const id = randomUUID();
      sessions.set(id, { id, state: "open", type: input.type });
      onAllocated(id);
      return this.snapshot(id);
    },
    snapshot(id) {
      return structuredClone(sessions.get(id));
    },
    stop(id) {
      sessions.get(id).state = "closed";
    },
  };
}
test("same intent canonical definitions reuse, changed payload conflicts; no definition retained", () => {
  const s = fake(),
    m = new ProtocolSessionIntents(s),
    id = randomUUID();
  const first = m.start(id, m.instanceId, definition);
  assert.deepEqual(
    m.start(id, m.instanceId, { port: 1, host: "127.0.0.1", type: "tcp" }),
    first,
  );
  assert.throws(
    () => m.start(id, m.instanceId, { ...definition, port: 2 }),
    (e) => e.intentStatus === 409,
  );
  assert.equal(s.calls, 1);
  assert.deepEqual(Object.keys(m.entries.get(id)).sort(), [
    "digest",
    "phase",
    "sessionId",
  ]);
});
test("stop before start tombstones, expiration never reopens; cap is lifetime and closing preserves reads/stops", () => {
  const s = fake(),
    m = new ProtocolSessionIntents(s),
    id = randomUUID();
  assert.equal(m.stop(id, m.instanceId).phase, "cancelled");
  assert.equal(m.start(id, m.instanceId, definition).phase, "cancelled");
  assert.equal(s.calls, 0);
  const active = randomUUID(),
    r = m.start(active, m.instanceId, definition);
  s.sessions.delete(r.sessionId);
  assert.equal(m.read(active).phase, "expired");
  m.start(active, m.instanceId, definition);
  assert.equal(s.calls, 1);
  for (let i = 2; i < 256; i++) m.stop(randomUUID(), m.instanceId);
  assert.throws(
    () => m.start(randomUUID(), m.instanceId, definition),
    (e) => e.intentStatus === 429,
  );
  assert.equal(m.entries.size, 256);
  m.close();
  assert.throws(
    () => m.start(id, m.instanceId, definition),
    (e) => e.intentStatus === 503,
  );
  assert.throws(
    () => m.stop(randomUUID(), m.instanceId),
    (e) => e.intentStatus === 503,
  );
  assert.equal(m.stop(id, m.instanceId).phase, "cancelled");
  assert.equal(m.read(active).phase, "expired");
});
test("failure before/after allocation retains unknown and cannot replay or pretend absent stop succeeded", () => {
  for (const allocated of [false, true]) {
    const s = fake();
    let calls = 0;
    s.start = (input, { onAllocated }) => {
      calls++;
      if (allocated) {
        const id = randomUUID();
        s.sessions.set(id, { id, type: "tcp", state: "connecting" });
        onAllocated(id);
      }
      throw Error("secret failure");
    };
    const m = new ProtocolSessionIntents(s),
      id = randomUUID();
    const r = m.start(id, m.instanceId, definition);
    assert.equal(r.phase, "unknown");
    assert.equal(Boolean(r.sessionId), allocated);
    m.start(id, m.instanceId, definition);
    assert.equal(calls, 1);
    assert.equal(
      m.stop(id, m.instanceId).phase,
      allocated ? "cancelled" : "unknown",
    );
    assert.ok(!JSON.stringify(m.read(id)).includes("secret"));
  }
});
test("known ID stop failures remain unknown; foreign project and stale instance fail closed", () => {
  const s = fake(),
    m = new ProtocolSessionIntents(s),
    id = randomUUID();
  assert.throws(
    () => m.start(id, randomUUID(), definition),
    (e) => e.intentStatus === 409,
  );
  assert.equal(s.calls, 0);
  const r = m.start(id, m.instanceId, definition);
  s.stop = () => {
    throw Error("fail");
  };
  assert.equal(m.stop(id, m.instanceId).phase, "unknown");
  s.sessions.get(r.sessionId).projectId = "foreign";
  assert.throws(
    () => m.read(id),
    (e) => e.intentStatus === 403,
  );
  assert.throws(
    () => m.stop(id, m.instanceId),
    (e) => e.intentStatus === 403,
  );
});
test("trusted allocation hook failure leaves no registry or TCP transport", async (t) => {
  let connections = 0;
  const target = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => target.close(r)));
  const s = new ProtocolSessions();
  assert.throws(
    () =>
      s.start(
        { ...definition, port: target.address().port },
        {
          onAllocated() {
            throw Error("hook");
          },
        },
      ),
    /hook/,
  );
  assert.equal(s.sessions.size, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(connections, 0);
  await s.close();
});
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "intent-http-")),
    app = await createApp({ root, port: 0 });
  const sockets = new Set();
  let hits = 0;
  const target = net.createServer((socket) => {
    hits++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    for (const s of sockets) s.destroy();
    await new Promise((r) => target.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (
    url,
    method = "GET",
    body,
    expected = 200,
    token = app.token,
  ) => {
    const response = await fetch(app.url + url, {
      method,
      headers: { "x-local-token": token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  const session = await call("/api/session");
  return {
    app,
    call,
    instanceId: session.instanceId,
    definition: { ...definition, port: target.address().port },
    hits: () => hits,
  };
}
test("actual owner HTTP concurrent same-key starts one TCP socket, lost receipt recovers read-only and stop cannot reopen", async (t) => {
  const f = await fixture(t),
    id = randomUUID(),
    url = `/api/protocol-session-intents/${id}`,
    body = { instanceId: f.instanceId, definition: f.definition };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.call(url, "POST", body)),
  );
  assert.equal(new Set(results.map((r) => r.sessionId)).size, 1);
  for (let i = 0; i < 100 && !f.hits(); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.hits(), 1);
  const restored = await f.call(url);
  assert.equal(restored.sessionId, results[0].sessionId);
  assert.equal(f.hits(), 1);
  await f.call(
    url,
    "POST",
    { ...body, definition: { ...f.definition, port: 1 } },
    409,
  );
  const stopped = await f.call(url + "/stop", "POST", {
    instanceId: f.instanceId,
  });
  assert.equal(stopped.phase, "cancelled");
  assert.equal(stopped.session.state, "closed");
  assert.equal((await f.call(url, "POST", body)).phase, "cancelled");
  assert.equal(f.hits(), 1);
});
test("actual HTTP stop-first, unauthorized, stale instance, malformed path and project input cannot start", async (t) => {
  const f = await fixture(t),
    id = randomUUID(),
    url = `/api/protocol-session-intents/${id}`,
    body = { instanceId: f.instanceId, definition: f.definition };
  await f.call(url, "POST", body, 403, "bad");
  await f.call(url, "GET", undefined, 404);
  await f.call(url, "POST", { ...body, instanceId: randomUUID() }, 409);
  await f.call(
    url,
    "POST",
    { ...body, definition: { ...f.definition, projectId: "foreign" } },
    400,
  );
  await f.call(url + "/extra", "POST", body, 400);
  await f.call(url + "?x=1", "POST", body, 400);
  await f.call("/api/protocol-session-intents/not-uuid", "POST", body, 400);
  const tombstone = await f.call(url + "/stop", "POST", {
    instanceId: f.instanceId,
  });
  assert.equal(tombstone.session, null);
  assert.equal(tombstone.sessionId, null);
  assert.equal((await f.call(url, "POST", body)).phase, "cancelled");
  assert.equal(f.hits(), 0);
});
