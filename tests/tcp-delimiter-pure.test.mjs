import test from "node:test";
import assert from "node:assert/strict";
import {
  createTCPDelimiterMatcher,
  normalizeTCPDelimiter,
  validateTCPDelimiterEvidence,
} from "../src/tcp-delimiter.mjs";
import { protocolRequestOptions } from "../src/protocol-request-options.mjs";

test("TCP delimiter accepts only bounded whole hex bytes without coercion", () => {
  assert.equal(normalizeTCPDelimiter("0D0a00FF"), "0d0a00ff");
  assert.equal(normalizeTCPDelimiter("ab".repeat(64)), "ab".repeat(64));
  for (const value of [
    undefined,
    null,
    false,
    10,
    [],
    {},
    "",
    "0",
    "0x0a",
    " 0a",
    "0a ",
    "0a\n",
    "gg",
    "ab".repeat(65),
  ])
    assert.throws(() => normalizeTCPDelimiter(value), /TCP 结束标记/);
});

test("TCP delimiter matches the first marker across every split and retains already-read trailing bytes", () => {
  const bytes = Buffer.from("00ff410d0a42430d0a", "hex"),
    markerEnd = 5;
  for (let split = 0; split < markerEnd; split++) {
    const matcher = createTCPDelimiterMatcher("0d0a");
    assert.equal(matcher.push(bytes.subarray(0, split)), false);
    assert.equal(matcher.push(bytes.subarray(split)), true);
    assert.deepEqual(matcher.snapshot(), {
      matched: true,
      frame: bytes.subarray(0, markerEnd),
      trailing: bytes.subarray(markerEnd),
    });
    assert.throws(() => matcher.push(Buffer.from("later")), /已经匹配/);
  }
});

test("TCP delimiter handles overlapping prefixes and byte-wise Unicode without text decoding", () => {
  for (const [hex, text] of [
    ["61626162", "aabab"],
    ["61616162", "aaaaab"],
    [Buffer.from("雪😀").toString("hex"), "body雪😀"],
  ]) {
    const bytes = Buffer.from(text),
      matcher = createTCPDelimiterMatcher(hex);
    for (let i = 0; i < bytes.length; i++)
      assert.equal(
        matcher.push(bytes.subarray(i, i + 1)),
        i === bytes.length - 1,
      );
    assert.deepEqual(matcher.snapshot(), {
      matched: true,
      frame: bytes,
      trailing: Buffer.alloc(0),
    });
  }
});

test("TCP delimiter incomplete snapshots retain exact partial and empty bytes without inventing completion", () => {
  const matcher = createTCPDelimiterMatcher("0d0a");
  assert.deepEqual(matcher.snapshot(), {
    matched: false,
    frame: Buffer.alloc(0),
    trailing: Buffer.alloc(0),
  });
  assert.equal(matcher.push(Buffer.from("body\r")), false);
  assert.deepEqual(matcher.snapshot(), {
    matched: false,
    frame: Buffer.from("body\r"),
    trailing: Buffer.alloc(0),
  });
});

test("TCP delimiter input and snapshot mutation cannot alter the private received bytes", () => {
  const matcher = createTCPDelimiterMatcher("00ff"),
    source = Buffer.from("aa00", "hex");
  matcher.push(source);
  source.fill(0);
  matcher.snapshot().frame.fill(0);
  assert.equal(matcher.push(Buffer.from("ffbb", "hex")), true);
  const result = matcher.snapshot();
  assert.equal(result.frame.toString("hex"), "aa00ff");
  assert.equal(result.trailing.toString("hex"), "bb");
  result.frame.fill(0);
  result.trailing.fill(0);
  assert.equal(matcher.snapshot().frame.toString("hex"), "aa00ff");
  assert.equal(matcher.snapshot().trailing.toString("hex"), "bb");
});

test("TCP delimiter counts all received bytes including the matched chunk tail against the unchanged cap", () => {
  const matcher = createTCPDelimiterMatcher("00");
  assert.throws(() => matcher.push("text"), /须为字节/);
  const oversized = Buffer.alloc(1048577);
  assert.throws(() => matcher.push(oversized), /超过 1 MiB/);
  assert.deepEqual(matcher.snapshot().frame, Buffer.alloc(0));
  assert.equal(matcher.push(Buffer.from([0, 1])), true);
  assert.deepEqual(matcher.snapshot().trailing, Buffer.from([1]));
});

test("TCP delimiter options are explicit and leave old completion shapes unchanged", () => {
  assert.deepEqual(protocolRequestOptions({ type: "tcp" }), {});
  for (const completion of ["end", "first-data"])
    assert.deepEqual(protocolRequestOptions({ type: "tcp", completion }), {
      completion,
    });
  assert.deepEqual(
    protocolRequestOptions({
      type: "tcp",
      completion: "delimiter",
      delimiterHex: "0D0A",
    }),
    { completion: "delimiter", delimiterHex: "0d0a" },
  );
  for (const input of [
    { type: "tcp", delimiterHex: "0a" },
    { type: "tcp", completion: "first-data", delimiterHex: "0a" },
    { type: "tcp", completion: "delimiter" },
    { type: "tcp", completion: "delimiter", delimiterHex: null },
    { type: "sse", completion: "delimiter", delimiterHex: "0a" },
    { type: "websocket", delimiterHex: "0a" },
  ])
    assert.throws(() => protocolRequestOptions(input), /TCP/);
});

test("TCP delimiter evidence validates first-frame boundaries and partial flags without repairing inputs", () => {
  const definition = { completion: "delimiter", delimiterHex: "0d0a" };
  const evidence = (hex, matched, tail = "") => ({
    base64: Buffer.from(hex, "hex").toString("base64"),
    size: hex.length / 2,
    timedOut: false,
    partial: !matched,
    framing: {
      matched,
      trailingBase64: Buffer.from(tail, "hex").toString("base64"),
      trailingSize: tail.length / 2,
    },
  });
  for (const good of [
    evidence("ff0d0a", true, "010d0a"),
    evidence("", false),
    evidence("ff0d", false),
    { ...evidence("ff0d", false), timedOut: true },
  ])
    assert.equal(validateTCPDelimiterEvidence(definition, good), true);
  const good = evidence("ff0d0a", true, "01");
  for (const bad of [
    { ...good, partial: true },
    { ...good, timedOut: true },
    { ...good, size: 2 },
    { ...good, base64: good.base64 + "=" },
    { ...good, framing: { ...good.framing, trailingSize: 0 } },
    { ...good, framing: { ...good.framing, unknown: true } },
    evidence("0d0a000d0a", true),
    evidence("ff0d0a00", true),
    evidence("ff0d0a", false),
    evidence("ff0d", false, "00"),
    { ...evidence("ff0d", false), partial: false },
    { ...good, framing: undefined },
  ]) {
    const before = structuredClone(bad);
    assert.throws(
      () => validateTCPDelimiterEvidence(definition, bad),
      /证据无效/,
    );
    assert.deepEqual(bad, before);
  }
  const oversizedTail = Buffer.alloc(1048576);
  assert.throws(
    () =>
      validateTCPDelimiterEvidence(definition, {
        ...good,
        framing: {
          matched: true,
          trailingBase64: oversizedTail.toString("base64"),
          trailingSize: oversizedTail.length,
        },
      }),
    /证据无效/,
  );
});
