import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Server } from "socket.io";
import { createApp } from "../src/server.mjs";
import {
  createSocketIOState,
  selectSocketIO,
  createSocketIOController,
} from "../public/socketio-workbench.js";
const wait = async (fn) => {
  for (let i = 0; i < 200; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("fixture timed out");
};
test(
  "real Socket.IO lost incoming ack HTTP response recovers by exact local receipt without retransmission",
  { timeout: 15000 },
  async (t) => {
    const server = http.createServer(),
      io = new Server(server);
    let peer,
      connections = 0,
      acks = 0;
    io.on("connection", (s) => {
      peer = s;
      connections++;
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(tmpdir() + "/socketio-ack-recovery-");
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      await app.close();
      await new Promise((r) => io.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const project = await app.store.create("ack recovery"),
      foreign = await app.store.create("other owner");
    const call = async (action, method = "GET", body, pid = project.id) => {
      const response = await fetch(
        app.url + "/api/projects/" + pid + "/" + action,
        {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      const value = await response.json();
      if (!response.ok) throw Error(value.error);
      return value;
    };
    const definition = {
      id: "fixture",
      name: "fixture",
      url: "http://127.0.0.1:" + server.address().port,
      path: "/socket.io/",
      version: 4,
      transport: "websocket",
      events: null,
    };
    project.settings.socketioDefinitions = [definition];
    await app.store.save(project);
    const lostState = createSocketIOState();
    selectSocketIO(lostState, definition);
    let sentBody,
      startBody,
      emitted = 0;
    const lostController = createSocketIOController({
      state: lostState,
      ownerReceipts: true,
      setBusy() {},
      assertCurrent() {},
      persistEvidence: () => true,
      get: call,
      async post(path, body) {
        const result = await call(path, "POST", body);
        if (path === "socketio-creation-intents") return result;
        if (path.endsWith("/send")) sentBody = body;
        else startBody = body;
        throw Error("lost response");
      },
    });
    await lostController.connect();
    assert.equal(lostState.uncertainStart, true);
    await lostController.poll();
    const started = lostState.session;
    assert.equal(lostState.uncertainStart, false);
    await assert.rejects(call("socketio-sessions", "POST", startBody));
    let session = await wait(async () => {
      const s = await call("socketio-sessions/" + started.id);
      return s.state === "open" ? s : null;
    });
    peer.on("echo", (ack) => {
      emitted++;
      ack("received");
    });
    selectSocketIO(lostState, session.definition);
    lostState.session = session;
    lostState.event = "echo";
    await lostController.send();
    assert.deepEqual(lostState.uncertainSessions, [session.id]);
    await lostController.poll();
    assert.deepEqual(lostState.uncertainSessions, []);
    await assert.rejects(
      call("socketio-sessions/" + started.id + "/send", "POST", sentBody),
    );
    assert.equal(emitted, 1);
    peer.emit("question", { text: "safe fixture" }, () => acks++);
    session = await wait(async () => {
      const s = await call("socketio-sessions/" + started.id);
      return s.events.some((e) => e.ackId) ? s : null;
    });
    const ackId = session.events.find((e) => e.ackId).ackId;
    let state = createSocketIOState(),
      saved,
      posts = 0;
    selectSocketIO(state, session.definition);
    state.session = session;
    state.incomingAckId = ackId;
    state.incomingAckArgs = '["answer"]';
    const options = {
      assertCurrent() {},
      setBusy() {},
      persistEvidence(s) {
        saved = structuredClone({
          pendingAckRecovery: s.pendingAckRecovery,
          uncertainStart: s.uncertainStart,
          uncertainSessions: s.uncertainSessions,
          stopProblems: s.stopProblems,
        });
        return true;
      },
      post: async (path, body) => {
        posts++;
        await call(path, "POST", body);
        throw Error("entire response lost");
      },
      get: (path) => call(path),
    };
    await createSocketIOController({ ...options, state }).acknowledge();
    assert.deepEqual(saved.pendingAckRecovery, {
      sessionId: session.id,
      ackId,
    });
    assert.deepEqual(state.uncertainSessions, [session.id]);
    state = Object.assign(createSocketIOState(), saved);
    state.session = { id: session.id };
    await createSocketIOController({ ...options, state }).poll();
    assert.deepEqual(state.uncertainSessions, []);
    assert.equal(state.pendingAckRecovery, null);
    assert.equal(
      state.session.events.find((e) => e.direction === "ack-sent")
        .localSubmission,
      "submitted",
    );
    await wait(() => acks === 1);
    await assert.rejects(
      call("socketio-sessions/" + session.id + "/ack", "POST", {
        ackId,
        args: ["duplicate"],
      }),
    );
    await assert.rejects(
      call("socketio-sessions/" + session.id, "GET", undefined, foreign.id),
    );
    assert.equal(connections, 1);
    assert.equal(acks, 1);
    assert.equal(posts, 1);
  },
);
