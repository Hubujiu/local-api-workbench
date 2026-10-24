import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { captureSSE } from "../src/protocols.mjs";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";

async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
test("SSE capture accepts bare CR lines and multiline UTF-8 without requiring LF", async (t) => {
  const url = await serve(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      "\ufeff: comment\revent: update\rid: exact\rdata: 中文\rdata: second\r\rdata: next\r\r",
    );
  });
  const result = await captureSSE({ url });
  assert.deepEqual(
    result.events.map((x) => ({ data: x.data, event: x.event, id: x.id })),
    [
      { data: "中文\nsecond", event: "update", id: "exact" },
      { data: "next", event: "message", id: "exact" },
    ],
  );
});
test("SSE cancellation before invocation never makes a network request", async (t) => {
  let requests = 0;
  const url = await serve(t, (_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: must not run\n\n");
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(captureSSE({ url }, controller.signal));
  assert.equal(requests, 0);
});
test("SSE capture rejects unsuccessful or misleading content-type handshakes", async (t) => {
  for (const [status, type] of [
    [404, "text/event-stream"],
    [200, "text/event-stream-extra"],
  ]) {
    const url = await serve(t, (_req, res) => {
      res.writeHead(status, { "content-type": type });
      res.end("data: rejected\n\n");
    });
    await assert.rejects(captureSSE({ url }));
  }
});

test("SSE parser handles every byte split, BOM/UTF-8, CRLF boundaries and connection-local ID/retry state", async () => {
  const { boundedSSEParser } = await import("../src/sse-parser.mjs");
  const bytes = Buffer.from(
    "\ufeffid: first\r\n\r\nretry: 1500\r\nevent: update\r\ndata: 中文🙂\r\ndata: two\r\n\r\nid: bad\0id\ndata: kept-id\n\nid:\ndata:\n\nretry: not-number\nunknown: ignored\ndata: last\n\ndata: incomplete\n",
  );
  const expected = [
    { event: "update", id: "first", data: "中文🙂\ntwo", retry: 1500 },
    { event: "message", id: "first", data: "kept-id", retry: 1500 },
    { event: "message", id: "", data: "", retry: 1500 },
    { event: "message", id: "", data: "last", retry: 1500 },
  ];
  for (let split = 0; split <= bytes.length; split++) {
    const events = [],
      parser = boundedSSEParser((event) => events.push(event));
    parser.feed(bytes.subarray(0, split));
    parser.feed(bytes.subarray(split));
    parser.finish();
    assert.deepEqual(events, expected, `byte split ${split}`);
  }
  const single = [],
    parser = boundedSSEParser((event) => single.push(event));
  for (const byte of bytes) parser.feed(Uint8Array.of(byte));
  parser.finish();
  assert.deepEqual(single, expected);
  const other = [],
    fresh = boundedSSEParser((event) => other.push(event));
  fresh.feed(Buffer.from("data: separate\n\n"));
  fresh.finish();
  assert.deepEqual(other, [{ event: "message", id: "", data: "separate" }]);
  const double = [],
    bom = boundedSSEParser((event) => double.push(event));
  bom.feed(Buffer.from("\ufeff\ufeffdata: not a valid field\n\n"));
  bom.finish();
  assert.deepEqual(double, []);
});
test("SSE byte and unfinished-event limits include discarded comments and multi-byte payloads", async () => {
  const { boundedSSEParser } = await import("../src/sse-parser.mjs");
  const comments = boundedSSEParser(() => {}, { maxWireBytes: 20 });
  assert.throws(
    () => comments.feed(Buffer.from(": " + "x".repeat(21))),
    /字节上限/,
  );
  const oversized = boundedSSEParser(() => {}, {
    maxWireBytes: 8 * 1024 * 1024,
  });
  assert.throws(
    () => oversized.feed(Buffer.from("data: " + "x".repeat(1024 * 1024 + 1))),
    /1 MiB/,
  );
  const unicode = boundedSSEParser(() => {}, { maxWireBytes: 8 * 1024 * 1024 });
  assert.throws(
    () => unicode.feed(Buffer.from("data: " + "中".repeat(400000) + "\n\n")),
    /1 MiB/,
  );
});
test("SSE event count stops a large chunk without delivering extra events", async (t) => {
  const url = await serve(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(Array.from({ length: 200 }, (_, i) => `data: ${i}\n\n`).join(""));
  });
  const result = await captureSSE({ url, maxEvents: 3 });
  assert.equal(result.limited, true);
  assert.deepEqual(
    result.events.map((x) => x.data),
    ["0", "1", "2"],
  );
});
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("SSE fixture state timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
test("interactive SSE decodes real fragments, retains typed metadata, ignores comments and closes", async (t) => {
  const url = await serve(t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    const body = Buffer.from(
      "id: cursor\r\n\r\n: heartbeat\r\n\r\nevent: update\r\ndata: 中文\r\n\r\ndata: next\r\rdata: unfinished",
    );
    for (let i = 0; i < body.length; i += 3) {
      res.write(body.subarray(i, i + 3));
      await new Promise((r) => setTimeout(r, 1));
    }
    res.end();
  });
  const sessions = new ProtocolSessions();
  t.after(() => sessions.close());
  const session = sessions.start({ type: "sse", url });
  await until(() => sessions.snapshot(session.id).state === "closed");
  const events = sessions
    .snapshot(session.id)
    .events.filter((e) => e.direction === "received");
  assert.equal(events.length, 2);
  assert.match(events[0].data, /data: 中文/);
  assert.equal(events[0].sse.id, "cursor");
  assert.equal(events[0].sse.event, "update");
  assert.equal(events[1].sse.id, "cursor");
  assert.equal(events[1].truncated, false);
});
test("interactive SSE stop and capture abort close real active HTTP streams without reconnect", async (t) => {
  let requests = 0,
    closed = 0;
  const url = await serve(t, (_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    res.on("close", () => closed++);
  });
  const sessions = new ProtocolSessions();
  t.after(() => sessions.close());
  const session = sessions.start({ type: "sse", url });
  await until(() => sessions.snapshot(session.id).events.length === 1);
  sessions.stop(session.id);
  await until(() => closed === 1);
  assert.equal(sessions.snapshot(session.id).state, "closed");
  const controller = new AbortController();
  const pending = captureSSE({ url, duration: 30000 }, controller.signal);
  await until(() => requests === 2);
  controller.abort();
  await assert.rejects(pending);
  await until(() => closed === 2);
  assert.equal(requests, 2);
});
