import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { deserializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { serveMCPStdio } from "../src/mcp-stdio.mjs";

const request = (id, method = "ping") => ({ jsonrpc: "2.0", id, method });
const frame = (message) => JSON.stringify(message) + "\n";
function session(dispatch, options = {}) {
  const input = new PassThrough(),
    output = new PassThrough();
  const replies = [];
  const waiters = [];
  let pending = "";
  output.on("data", (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const text = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const reply = JSON.parse(text);
      replies.push(reply);
      waiters.shift()?.(reply);
    }
  });
  const serving = serveMCPStdio({ input, output, dispatch, ...options });
  return {
    input,
    replies,
    serving,
    send(message) {
      const next = new Promise((resolve) => waiters.push(resolve));
      input.write(typeof message === "string" ? message : frame(message));
      return next;
    },
    async close() {
      input.end();
      await serving;
    },
  };
}
const successful = (message) => ({
  jsonrpc: "2.0",
  id: message.id,
  result: {},
});

test("stdio omits uncorrelatable IDs and distinguishes JSON parse from schema failures", async () => {
  let dispatches = 0;
  const s = session(async (message) => {
    dispatches++;
    return successful(message);
  });
  try {
    for (const [message, code] of [
      ["{broken-json\n", -32700],
      [request("x".repeat(257)), -32600],
      [request("x".repeat(8 * 1024 * 1024)), -32600],
      [request("界".repeat(86)), -32600],
      [request(1.5), -32600],
      [request(Number.MAX_SAFE_INTEGER + 1), -32600],
      [request(null), -32600],
      [request({ unsafe: "id" }), -32600],
      [{ jsonrpc: "2.0", id: 13, method: 1 }, -32600],
    ]) {
      const response = await s.send(message);
      assert.equal(Object.hasOwn(response, "id"), false);
      assert.equal(response.error.code, code);
      assert(Buffer.byteLength(frame(response)) < 1024);
      assert.deepEqual(deserializeMessage(frame(response)), response);
    }
    assert.equal(
      dispatches,
      0,
      "invalid requests must never reach project tools",
    );
    const ping = await s.send(request(7));
    assert.deepEqual(ping, successful(request(7)));
    assert.equal(dispatches, 1);
  } finally {
    await s.close();
  }
});

test("stdio preserves legal zero/empty/boundary IDs on duplicate errors without exhausting valid work", async () => {
  let dispatches = 0;
  const s = session(async (message) => {
    dispatches++;
    return successful(message);
  });
  try {
    for (const id of [0, "", "\0".repeat(256), Number.MAX_SAFE_INTEGER]) {
      assert.equal((await s.send(request(id))).id, id);
      const duplicate = await s.send(request(id));
      assert.equal(duplicate.id, id);
      assert.equal(duplicate.error.code, -32600);
      assert.deepEqual(deserializeMessage(frame(duplicate)), duplicate);
    }
    assert.equal(dispatches, 4);
    assert.equal(
      (await s.send(request("after-duplicate"))).id,
      "after-duplicate",
    );
  } finally {
    await s.close();
  }
});

test("stdio tool concurrency errors remain correlated and do not block unrelated ping", async () => {
  let release,
    dispatches = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const s = session(
    async (message) => {
      dispatches++;
      if (message.method === "tools/call") await held;
      return successful(message);
    },
    { maxTools: 1 },
  );
  try {
    s.input.write(frame(request("held", "tools/call")));
    const limited = await s.send(request("limited", "tools/call"));
    assert.equal(limited.id, "limited");
    assert.equal(limited.error.code, -32000);
    assert.deepEqual(deserializeMessage(frame(limited)), limited);
    assert.equal((await s.send(request("ping"))).id, "ping");
    assert.equal(dispatches, 2);
  } finally {
    release();
    await delay(1);
    await s.close();
  }
});

test("stdio session request quota errors preserve valid IDs and invalid requests consume no quota", async () => {
  let dispatches = 0;
  const s = session(async (message) => {
    dispatches++;
    return successful(message);
  });
  try {
    const invalid = await s.send(request("x".repeat(257)));
    assert.equal(invalid.error.code, -32600);
    for (let id = 0; id < 1024; id++)
      assert.deepEqual(await s.send(request(id)), successful(request(id)));
    assert.equal(dispatches, 1024);
    const exhausted = await s.send(request(1024));
    assert.equal(exhausted.id, 1024);
    assert.equal(exhausted.error.code, -32600);
    assert.deepEqual(deserializeMessage(frame(exhausted)), exhausted);
    assert.equal(dispatches, 1024);
  } finally {
    await s.close();
  }
});
