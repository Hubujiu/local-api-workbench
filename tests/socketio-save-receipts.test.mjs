import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Server } from "socket.io";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "socketio-save-receipts-"));
  const app = await createApp({ root, port: 0 });
  const peer = http.createServer();
  const io = new Server(peer);
  let connections = 0,
    effects = 0;
  io.on("connection", (socket) => {
    connections++;
    socket.on("echo", (payload, ack) => {
      effects++;
      ack(payload);
    });
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => io.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Socket.IO receipt");
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const post = async (action, value, projectId = project.id) => {
    const response = await fetch(
      `${app.url}/api/projects/${projectId}/${action}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(value),
      },
    );
    return { status: response.status, value: await response.json() };
  };
  const definition = await post("socketio-definitions", {
    id: "echo",
    name: "Echo",
    url: `http://127.0.0.1:${peer.address().port}`,
  });
  assert.equal(definition.status, 200);
  const started = await post("socketio-sessions", { definitionId: "echo" });
  assert.equal(started.status, 200);
  const id = started.value.id;
  const deadline = Date.now() + 2000;
  for (;;) {
    const snapshot = await (
      await fetch(
        `${app.url}/api/projects/${project.id}/socketio-sessions/${id}`,
        { headers },
      )
    ).json();
    if (snapshot.state === "open") break;
    assert.ok(Date.now() < deadline, JSON.stringify(snapshot));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const sent = await post(`socketio-sessions/${id}/send`, {
    event: "echo",
    args: [{ receipt: "accepted-once" }],
    ackTimeoutMs: 1000,
  });
  assert.equal(sent.value.status, "acknowledged");
  assert.deepEqual(sent.value.args, [{ receipt: "accepted-once" }]);
  return {
    root,
    app,
    project,
    id,
    post,
    stop: () => post(`socketio-sessions/${id}/stop`, {}),
    connections: () => connections,
    effects: () => effects,
  };
}

async function recoverRealUncertainStop(t, f) {
  const store = f.app.store;
  const save = store.save,
    read = store.readUnlocked;
  const directory = store.directory(f.project.id);
  const history = path.join(directory, "history");
  const kept = path.join(directory, "history-owned-backup");
  let saves = 0,
    failure;
  // Preserve original Store code: the fault is a real owned directory obstacle
  // after the save's read and before its journal/apply, not a fabricated throw.
  store.save = async function (project, options) {
    if (project.id !== f.project.id || !options?.activity)
      return save.call(this, project, options);
    saves++;
    this.readUnlocked = async function (id) {
      const value = await read.call(this, id);
      this.readUnlocked = read;
      await rename(history, kept);
      await writeFile(history, "owned filesystem obstacle");
      return value;
    };
    try {
      return await save.call(this, project, options);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.readUnlocked = read;
    }
  };
  t.after(() => {
    store.save = save;
    store.readUnlocked = read;
  });
  const first = await f.stop();
  assert.equal(first.status, 200);
  assert.equal(first.value.state, "closed");
  assert.equal(first.value.recordSaved, false);
  assert.equal(first.value.recordId, null);
  assert.equal(first.value.attemptedRecordId, f.id);
  assert.deepEqual(first.value.persistenceOutcome, {
    code: "PROJECT_COMMIT_UNCERTAIN",
    project_id: f.project.id,
    commit_outcome: "unknown",
    retry_safe: false,
  });
  assert.equal(failure.code, "PROJECT_COMMIT_UNCERTAIN");
  assert.equal(saves, 1);
  assert.equal(f.connections(), 1);
  assert.equal(f.effects(), 1);
  const journal = JSON.parse(
    await readFile(path.join(directory, ".transaction.json"), "utf8"),
  );
  assert.equal(journal.protocolRuns.length, 1);
  assert.equal(journal.protocolRuns[0].id, f.id);
  assert.deepEqual(journal.protocolRuns[0].result.events, first.value.events);
  store.save = save;
  store.readUnlocked = read;
  await rm(history);
  await rename(kept, history);
  const recovered = await new Store(f.root).get(f.project.id);
  assert.equal(recovered.protocolRuns.length, 1);
  assert.deepEqual(recovered.protocolRuns[0], journal.protocolRuns[0]);
  return { first: first.value, record: recovered.protocolRuns[0] };
}

function countAppends(t, store) {
  const append = store.append;
  let attempts = 0;
  store.append = function (...args) {
    attempts++;
    return append.apply(this, args);
  };
  t.after(() => {
    store.append = append;
  });
  return () => attempts;
}

test("Socket.IO repeated and concurrent stop reconcile a recovered identical record without append or network replay", async (t) => {
  const f = await fixture(t);
  const { first, record } = await recoverRealUncertainStop(t, f);
  // Equivalent JSON with reordered keys still identifies the same evidence.
  const reordered = await f.app.store.get(f.project.id);
  reordered.protocolRuns[0] = Object.fromEntries(
    Object.entries(reordered.protocolRuns[0]).reverse(),
  );
  reordered.protocolRuns[0].result = Object.fromEntries(
    Object.entries(reordered.protocolRuns[0].result).reverse(),
  );
  await f.app.store.save(reordered, { activity: true });
  const appends = countAppends(t, f.app.store);
  const results = await Promise.all([f.stop(), f.stop(), f.stop()]);
  for (const { status, value } of results) {
    assert.equal(status, 200);
    assert.equal(value.recordSaved, true, JSON.stringify(value));
    assert.equal(value.recordId, f.id);
    assert.equal(value.attemptedRecordId, f.id);
    assert.equal(value.persistenceOutcome, undefined);
    assert.equal(value.persistenceError, undefined);
    assert.deepEqual(value.events, first.events);
    assert.equal(value.state, "closed");
  }
  assert.equal(appends(), 0);
  const recovered = await new Store(f.root).get(f.project.id);
  assert.deepEqual(recovered.protocolRuns, [record]);
  assert.equal(f.connections(), 1);
  assert.equal(f.effects(), 1);
});

for (const collision of ["acknowledgement payload", "record metadata"]) {
  test(`Socket.IO recovered same-ID ${collision} collision fails closed without overwriting evidence`, async (t) => {
    const f = await fixture(t);
    const { first } = await recoverRealUncertainStop(t, f);
    const edited = await f.app.store.get(f.project.id);
    if (collision === "acknowledgement payload") {
      const acknowledgement = edited.protocolRuns[0].result.events.find(
        (event) => event.direction === "acknowledged",
      );
      assert.ok(acknowledgement);
      acknowledgement.args = [{ receipt: "different-owned-evidence" }];
    } else {
      // The result/definition are identical: comparison must cover the full record.
      edited.protocolRuns[0].createdAt = new Date(
        Date.parse(edited.protocolRuns[0].createdAt) + 1000,
      ).toISOString();
    }
    // A valid intentional activity write, not a malformed file or mocked Store.
    await f.app.store.save(edited, { activity: true });
    const before = (await new Store(f.root).get(f.project.id)).protocolRuns;
    const appends = countAppends(t, f.app.store);
    for (const { status, value } of await Promise.all([f.stop(), f.stop()])) {
      assert.equal(status, 200);
      assert.equal(value.recordSaved, false);
      assert.equal(value.recordId, null);
      assert.equal(value.attemptedRecordId, f.id);
      assert.deepEqual(value.persistenceOutcome, {
        code: "RECORD_SAVE_FAILED",
        retry_safe: false,
      });
      assert.deepEqual(value.events, first.events);
      assert.equal(
        JSON.stringify(value.persistenceOutcome).includes(f.root),
        false,
      );
    }
    assert.equal(appends(), 0);
    assert.deepEqual(
      (await new Store(f.root).get(f.project.id)).protocolRuns,
      before,
    );
    assert.equal(f.connections(), 1);
    assert.equal(f.effects(), 1);
  });
}

test("Socket.IO reconciliation only considers the session's own project, not a matching foreign record ID", async (t) => {
  const f = await fixture(t);
  const { record } = await recoverRealUncertainStop(t, f);
  const other = await f.app.store.create("Other project");
  other.protocolRuns = [structuredClone(record)];
  await f.app.store.save(other, { activity: true });
  const own = await f.app.store.get(f.project.id);
  own.protocolRuns = [];
  await f.app.store.save(own, { activity: true });
  const appends = countAppends(t, f.app.store);
  const { status, value } = await f.stop();
  assert.equal(status, 200);
  assert.equal(value.recordSaved, true);
  assert.equal(value.recordId, f.id);
  assert.equal(appends(), 1);
  const fresh = new Store(f.root);
  assert.deepEqual((await fresh.get(f.project.id)).protocolRuns, [record]);
  assert.deepEqual((await fresh.get(other.id)).protocolRuns, [record]);
  assert.equal(f.connections(), 1);
  assert.equal(f.effects(), 1);
});

test("Socket.IO simultaneous first stop requests share a single evidence append", async (t) => {
  const f = await fixture(t);
  const append = f.app.store.append;
  let attempts = 0;
  f.app.store.append = async function (...args) {
    attempts++;
    // Keep the first save in flight while the other HTTP stop handlers arrive.
    await new Promise((resolve) => setTimeout(resolve, 25));
    return append.apply(this, args);
  };
  t.after(() => {
    f.app.store.append = append;
  });
  const results = await Promise.all([f.stop(), f.stop(), f.stop()]);
  for (const { status, value } of results) {
    assert.equal(status, 200);
    assert.equal(value.recordSaved, true);
    assert.equal(value.recordId, f.id);
    assert.deepEqual(value.events, results[0].value.events);
  }
  assert.equal(attempts, 1);
  const recovered = await new Store(f.root).get(f.project.id);
  assert.equal(recovered.protocolRuns.length, 1);
  assert.equal(recovered.protocolRuns[0].id, f.id);
  assert.equal(f.connections(), 1);
  assert.equal(f.effects(), 1);
});
