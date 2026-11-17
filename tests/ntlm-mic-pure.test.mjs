// Reviewed import graph: NTLM byte helper, node:crypto, existing js-md4 only.
import test from "node:test";
import assert from "node:assert/strict";
import { ntlmType1, parseNtlmChallenge, ntlmType3 } from "../src/ntlm.mjs";
import {
  av,
  bytes,
  header,
  credentials,
  challengeMessage,
  verifyMic,
} from "./helpers/ntlm-mic-fixture.mjs";
const generate = (type2, type1 = ntlmType1(credentials)) =>
  bytes(ntlmType3(parseNtlmChallenge(header(type2)), credentials, type1));

test("timestamp MIC independently binds the full three-message transcript with both Version layouts", () => {
  for (const version of [false, true]) {
    const type1 = ntlmType1(credentials),
      type2 = challengeMessage({ version, padding: 5 });
    const before = Buffer.from(type2),
      type3 = generate(type2, type1),
      result = verifyMic(bytes(type1), type2, type3);
    assert(result.proofValid);
    assert(result.micValid);
    assert.deepEqual(type2, before);
    assert.deepEqual(result.lm, Buffer.alloc(24));
    assert.equal(type3.readUInt32LE(16), 88);
    assert.deepEqual(
      type3.subarray(64, 72),
      version ? Buffer.from("0601b11d0000000f", "hex") : Buffer.alloc(8),
    );
    assert.deepEqual(
      result.pairs.filter((p) => p.id === 6).map((p) => p.value),
      [Buffer.from("02000000", "hex")],
    );
    assert.deepEqual(
      result.pairs.filter((p) => p.id === 7).map((p) => p.value),
      [Buffer.from("0011223344556601", "hex")],
    );
    for (const at of [12, 20, 28, 36, 44])
      assert(type3.readUInt32LE(at + 4) >= 88);
    assert.equal(type3.readUInt16LE(52), 0);
  }
});

test("AV flags zero is upgraded once for timestamp and bit two is a client MIC indication", () => {
  for (const options of [
    { flags: 0 },
    { flags: 2 },
    { timestamp: false, flags: 2 },
  ]) {
    const type1 = ntlmType1(credentials),
      type2 = challengeMessage(options),
      type3 = generate(type2, type1);
    const result = verifyMic(bytes(type1), type2, type3);
    assert(result.proofValid);
    assert(result.micValid);
    assert.equal(result.pairs.filter((p) => p.id === 6).length, 1);
    assert.equal(result.pairs.find((p) => p.id === 6).value.readUInt32LE(), 2);
  }
});

test("legacy no-timestamp no-MIC messages keep their old offsets without a transcript argument", () => {
  for (const version of [false, true])
    for (const flags of [undefined, 0]) {
      const type2 = challengeMessage({ timestamp: false, flags, version });
      const parsed = parseNtlmChallenge(header(type2));
      assert.equal(parsed.provideMic, false);
      const type3 = bytes(ntlmType3(parsed, credentials));
      assert.equal(type3.readUInt32LE(16), version ? 72 : 64);
      const nt = type3.subarray(
        type3.readUInt32LE(24),
        type3.readUInt32LE(24) + type3.readUInt16LE(20),
      );
      assert.deepEqual(nt.subarray(44, -4), parsed.targetInfo);
    }
});

test("the independent oracle detects Type1, exact Type2 padding and Type3 tampering", () => {
  const type1 = bytes(ntlmType1(credentials)),
    type2 = challengeMessage({ padding: 3 }),
    type3 = generate(type2, header(type1));
  assert(verifyMic(type1, type2, type3).micValid);
  const wrong1 = Buffer.from(type1);
  wrong1[32] ^= 1;
  assert.equal(verifyMic(wrong1, type2, type3).micValid, false);
  const wrong2 = Buffer.from(type2);
  wrong2[wrong2.length - 1] ^= 1;
  const result = verifyMic(type1, wrong2, type3);
  assert(result.proofValid);
  assert.equal(result.micValid, false);
  const wrong3 = Buffer.from(type3);
  wrong3[72] ^= 1;
  assert.equal(verifyMic(type1, type2, wrong3).micValid, false);
  wrong3[72] ^= 1;
  wrong3[wrong3.length - 1] ^= 1;
  assert.equal(verifyMic(type1, type2, wrong3).micValid, false);
});

