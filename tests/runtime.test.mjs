import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeRequest, Store } from "../src/runtime.mjs";
test("real HTTP body, query, auth and response evidence", async (t) => {
  const s = http.createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        url: req.url,
        auth: req.headers.authorization,
        body: b,
      }),
    );
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => s.close());
  let r = await executeRequest({
    method: "POST",
    url: `http://127.0.0.1:${s.address().port}/echo`,
    query: [{ key: "a", value: "中 文" }],
    headers: [],
    auth: { type: "bearer", token: "test" },
    bodyType: "json",
    body: '{"hello":1}',
    timeout: 1000,
  });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.auth, "Bearer test");
  assert.equal(body.body, '{"hello":1}');
  assert(body.url.includes("a="));
  assert(r.duration >= 0);
});
test("disk store rejects traversal and survives reopening", async (t) => {
  let dir = await mkdtemp(path.join(os.tmpdir(), "local-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let s = new Store(dir);
  await s.init();
  let p = await s.create("Demo");
  p.requests.push({ id: "x" });
  await s.save(p);
  assert.equal((await new Store(dir).get(p.id)).requests.length, 1);
  await assert.rejects(s.get("../secret"));
});
test("non HTTP protocols blocked", async () => {
  await assert.rejects(
    executeRequest({ url: "file:///etc/passwd", method: "GET" }),
    /HTTP/,
  );
});
test("stale saves rejected, history append preserves latest content", async (t) => {
  let dir = await mkdtemp(path.join(os.tmpdir(), "local-api-revision-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  let p = await store.create("A");
  let stale = structuredClone(p);
  p.name = "B";
  await store.save(p);
  await assert.rejects(store.save(stale), /其他窗口/);
  await store.append(p.id, "history", { id: "event" });
  let latest = await store.get(p.id);
  assert.equal(latest.name, "B");
  assert.equal(latest.history.length, 1);
});
test("HTTP timeout and cancellation produce explicit failures", async (t) => {
  const s = http.createServer(() => {});
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  const request = { url: `http://127.0.0.1:${s.address().port}`, timeout: 100 };
  await assert.rejects(executeRequest(request), /超时/);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    executeRequest({ ...request, timeout: 5000 }, controller.signal),
    /abort/i,
  );
});
test("compressed responses are decoded with a size limit", async (t) => {
  const { gzipSync } = await import("node:zlib");
  const s = http.createServer((req, res) => {
    res.setHeader("content-encoding", "gzip");
    res.end(gzipSync('{"ok":true}'));
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => s.close());
  const response = await executeRequest({
    url: `http://127.0.0.1:${s.address().port}`,
  });
  assert.equal(response.body, '{"ok":true}');
});
test("multipart files preserve binary bytes", async (t) => {
  let received;
  const s = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received = Buffer.concat(chunks);
    res.end("ok");
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => s.close());
  const bytes = Buffer.from([0, 128, 255, 10]);
  await executeRequest({
    url: `http://127.0.0.1:${s.address().port}`,
    method: "POST",
    bodyType: "form-data",
    form: [
      {
        key: "upload",
        type: "file",
        filename: "sample.bin",
        value: bytes.toString("base64"),
      },
    ],
  });
  assert(received.includes(bytes));
  assert(received.includes(Buffer.from('filename="sample.bin"')));
});
test("slow drip cannot evade the total timeout", async (t) => {
  let timer;
  const s = http.createServer((req, res) => {
    res.writeHead(200);
    timer = setInterval(() => res.write("a"), 10);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => {
    clearInterval(timer);
    s.closeAllConnections();
    s.close();
  });
  await assert.rejects(
    executeRequest({
      url: `http://127.0.0.1:${s.address().port}`,
      timeout: 100,
    }),
    /时限|超时/,
  );
});
test("custom project directory remains registered across restarts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-registry-"));
  const custom = await mkdtemp(path.join(os.tmpdir(), "api-custom-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(custom, { recursive: true, force: true });
  });
  const store = new Store(root),
    project = await store.create("Custom", custom);
  const reopened = new Store(root);
  assert.equal((await reopened.get(project.id)).name, "Custom");
  assert.equal((await reopened.list()).length, 1);
  assert.equal(path.dirname(reopened.file(project.id)), custom);
});
test("parallel custom-directory registrations cannot lose projects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-register-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = new Store(root),
    b = new Store(root);
  await Promise.all([
    a.create("A", path.join(root, "a")),
    b.create("B", path.join(root, "b")),
  ]);
  assert.equal((await new Store(root).list()).length, 2);
});
