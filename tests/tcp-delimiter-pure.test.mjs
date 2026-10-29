import test from "node:test";
import assert from "node:assert/strict";
import {
  createTCPDelimiterMatcher,
  normalizeTCPDelimiter,
} from "../src/tcp-delimiter.mjs";

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
