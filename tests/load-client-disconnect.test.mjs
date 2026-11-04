import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

test(
  "disconnect cancels in-flight load and releases run ID without launching subsequent iterations",
  { timeout: 10000 },
  async (t) => {
    let received = 0,
      held = 0,
      closedCount = 0,
      started,
      stopped;
    const first = new Promise((resolve) => {
      started = resolve;
    });
    const closed = new Promise((resolve) => {
      stopped = resolve;
    });
    const peer = createServer((req, res) => {
      received++;
      if (req.url === "/hold") {
        if (++held === 4) started();
        res.once("close", () => {
          if (++closedCount === 4) stopped();
        });
      } else res.end("ok");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "load-disconnect-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const endpoint =
      app.url + `/api/projects/${(await app.store.create("load")).id}/load`;
    const headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
    const payload = (path) => ({
      request: {
        url: `http://127.0.0.1:${peer.address().port}${path}`,
        method: "GET",
      },
      count: 8,
      concurrency: 4,
      runId: "same-run",
    });
    const abort = new AbortController();
    const running = fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload("/hold")),
      signal: abort.signal,
    }).catch((error) => error);
    await first;
    abort.abort();
    assert.equal((await running).name, "AbortError");
    await closed;
    // A successful reuse proves the original controller was unregistered.
    let response;
    const deadline = Date.now() + 3000;
    do {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...payload("/ok"), count: 1 }),
      });
      if (response.status === 200) break;
      assert(Date.now() < deadline, "cancelled run ID was not released");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (true);
    assert.equal((await response.json()).count, 1);
    assert.equal(received, 5);
  },
);

test(
  "disconnect interrupts the script subrequest before the main load request",
  { timeout: 10000 },
  async (t) => {
    let mainCount = 0,
      started,
      stopped;
    const first = new Promise((resolve) => {
      started = resolve;
    });
    const closed = new Promise((resolve) => {
      stopped = resolve;
    });
    const peer = createServer((req, res) => {
      if (req.url === "/script") {
        started();
        res.once("close", stopped);
      } else {
        if (req.url === "/main") mainCount++;
        res.end("ok");
      }
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "load-disconnect-script-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const endpoint =
      app.url + `/api/projects/${(await app.store.create("load")).id}/load`;
    const base = `http://127.0.0.1:${peer.address().port}`;
    const abort = new AbortController();
    const running = fetch(endpoint, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        request: {
          url: base + "/main",
          method: "GET",
          beforeScript: `await pm.sendRequest(${JSON.stringify(base + "/script")});`,
        },
        count: 5,
        concurrency: 1,
        runId: "script-disconnect",
      }),
      signal: abort.signal,
    }).catch((error) => error);
    await first;
    abort.abort();
    assert.equal((await running).name, "AbortError");
    await closed;
    const deadline = Date.now() + 3000;
    let response;
    do {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          request: { url: base + "/health", method: "GET" },
          count: 1,
          concurrency: 1,
          runId: "script-disconnect",
        }),
      });
      if (response.status === 200) break;
      assert(Date.now() < deadline, "cancelled run ID was not released");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (true);
    assert.equal((await response.json()).count, 1);
    assert.equal(mainCount, 0);
  },
);
