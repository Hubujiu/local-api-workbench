import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { createMCP } from "../src/mcp.mjs";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";
async function until(fn) {
  const end = Date.now() + 4000;
  while (true) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw Error("session fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "owned-protocol-session-")),
    app = await createApp({ root, port: 0 });
  let sends = 0,
    burst = false;
  const sockets = new Set(),
    tcp = net.createServer((s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("data", (b) => {
        sends++;
        if (b.toString() === "finish") s.end("last-tcp");
        else s.write(b);
      });
    });
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("id: live\ndata: session-event\n\n");
  });
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  wss.on("connection", (ws, req) => {
    assert.equal(req.headers.authorization, "Bearer session-fixture");
    ws.on("error", () => {});
    ws.on("message", (b, binary) => {
      sends++;
      if (b.toString() === "finish") {
        ws.send("last-ws");
        ws.close();
      } else if (burst) {
        for (let i = 0; i < 250; i++) ws.send("event-" + i);
      } else ws.send(b, { binary });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => tcp.close(r));
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("sessions"),
    other = await app.store.create("other");
  p.protocols = [
    {
      id: "tcp",
      type: "tcp",
      url: "127.0.0.1",
      port: tcp.address().port,
      receiveEncoding: "base64",
      message: { encoding: "hex", data: "00ff" },
    },
    {
      id: "ws",
      type: "websocket",
      url: `ws://127.0.0.1:${server.address().port}`,
    },
    {
      id: "sse",
      type: "sse",
      url: `http://127.0.0.1:${server.address().port}`,
    },
  ];
  await app.store.save(p);
  const headers = {
      "content-type": "application/json",
      "x-local-token": app.token,
    },
    endpoint = (tail = "", id = p.id) =>
      app.url + "/api/projects/" + id + "/protocol-sessions" + tail;
  const post = async (tail, body = {}, id = p.id) => {
    const r = await fetch(endpoint(tail, id), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: r.status, value: await r.json() };
  };
  const get = async (id, projectId = p.id) => {
    const r = await fetch(endpoint("/" + id, projectId), { headers });
    return { status: r.status, value: await r.json() };
  };
  return {
    root,
    app,
    p,
    other,
    headers,
    endpoint,
    post,
    get,
    sends: () => sends,
    setBurst(v) {
      burst = v;
    },
    tcpPort: tcp.address().port,
    endTCP: () => {
      for (const socket of sockets) socket.end("peer-end");
    },
  };
}
test("project-bound interactive TCP sends twice, rejects foreign/global access, finalizes once and restores inert evidence", async (t) => {
  const f = await fixture(t),
    created = await f.post("", { definitionId: "tcp" });
  assert.equal(created.status, 200);
  const id = created.value.id;
  await until(async () => {
    const x = await f.get(id);
    return x.value.state === "open";
  });
  const wrong = await f.get(id, f.other.id);
  assert.notEqual(wrong.status, 200);
  assert.match(wrong.value.error, /不属于/);
  for (const [method, suffix] of [
    ["GET", ""],
    ["POST", "/stop"],
  ]) {
    const r = await fetch(f.app.url + "/api/protocol-sessions/" + id + suffix, {
      method,
      headers: f.headers,
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    assert.equal(r.ok, false);
  }
  await f.post("/" + id + "/send", {});
  await until(async () => {
    const x = (await f.get(id)).value;
    return x.events.filter((e) => e.direction === "received").length === 1;
  });
  await f.post("/" + id + "/send", { message: "second" });
  await until(async () => {
    const x = (await f.get(id)).value;
    return x.events.filter((e) => e.direction === "received").length === 2;
  });
  let appends = 0;
  const append = f.app.store.append.bind(f.app.store);
  f.app.store.append = async (...args) => {
    if (args[1] === "protocolRuns") appends++;
    return append(...args);
  };
  const stopped = await Promise.all([
    f.post("/" + id + "/stop"),
    f.post("/" + id + "/stop"),
  ]);
  assert(
    stopped.every((x) => x.value.recordSaved === true),
    JSON.stringify(stopped),
  );
  assert.equal(appends, 1);
  assert.equal(f.sends(), 2);
  const saved = await new Store(f.root).get(f.p.id),
    record = saved.protocolRuns[0];
  assert.equal(record.id, id);
  assert.equal(record.mode, "session");
  assert.equal(record.status, "partial");
  assert.equal(
    record.result.events.filter((e) => e.direction === "received")[0].data,
    "AP8=",
  );
  assert.equal(
    record.result.events.filter((e) => e.direction === "received")[0].encoding,
    "base64",
  );
  assert.equal(record.result.resultTruncated, false);
  const again = await f.post("/" + id + "/stop");
  assert.equal(again.value.recordSaved, true);
  assert.equal(appends, 1);
  assert.equal(f.sends(), 2);
  const before = JSON.stringify(stopped[0].value.events);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(JSON.stringify((await f.get(id)).value.events), before);
  const restored = await fetch(f.app.url + "/api/restore", {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({ document: saved }),
  });
  assert.equal(restored.status, 201);
  const copy = await restored.json();
  assert.deepEqual(copy.protocolRuns, saved.protocolRuns);
  assert.equal((await f.get(id, copy.id)).status === 200, false);
  assert.equal(f.sends(), 2);
  const mcp = createMCP({ store: f.app.store, projects: [f.p.id] });
  const response = await mcp({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_get_protocol_run",
      arguments: { projectId: f.p.id, recordId: id },
    },
  });
  assert.equal(JSON.parse(response.result.content[0].text).mode, "session");
});
test("SSE remote completion and WebSocket event-window truncation retain honest session outcomes", async (t) => {
  const f = await fixture(t),
    sse = await f.post("", { definitionId: "sse" });
  const sid = sse.value.id;
  await until(async () => (await f.get(sid)).value.state === "closed");
  const final = await f.post("/" + sid + "/stop");
  assert.equal(final.value.recordSaved, true, JSON.stringify(final));
  let saved = await f.app.store.get(f.p.id);
  assert.equal(saved.protocolRuns[0].status, "completed");
  assert.equal(saved.protocolRuns[0].result.closeReason, "remote");
  f.setBurst(true);
  const ws = await f.post("", {
      definitionId: "ws",
      headers: { Authorization: "Bearer session-fixture" },
    }),
    wid = ws.value.id;
  await until(async () => (await f.get(wid)).value.state === "open");
  await f.post("/" + wid + "/send", { message: "burst" });
  await until(async () => (await f.get(wid)).value.totalEvents === 251);
  const stopped = await f.post("/" + wid + "/stop");
  assert.equal(stopped.value.recordSaved, true, JSON.stringify(stopped));
  saved = await f.app.store.get(f.p.id);
  const record = saved.protocolRuns.find((x) => x.id === wid);
  assert.equal(record.result.events.length, 200);
  assert.equal(record.result.droppedEvents, 51);
  assert.equal(record.result.resultTruncated, true);
  assert.equal(record.status, "partial");
  assert(!JSON.stringify(saved).includes("Bearer session-fixture"));
});
test("uncertain session storage outcome is reconciled on retry without a duplicate record or another send", async (t) => {
  const f = await fixture(t),
    created = await f.post("", { definitionId: "tcp" }),
    id = created.value.id;
  await until(async () => (await f.get(id)).value.state === "open");
  await f.post("/" + id + "/send", {});
  await until(async () => (await f.get(id)).value.totalEvents === 2);
  const append = f.app.store.append.bind(f.app.store);
  let calls = 0;
  f.app.store.append = async (...args) => {
    calls++;
    await append(...args);
    throw Error("fixture acknowledgement lost after durable write");
  };
  const first = await f.post("/" + id + "/stop");
  assert.equal(first.value.recordSaved, false);
  assert.equal(first.value.persistenceOutcome.code, "RECORD_SAVE_FAILED");
  assert.doesNotMatch(first.value.persistenceError, /acknowledgement lost/);
  assert.equal((await f.app.store.get(f.p.id)).protocolRuns.length, 1);
  const second = await f.post("/" + id + "/stop");
  assert.equal(second.value.recordSaved, true, JSON.stringify(second));
  assert.equal(calls, 1);
  assert.equal(f.sends(), 1);
  assert.equal((await f.app.store.get(f.p.id)).protocolRuns.length, 1);
});
test("session previews flag truncation without splitting a surrogate pair and snapshots cannot mutate live events", () => {
  const manager = new ProtocolSessions(),
    session = {
      id: "fixture",
      type: "tcp",
      state: "open",
      events: [],
      bytes: 0,
      totalEvents: 0,
      createdAt: new Date().toISOString(),
    };
  manager.sessions.set(session.id, session);
  manager.event(session, "received", "a".repeat(99999) + "🙂");
  const snapshot = manager.snapshot(session.id);
  assert.equal(snapshot.events[0].data.isWellFormed(), true);
  assert.equal(snapshot.events[0].truncated, true);
  assert.equal(snapshot.events[0].data.length, 99999);
  snapshot.events[0].data = "tampered";
  assert.notEqual(manager.snapshot(session.id).events[0].data, "tampered");
  manager.close();
});

test("failed connections remain failed after stop and pre-write storage failures retry storage only", async (t) => {
  const f = await fixture(t),
    closed = net.createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const append = f.app.store.append.bind(f.app.store);
  let attempts = 0;
  f.app.store.append = async (...args) => {
    if (++attempts === 1) throw Error("fixture disk before write");
    return append(...args);
  };
  const created = await f.post("", { type: "tcp", host: "127.0.0.1", port }),
    id = created.value.id;
  await until(async () => (await f.get(id)).value.persistenceError);
  const first = await f.get(id);
  assert.equal(first.value.state, "error");
  assert.equal(first.value.recordSaved, false);
  assert.equal((await f.app.store.get(f.p.id)).protocolRuns.length, 0);
  await f.get(id);
  assert.equal(attempts, 1, "GET never retries storage");
  const second = await f.post("/" + id + "/stop");
  assert.equal(second.value.recordSaved, true, JSON.stringify(second));
  assert.equal(second.value.state, "error");
  assert.equal(attempts, 2);
  const record = (await f.app.store.get(f.p.id)).protocolRuns[0];
  assert.equal(record.status, "failed");
  assert.equal(record.result.closeReason, "error");
  assert(record.result.error);
  assert.equal(f.sends(), 0);
});

test("large SSE display framing retains a bounded honest preview without lowering the existing session byte budget", async (t) => {
  const f = await fixture(t),
    stream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data:\n".repeat(350000) + "\n");
    });
  stream.listen(0, "127.0.0.1");
  await once(stream, "listening");
  t.after(async () => {
    stream.closeAllConnections();
    await new Promise((r) => stream.close(r));
  });
  const started = await f.post("", {
      type: "sse",
      url: `http://127.0.0.1:${stream.address().port}`,
    }),
    id = started.value.id;
  await until(async () => {
    const state = (await f.get(id)).value.state;
    return state === "closed" || state === "error";
  });
  const stopped = await f.post("/" + id + "/stop");
  assert.equal(stopped.value.state, "closed");
  assert.equal(
    stopped.value.recordSaved,
    true,
    JSON.stringify(stopped.value.persistenceError),
  );
  const record = (await f.app.store.get(f.p.id)).protocolRuns[0];
  assert.equal(record.status, "partial");
  assert.equal(record.result.events[0].truncated, true);
  assert(record.result.events[0].dataBytes > 2 * 1024 * 1024);
  assert(record.result.dataBytes <= 8 * 1024 * 1024);
  assert.equal(record.result.events[0].data.length, 100000);
});

test("remote TCP, WebSocket and SSE terminal histories persist without stop and survive restart", async (t) => {
  const f = await fixture(t);
  const ids = [];
  for (const definitionId of ["tcp", "ws", "sse"]) {
    const started = await f.post("", {
      definitionId,
      ...(definitionId === "ws"
        ? { headers: { Authorization: "Bearer session-fixture" } }
        : {}),
    });
    assert.equal(started.status, 200);
    const id = started.value.id;
    ids.push(id);
    if (definitionId !== "sse") {
      await until(async () => (await f.get(id)).value.state === "open");
      await f.post("/" + id + "/send", { message: "finish" });
    }
    await until(async () => (await f.get(id)).value.recordSaved);
    const receipt = (await f.get(id)).value;
    assert.equal(receipt.recordId, id);
    assert.equal(receipt.closeReason, "remote");
    assert.equal((await f.get(id, f.other.id)).status, 400);
  }
  const saved = await new Store(f.root).get(f.p.id);
  assert.equal(saved.protocolRuns.length, 3);
  for (const id of ids) {
    const record = saved.protocolRuns.find((x) => x.id === id);
    assert.equal(record.status, "completed");
    assert(record.result.events.some((x) => x.direction === "received"));
  }
  assert.equal((await f.app.store.get(f.other.id)).protocolRuns.length, 0);
  assert.equal(f.sends(), 2);
  f.app.server.closeAllConnections();
  await new Promise((resolve) => f.app.server.close(resolve));
  const restarted = await createApp({ root: f.root, port: 0 });
  assert.deepEqual(
    (await restarted.store.get(f.p.id)).protocolRuns,
    saved.protocolRuns,
  );
  await new Promise((resolve) => restarted.server.close(resolve));
});

test("failed automatic save shares concurrent storage-only retries without repeating transport", async (t) => {
  const f = await fixture(t);
  const append = f.app.store.append.bind(f.app.store);
  let calls = 0,
    release;
  const gate = new Promise((r) => {
    release = r;
  });
  f.app.store.append = async (...args) => {
    calls++;
    if (calls === 1) throw Error("owned pre-write failure");
    await gate;
    return append(...args);
  };
  const id = (await f.post("", { definitionId: "sse" })).value.id;
  await until(async () => (await f.get(id)).value.persistenceError);
  const first = f.post("/" + id + "/stop");
  await until(() => calls === 2);
  const second = f.post("/" + id + "/stop");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 2, "both stop calls share the pending retry");
  release();
  for (const result of await Promise.all([first, second]))
    assert.equal(result.value.recordSaved, true);
  assert.equal((await f.app.store.get(f.p.id)).protocolRuns.length, 1);
  assert.equal(f.sends(), 0);
});

