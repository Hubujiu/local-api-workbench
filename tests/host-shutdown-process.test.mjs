import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import http from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Store } from "../src/runtime.mjs";
const cwd = fileURLToPath(new URL("..", import.meta.url));
async function until(fn) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) throw Error("host fixture timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function start(t, root) {
  const lease = net.createServer();
  await new Promise((r) => lease.listen(0, "127.0.0.1", r));
  const port = lease.address().port;
  await new Promise((r) => lease.close(r));
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd,
    env: { ...process.env, PORT: String(port), LOCAL_API_DATA: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  });
  const launch = await until(() => {
    assert.equal(child.exitCode, null, stderr);
    return stdout.match(/Local API Workbench: (http:\/\/[^\s]+)/)?.[1];
  });
  const url = new URL(launch),
    token = url.hash.slice("#token=".length);
  const api = async (pathname, body) => {
    const response = await fetch(url.origin + pathname, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-local-token": token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  return { child, exited, api, stderr: () => stderr };
}
for (const signal of ["SIGINT", "SIGTERM"])
  test(
    `real main ${signal} saves TCP/WS/SSE once and restart never reconnects`,
    {
      skip:
        process.platform === "win32"
          ? "Windows child.kill does not deliver catchable POSIX signals"
          : false,
      timeout: 30000,
    },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "host-close-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      let connections = 0,
        sent = 0;
      const sockets = new Set();
      const tcp = net.createServer((socket) => {
        connections++;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("data", () => sent++);
      });
      const upstream = http.createServer((req, res) => {
        connections++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: ready\n\n");
      });
      const ws = new WebSocketServer({ server: upstream });
      ws.on("connection", (socket) => {
        connections++;
        socket.on("message", () => sent++);
      });
      await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
      await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
      t.after(async () => {
        for (const s of sockets) s.destroy();
        for (const s of ws.clients) s.terminate();
        upstream.closeAllConnections();
        await Promise.all([
          new Promise((r) => tcp.close(r)),
          new Promise((r) => ws.close(r)),
          new Promise((r) => upstream.close(r)),
        ]);
      });
      const store = new Store(root),
        project = await store.create("host sessions");
      const other = await store.create("other"),
        otherBefore = await store.get(other.id);
      const app = await start(t, root),
        ids = [];
      const prefix = `/api/projects/${project.id}/protocol-sessions`;
      for (const definition of [
        { type: "tcp", host: "127.0.0.1", port: tcp.address().port },
        { type: "websocket", url: `ws://127.0.0.1:${upstream.address().port}` },
        { type: "sse", url: `http://127.0.0.1:${upstream.address().port}` },
      ]) {
        const { id } = await app.api(prefix, definition);
        ids.push(id);
        await until(
          async () => (await app.api(prefix + "/" + id)).state === "open",
        );
      }
      assert.equal(connections, 3);
      app.child.kill(signal);
      assert.deepEqual(await app.exited, [0, null]);
      assert.match(app.stderr(), /LOCAL_API_SHUTDOWN_SAVED/);
      const saved = await new Store(root).get(project.id);
      assert.deepEqual(saved.protocolRuns.map((r) => r.id).sort(), ids.sort());
      assert(saved.protocolRuns.every((r) => r.status === "partial"));
      assert.equal(sent, 0);
      assert.deepEqual(await new Store(root).get(other.id), otherBefore);
      const restarted = await start(t, root);
      assert.equal(
        (await new Store(root).get(project.id)).protocolRuns.length,
        3,
      );
      restarted.child.kill(signal);
      assert.deepEqual(await restarted.exited, [0, null]);
      assert.equal(connections, 3);
    },
  );

test(
  "real main save failure exits 2 with redacted outcome and never replays",
  {
    skip:
      process.platform === "win32"
        ? "Windows child.kill is not a catchable POSIX signal"
        : false,
    timeout: 30000,
  },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "host-failed-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let connections = 0,
      sent = 0;
    const sockets = new Set(),
      tcp = net.createServer((socket) => {
        connections++;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("data", () => sent++);
      });
    await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => tcp.close(r));
    });
    const store = new Store(root),
      project = await store.create("failure"),
      app = await start(t, root);
    const prefix = `/api/projects/${project.id}/protocol-sessions`;
    const { id } = await app.api(prefix, {
      type: "tcp",
      host: "127.0.0.1",
      port: tcp.address().port,
    });
    await until(
      async () => (await app.api(prefix + "/" + id)).state === "open",
    );
    const file = path.join(
        store.directory(project.id),
        "history",
        "requests.json",
      ),
      before = await readFile(file, "utf8");
    await writeFile(file, '{"fictional-secret":');
    app.child.kill("SIGTERM");
    assert.deepEqual(await app.exited, [2, null]);
    assert.match(app.stderr(), /LOCAL_API_SHUTDOWN_UNCONFIRMED/);
    assert.doesNotMatch(
      app.stderr(),
      /fictional-secret|requests.json|host-failed-/,
    );
    await writeFile(file, before);
    assert.equal(
      (await new Store(root).get(project.id)).protocolRuns.length,
      0,
    );
    assert.equal(connections, 1);
    assert.equal(sent, 0);
  },
);

test(
  "real signals join while an owned HTTP request finishes naturally",
  {
    skip:
      process.platform === "win32"
        ? "Windows child.kill is not a catchable POSIX signal"
        : false,
    timeout: 30000,
  },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "host-graceful-http-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let release,
      calls = 0;
    const arrived = new Promise((r) => {
      release = r;
    });
    const peer = http.createServer((_req, res) => {
      calls++;
      release(res);
    });
    await new Promise((r) => peer.listen(0, "127.0.0.1", r));
    t.after(async () => {
      peer.closeAllConnections();
      await new Promise((r) => peer.close(r));
    });
    const p = await new Store(root).create("graceful"),
      app = await start(t, root);
    const request = app.api(`/api/projects/${p.id}/execute`, {
      request: {
        method: "GET",
        url: `http://127.0.0.1:${peer.address().port}`,
        timeout: 5000,
      },
    });
    const response = await arrived;
    app.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.child.exitCode, null);
    assert.equal(response.destroyed, false);
    app.child.kill("SIGINT");
    response.end("completed naturally");
    const result = await request;
    assert.equal(result.status, 200);
    assert.deepEqual(await app.exited, [0, null]);
    assert.equal(calls, 1);
    assert.equal(app.stderr().match(/LOCAL_API_SHUTDOWN_SAVED/g)?.length, 1);
  },
);
