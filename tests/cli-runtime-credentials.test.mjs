import test from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { readRuntimeCredentials } from "../src/cli-runtime-credentials.mjs";

test("CLI credential input decodes split UTF-8 and only accepts protocol maps", async () => {
  const value = {
    grpcCredentials: {
      step: { metadata: [{ key: "x-label", value: "中文" }] },
    },
  };
  const bytes = Buffer.from(JSON.stringify(value));
  assert.deepEqual(
    await readRuntimeCredentials(
      Readable.from([...bytes].map((b) => Buffer.from([b]))),
    ),
    value,
  );
  for (const text of [
    "null",
    "[]",
    "true",
    '{"unknown":{}}',
    '{"__proto__":{}}',
    '{"grpcCredentials":null}',
    '{"protocolCredentials":[]}',
  ])
    await assert.rejects(readRuntimeCredentials(Readable.from([text])), /凭据/);
});
test("CLI credential malformed and excessive input fails without echoing secrets", async () => {
  for (const bytes of [
    Buffer.from("secret-not-json"),
    Buffer.from([0xff]),
    Buffer.from("x".repeat(1024 * 1024 + 1)),
  ]) {
    await assert.rejects(
      readRuntimeCredentials(Readable.from([bytes])),
      (e) => !e.message.includes("secret-not-json") && /凭据/.test(e.message),
    );
  }
});
test("CLI credential input is bounded by deadline and cancellation and refuses interactive terminal", async () => {
  const stalled = new PassThrough();
  await assert.rejects(
    readRuntimeCredentials(stalled, { timeoutMs: 100 }),
    /期限/,
  );
  assert.equal(stalled.destroyed, true);
  const controller = new AbortController(),
    pending = new PassThrough();
  const result = readRuntimeCredentials(pending, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, /取消/);
  assert.equal(pending.destroyed, true);
  await assert.rejects(
    readRuntimeCredentials(Readable.from(["{}"]), {
      signal: controller.signal,
    }),
    /取消/,
  );
  const tty = Readable.from(["{}"]);
  tty.isTTY = true;
  await assert.rejects(readRuntimeCredentials(tty), /交互终端/);
  for (const timeoutMs of [0, 99, 30001, Infinity, 1.5])
    await assert.rejects(
      readRuntimeCredentials(Readable.from(["{}"]), { timeoutMs }),
      /期限/,
    );
});