test("real pre-journal and post-journal filesystem failures retain readable receipts and reconcile storage only", async (t) => {
  for (const phase of ["before", "after"])
    await t.test(phase, async (t) => {
      const f = await fixture(t);
      const id = (await f.post("", { definitionId: "tcp" })).value.id;
      await until(async () => (await f.get(id)).value.state === "open");
      const dir = f.app.store.directory(f.p.id),
        history = path.join(dir, "history"),
        file = path.join(history, "requests.json"),
        kept = path.join(dir, "history-kept"),
        journal = path.join(dir, ".transaction.json");
      const original = await readFile(file, "utf8");
      const save = f.app.store.save,
        read = f.app.store.readUnlocked;
      let attempts = 0;
      if (phase === "before") await writeFile(file, '{"private-marker":');
      else
        f.app.store.save = async function (project, options) {
          if (!options?.activity) return save.call(this, project, options);
          attempts++;
          this.readUnlocked = async function (projectId) {
            const state = await read.call(this, projectId);
            this.readUnlocked = read;
            await rename(history, kept);
            await writeFile(history, "private filesystem obstacle");
            return state;
          };
          try {
            return await save.call(this, project, options);
          } finally {
            this.readUnlocked = read;
          }
        };
      // A real peer closes independently; no owner stop is required to attempt save.
      // send requires readable project, so use the connection already opened above.
      if (phase === "before") {
        // End the remote side via a dedicated normal request before corrupting its
        // history: the retained fixture socket is exposed only to this test.
        f.endTCP();
      } else await f.post("/" + id + "/send", { message: "finish" });
      await until(async () => (await f.get(id)).value.persistenceError);
      const failed = (await f.get(id)).value;
      assert.equal(failed.recordSaved, false);
      assert.equal(failed.recordId, null);
      assert.equal(failed.attemptedRecordId, id);
      assert.equal(
        failed.persistenceOutcome.code,
        phase === "after" ? "PROJECT_COMMIT_UNCERTAIN" : "RECORD_SAVE_FAILED",
      );
      assert.equal(failed.persistenceOutcome.retry_safe, false);
      assert.doesNotMatch(
        JSON.stringify(failed.persistenceOutcome),
        /private|history-kept/,
      );
      assert.equal((await f.get(id, f.other.id)).status, 400);
      const unauth = await fetch(f.endpoint("/" + id));
      assert.equal(unauth.status, 403);
      await f.get(id);
      await f.get(id);
      if (phase === "after") {
        assert.equal(attempts, 1);
        assert.equal(
          typeof JSON.parse(await readFile(journal, "utf8")),
          "object",
        );
        f.app.store.save = save;
        await rm(history);
        await rename(kept, history);
      } else {
        await assert.rejects(readFile(journal), { code: "ENOENT" });
        await writeFile(file, original);
      }
      const retried = await Promise.all([
        f.post("/" + id + "/stop"),
        f.post("/" + id + "/stop"),
      ]);
      assert(retried.every((r) => r.value.recordSaved));
      const saved = await new Store(f.root).get(f.p.id);
      assert.equal(saved.protocolRuns.length, 1);
      assert.equal(saved.protocolRuns[0].id, id);
      assert.equal(saved.protocolRuns[0].status, "completed");
      assert.equal(f.sends(), phase === "after" ? 1 : 0);
    });
});

