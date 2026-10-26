import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { BoundedMCPWriter, serveMCPStdio } from "../src/mcp-stdio.mjs";
const frame = (message) => JSON.stringify(message) + "\n";
const request = (id) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "localapi_execute_flow" },
});
const cancel = (id) => ({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId: id },
});
const cancelled = (id) => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [
      { type: "text", text: '{"status":"cancelled","recordSaved":true}' },
    ],
  },
});

test("stdio cancellation handles numeric zero and empty IDs without blocking input", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const seen = [],
    text = [];
  output.on("data", (chunk) => text.push(chunk.toString()));
  const serving = serveMCPStdio({
    input,
    output,
    dispatch: async (message, { signal }) => {
      if (!signal.aborted)
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
      seen.push(message.id);
      return cancelled(message.id);
    },
  });
  input.write(
    frame(request(0)) +
      frame(request("")) +
      frame(cancel(0)) +
      frame(cancel("")),
  );
  await delay(10);
  input.end();
  await serving;
  assert.deepEqual(seen, [0, ""]);
  assert.equal(
    text.join(""),
    "",
    "accepted cancellation suppresses late responses",
  );
});

test("stdio EOF aborts pending execution and waits for handler evidence before returning", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let persisted = false,
    text = "";
  output.on("data", (chunk) => (text += chunk));
  const serving = serveMCPStdio({
    input,
    output,
    dispatch: async (message, { signal }) => {
      if (!signal.aborted)
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
      await delay(20);
      persisted = true;
      return cancelled(message.id);
    },
  });
  input.end(frame(request(7)));
  await serving;
  assert(persisted);
  assert.equal(JSON.parse(text).id, 7);
});

test("stdio rejects oversized unframed input and caps all pending handlers", async () => {
  {
    const input = new PassThrough(),
      output = new PassThrough();
    output.resume();
    let calls = 0;
    const serving = serveMCPStdio({
      input,
      output,
      maxInputBytes: 64,
      dispatch: async () => {
        calls++;
      },
    });
    const rejected = assert.rejects(serving, /input exceeds/);
    input.write("x".repeat(65));
    await rejected;
    assert.equal(calls, 0);
  }
  {
    const input = new PassThrough(),
      output = new PassThrough();
    output.resume();
    let calls = 0;
    const serving = serveMCPStdio({
      input,
      output,
      maxHandlers: 2,
      maxTools: 3,
      dispatch: async (message, { signal }) => {
        calls++;
        if (!signal.aborted)
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
        return cancelled(message.id);
      },
    });
    const rejected = assert.rejects(serving, /handler limit/);
    input.write(frame(request(1)) + frame(request(2)) + frame(request(3)));
    await rejected;
    assert.equal(calls, 2);
  }
});

test("bounded stdio writer settles on EPIPE/close and timeout instead of waiting forever for drain", async () => {
  for (const mode of ["error", "timeout"]) {
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {},
    });
    const writer = new BoundedMCPWriter(output, { timeoutMs: 30 });
    const rejected = assert.rejects(
      writer.send({ jsonrpc: "2.0", id: 1, result: {} }),
      /stdout/,
    );
    if (mode === "error") {
      output.emit("error", Object.assign(Error("EPIPE"), { code: "EPIPE" }));
      output.emit("close");
    }
    await rejected;
    assert.equal(writer.bytes, 0);
    assert.equal(output.listenerCount("drain"), 0);
    writer.dispose();
  }
});

test("stdio output frame and aggregate queue limits are separate and bounded", async () => {
  const output = new Writable({ write(_chunk, _encoding, _callback) {} });
  const writer = new BoundedMCPWriter(output, {
    maxFrameBytes: 200,
    maxQueuedBytes: 210,
    timeoutMs: 100,
  });
  await assert.rejects(
    writer.send({ jsonrpc: "2.0", id: 0, result: "x".repeat(300) }),
    /frame limit/,
  );
  assert.equal(writer.bytes, 0);
  const first = writer.send({ jsonrpc: "2.0", id: 1, result: "x".repeat(90) });
  const rejected = assert.rejects(first, /queue exhausted/);
  await assert.rejects(
    writer.send({ jsonrpc: "2.0", id: 2, result: "x".repeat(90) }),
    /queue exhausted/,
  );
  await rejected;
  assert.equal(writer.bytes, 0);
  writer.dispose();
});
