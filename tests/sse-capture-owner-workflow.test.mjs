import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSSECaptureOwner } from "../public/sse-capture-owner.js";
import { createApp } from "../src/server.mjs";

test(
  "one held local SSE GET closes after the exact cancel, read-only history resolves only its owner",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "owned-capture-"));
    const app = await createApp({ root, port: 0 });
    let observed = 0,
      requestMethod,
      requestPath;
    let accept, close;
    const accepted = new Promise((resolve) => (accept = resolve));
    const closed = new Promise((resolve) => (close = resolve));
    const stream = createServer((req, res) => {
      observed++;
      requestMethod = req.method;
      requestPath = req.url;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: synthetic only\n\n");
      res.on("close", close);
      accept();
    });
    t.after(async () => {
      stream.closeAllConnections();
      if (stream.listening) await new Promise((done) => stream.close(done));
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    stream.listen(0, "127.0.0.1");
    await once(stream, "listening");

    const project = await app.store.create("owner");
    const other = await app.store.create("non-owner");
    const url = `http://127.0.0.1:${stream.address().port}/events`;
    const headers = {
      "content-type": "application/json",
      "x-local-token": app.token,
    };
    const api = async (path, data) => {
      const res = await fetch(app.url + "/api" + path, {
        headers,
        ...(data ? { method: "POST", body: JSON.stringify(data) } : {}),
        signal: AbortSignal.timeout(5000),
      });
      return { status: res.status, value: await res.json() };
    };
    const calls = createSSECaptureOwner();
    const owner = {
      projectId: project.id,
      definitionId: "fixture",
      definitionUrl: url,
    };
    const attempt = calls.start(owner, { runId: "owned-capture-fixture", url });
    const pending = api("/projects/" + project.id + "/protocol", {
      type: "sse",
      url,
      duration: 10000,
      runId: attempt.runId,
    });
    await Promise.race([
      accepted,
      pending.then(() => assert.fail("attempt finished before connection")),
    ]);
    assert.equal(requestMethod, "GET");
    assert.equal(requestPath, "/events");
    assert.equal(calls.cancel(attempt), true);
    const ack = await api("/cancel", { id: attempt.runId });
    assert.deepEqual(ack, { status: 200, value: { ok: true } });
    assert.equal(attempt.phase, "stopping");
    const original = await pending;
    await closed;
    assert.equal(original.status, 400);
    assert.equal(original.value.recordSaved, true);
    calls.settle(attempt, original.value);
    assert.equal(attempt.phase, "unknown");
    const history = (projectId) =>
      api("/projects/" + projectId + "/protocol-runs?type=sse");
    const unrelated = await history(other.id);
    assert.deepEqual(unrelated, { status: 200, value: [] });
    assert.equal(calls.check(attempt, unrelated.value), false);
    const own = await history(owner.projectId);
    assert.equal(own.status, 200);
    assert.equal(own.value.length, 1);
    assert.equal(calls.check(attempt, own.value), true);
    assert.equal(attempt.phase, "cancelled");
    assert.equal(attempt.recordId, original.value.recordId);
    assert.equal(observed, 1);
  },
);
