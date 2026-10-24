import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { encodeISO8583, decodeISO8583 } from "../src/iso8583-codec.mjs";
import { protocolPayload } from "../src/protocol-payload.mjs";
import { exchangeTCP } from "../src/protocols.mjs";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
const simple = { fields: { 3: { kind: "numeric", length: 6 } } };
const profile = {
  fields: {
    3: { kind: "numeric", length: 6 },
    11: { kind: "numeric", length: 6 },
    48: { kind: "lllvarText", length: 999 },
    64: { kind: "binary", length: 8 },
    70: { kind: "numeric", length: 3 },
  },
};
const packet = (fields = { 3: "000000" }, p = simple) => ({
  format: "iso8583",
  profile: structuredClone(p),
  mti: "0800",
  fields,
});
test("ISO8583 known ASCII primary vector and two-byte length are exact", () => {
  const encoded = encodeISO8583(packet());
  assert.equal(
    encoded.toString("hex"),
    "0012303830302000000000000000303030303030",
  );
  assert.deepEqual(decodeISO8583(simple, encoded), {
    mti: "0800",
    fields: { 3: "000000" },
    bytesRead: 20,
  });
  const raw = { ...simple, lengthPrefix: false };
  assert.equal(
    encodeISO8583(packet(undefined, raw)).toString("hex"),
    "303830302000000000000000303030303030",
  );
});
test("ISO8583 secondary, binary and variable fields roundtrip without invented field specs", () => {
  for (let i = 0; i < 400; i++) {
    const fields = {
      3: String(i).padStart(6, "0"),
      11: String(i + 1).padStart(6, "0"),
      48: "fixture-" + i,
      64: "0011223344556677",
      ...(i % 2 ? { 70: "301" } : {}),
    };
    const encoded = encodeISO8583(packet(fields, profile)),
      decoded = decodeISO8583(profile, encoded);
    assert.deepEqual(decoded.fields, fields);
    assert(encodeISO8583(packet(decoded.fields, profile)).equals(encoded));
  }
  const bcd = {
    mtiEncoding: "bcd",
    fields: {
      3: { kind: "numeric", length: 6, encoding: "bcd" },
      48: {
        kind: "llvarNumeric",
        length: 19,
        encoding: "bcd",
        lengthEncoding: "bcd",
      },
    },
  };
  const encoded = encodeISO8583(packet({ 3: "123456", 48: "123456789" }, bcd));
  assert.deepEqual(decodeISO8583(bcd, encoded).fields, {
    3: "123456",
    48: "123456789",
  });
});
test("ISO8583 guards reject Unicode corruption, malformed profiles, reserved fields and parser truncation/trailing bytes", () => {
  for (const input of [
    packet({ 3: "abcdef" }),
    packet({ 3: "1234567" }),
    packet({ 48: "中文" }, profile),
    packet({ 64: "zz" }, profile),
    packet({ 90: "unknown" }),
    { ...packet(), mti: "ABC0" },
    packet({ 65: "1" }, { fields: { 65: { kind: "numeric", length: 1 } } }),
    packet(
      { 70: "301" },
      { bitmapBytes: 8, fields: { 70: { kind: "numeric", length: 3 } } },
    ),
    packet({ 48: "x" }, { fields: { 48: { kind: "llvarText", length: 100 } } }),
  ])
    assert.throws(() => encodeISO8583(input));
  const body = encodeISO8583(packet());
  assert.throws(() => decodeISO8583(simple, body.subarray(0, -1)), /长度头/);
  assert.throws(
    () => decodeISO8583(simple, Buffer.concat([body, Buffer.from([0])])),
    /长度头/,
  );
  const p = { ...simple, lengthPrefix: false },
    raw = body.subarray(2);
  assert.throws(() => decodeISO8583(p, raw.subarray(0, -1)), /截断/);
  assert.throws(
    () => decodeISO8583(p, Buffer.concat([raw, Buffer.from([0])])),
    /尾随/,
  );
  const high = Buffer.from(raw);
  high[high.length - 1] |= 128;
  assert.throws(() => decodeISO8583(p, high), /无损|ASCII/);
  const unknown = JSON.parse(
    '{"fields":{"__proto__":{"kind":"text","length":2}}}',
  );
  assert.throws(() => encodeISO8583(packet({}, unknown)));
});
test("ISO8583 payload snapshots its decode profile before a request can mutate it", () => {
  const input = packet(),
    payload = protocolPayload(input);
  input.profile.fields[3].length = 5;
  assert.equal(payload.decode(payload.buffer).fields[3], "000000");
});
test("ISO8583 real TCP echo reports decoded fields and preserves raw malformed responses", async (t) => {
  const sockets = new Set();
  let corrupt = false;
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    const chunks = [];
    s.on("data", (chunk) => {
      chunks.push(chunk);
      const b = Buffer.concat(chunks);
      if (b.length >= 2 && b.length === b.readUInt16BE(0) + 2)
        s.end(corrupt ? b.subarray(0, -1) : b);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const input = {
    host: "127.0.0.1",
    port: server.address().port,
    message: packet(
      {
        3: "000000",
        11: "000001",
        48: "test",
        64: "0011223344556677",
        70: "301",
      },
      profile,
    ),
  };
  const result = await exchangeTCP(input);
  assert.deepEqual(result.decoded.fields, input.message.fields);
  assert.equal(result.partial, false);
  corrupt = true;
  const invalid = await exchangeTCP(input);
  assert.equal(invalid.decoded, undefined);
  assert.match(invalid.decodeError, /长度头/);
  assert(invalid.base64.length > 0);
});
test("ISO8583 HTTP execution and project backup restore reuse the exact packet definition", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "iso8583-http-")),
    app = await createApp({ root, port: 0 });
  const sockets = new Set();
  let calls = 0;
  const echo = net.createServer((s) => {
    calls++;
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("data", (bytes) => s.end(bytes));
  });
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => echo.close(r));
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("iso fixture");
  project.protocols = [
    {
      id: "iso-fixture",
      type: "tcp",
      url: "127.0.0.1",
      port: echo.address().port,
      message: packet(),
    },
  ];
  await app.store.save(project);
  const saved = await new Store(root).get(project.id),
    headers = {
      "content-type": "application/json",
      "x-local-token": app.token,
    };
  const execute = async (id, definition, h = headers) =>
    fetch(app.url + "/api/projects/" + id + "/protocol", {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        type: "tcp",
        host: definition.url,
        port: definition.port,
        message: definition.message,
        runId: "iso-roundtrip",
      }),
    });
  assert.equal(
    (
      await execute(project.id, saved.protocols[0], {
        "content-type": "application/json",
      })
    ).status,
    403,
  );
  assert.equal(calls, 0);
  const result = await execute(project.id, saved.protocols[0]);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).decoded.mti, "0800");
  const restoredResponse = await fetch(app.url + "/api/restore", {
    method: "POST",
    headers,
    body: JSON.stringify({ document: saved }),
  });
  assert.equal(restoredResponse.status, 201);
  const restored = await restoredResponse.json();
  assert.notEqual(restored.id, project.id);
  assert.deepEqual(restored.protocols[0].message, saved.protocols[0].message);
  const again = await execute(restored.id, restored.protocols[0]);
  assert.equal((await again.json()).decoded.fields[3], "000000");
});