test("MIC requires actual well-formed host Type1 and authoritative original Type2", () => {
  const type1 = ntlmType1(credentials),
    type2 = challengeMessage(),
    parsed = parseNtlmChallenge(header(type2));
  for (const value of [
    undefined,
    "",
    "NTLM !!!!",
    header(type2),
    type1 + "=",
    "NTLM " + "A".repeat(16388),
  ])
    assert.throws(() => ntlmType3(parsed, credentials, value), /Type1/);
  const bad = bytes(type1);
  bad.writeUInt32LE(0xffffff00, 20);
  assert.throws(() => ntlmType3(parsed, credentials, header(bad)), /Type1/);
  const { message, ...withoutMessage } = parsed;
  assert.throws(() => ntlmType3(withoutMessage, credentials, type1), /Type2/);
  assert.throws(
    () =>
      ntlmType3(
        { ...parsed, message: Buffer.alloc(12289) },
        credentials,
        type1,
      ),
    /Type2/,
  );
  parsed.timestamp = undefined;
  parsed.provideMic = false;
  parsed.targetInfo.fill(0);
  parsed.serverChallenge.fill(0);
  const type3 = bytes(ntlmType3(parsed, credentials, type1));
  assert(verifyMic(bytes(type1), type2, type3).micValid);
  assert(verifyMic(bytes(type1), type2, type3).proofValid);
});

test("MIC support does not admit EPA, SPN, channel binding, unknown flags, downgrade or malformed AVs", () => {
  for (const flags of [1, 3, 4, 0xffffffff])
    assert.throws(
      () => parseNtlmChallenge(header(challengeMessage({ flags }))),
      /AV标志/,
    );
  for (const id of [8, 9, 10, 11])
    assert.throws(
      () =>
        parseNtlmChallenge(
          header(challengeMessage({ extra: [av(id, Buffer.alloc(16))] })),
        ),
      /EPA/,
    );
  assert.throws(
    () =>
      parseNtlmChallenge(
        header(challengeMessage({ flags: 0, extra: [av(6, Buffer.alloc(4))] })),
      ),
    /重复/,
  );
  assert.throws(
    () =>
      parseNtlmChallenge(
        header(challengeMessage({ extra: [av(6, Buffer.alloc(1))] })),
      ),
    /AV标志/,
  );
  for (const flag of [0x10, 0x20, 0x40000000]) {
    const message = challengeMessage();
    message.writeUInt32LE((message.readUInt32LE(20) | flag) >>> 0, 20);
    assert.throws(
      () => parseNtlmChallenge(header(message)),
      /签名|封装|密钥交换/,
    );
  }
  const old = challengeMessage();
  old.writeUInt32LE(0x201, 20);
  assert.throws(() => parseNtlmChallenge(header(old)), /不降级/);
});

test("adding MIC AV flags cannot exceed the existing 8192-byte TargetInfo cap", () => {
  const info = Buffer.concat([
    ...[1, 2, 3, 4].map((id) => av(id, Buffer.alloc(2040))),
    av(7, Buffer.alloc(8)),
    av(0, Buffer.alloc(0)),
  ]);
  assert.equal(info.length, 8192);
  const original = challengeMessage(),
    message = Buffer.alloc(48 + info.length);
  original.copy(message, 0, 0, 48);
  message.writeUInt16LE(info.length, 40);
  message.writeUInt16LE(info.length, 42);
  info.copy(message, 48);
  const parsed = parseNtlmChallenge(header(message)),
    before = Buffer.from(parsed.targetInfo);
  assert.throws(
    () => ntlmType3(parsed, credentials, ntlmType1(credentials)),
    /目标信息超过上限/,
  );
  assert.deepEqual(parsed.targetInfo, before);
});