test("graceful shutdown waits for automatic live-session saves and never reconnects on restart", async (t) => {
  const f = await fixture(t);
  const ids = [];
  for (const definitionId of ["tcp", "ws"]) {
    const id = (
      await f.post("", {
        definitionId,
        ...(definitionId === "ws"
          ? { headers: { Authorization: "Bearer session-fixture" } }
          : {}),
      })
    ).value.id;
    ids.push(id);
    await until(async () => (await f.get(id)).value.state === "open");
  }
  const append = f.app.store.append.bind(f.app.store);
  let release,
    finished = false,
    calls = 0;
  const gate = new Promise((r) => {
    release = r;
  });
  f.app.store.append = async (...args) => {
    calls++;
    await gate;
    return append(...args);
  };
  f.app.server.closeAllConnections();
  const closing = new Promise((r) =>
    f.app.server.close(() => {
      finished = true;
      r();
    }),
  );
  await until(() => calls === 2);
  assert.equal(finished, false);
  release();
  await closing;
  const saved = await new Store(f.root).get(f.p.id);
  assert.deepEqual(saved.protocolRuns.map((x) => x.id).sort(), ids.sort());
  assert(
    saved.protocolRuns.every(
      (x) => x.status === "partial" && x.result.closeReason === "manual",
    ),
  );
  assert.equal(f.sends(), 0);
});
