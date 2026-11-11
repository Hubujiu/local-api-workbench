// Real pinned Tedious + TCP/TLS, synthetic peer only. No SQL Server software.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { TLSSocket } from "node:tls";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import DuplexPair from "native-duplexpair";
import { createTediousSQLServerPort } from "../src/sqlserver-tedious-prep.mjs";
import { sqlServerConnectionContract } from "../src/sqlserver-driver-contract.mjs";
const require = createRequire(import.meta.url);
const MessageIO = require("tedious/lib/message-io.js");
const Debug = require("tedious/lib/debug.js");
const { TYPE } = require("tedious/lib/packet.js");
const cert = readFileSync(new URL("./fixtures/localhost.crt", import.meta.url));
const wrongCert = readFileSync(
  new URL("./fixtures/sqlserver-wrong-host.crt", import.meta.url),
);
const key = readFileSync(new URL("./fixtures/localhost.key", import.meta.url));
const username = "fictional-tds-user-测试",
  password = "fictional-tds-password-😀";
function response(encryption) {
  const values = encryption === undefined ? [] : [encryption];
  const offset = 5 * (1 + values.length) + 1;
  const b = Buffer.alloc(offset + 6 + values.length);
  b.writeUInt16BE(offset, 1);
  b.writeUInt16BE(6, 3);
  b[offset] = 1;
  b[offset - 1] = 255;
  if (values.length) {
    b[5] = 1;
    b.writeUInt16BE(offset + 6, 6);
    b.writeUInt16BE(1, 8);
    b[offset + 6] = encryption;
  }
  return b;
}
async function read(io, type) {
  const message = await io.readMessage();
  assert.equal(message.type, type);
  const chunks = [];
  for await (const c of message) chunks.push(c);
  return Buffer.concat(chunks);
}
function noCredentials(bytes) {
  const encoded = Buffer.from(password, "utf16le");
  for (let i = 0; i < encoded.length; i++)
    encoded[i] = (((encoded[i] << 4) & 240) | (encoded[i] >> 4)) ^ 165;
  for (const marker of [
    Buffer.from(username, "utf16le"),
    Buffer.from(password, "utf16le"),
    encoded,
  ])
    assert.equal(
      bytes.includes(marker),
      false,
      "fictional credentials must not appear on raw TCP",
    );
}
async function fixture(t, { certificate = cert, ca = cert } = {}) {
  const server = createServer(),
    sockets = [],
    pairs = [];
  let port;
  t.after(async () => {
    port?.destroy();
    for (const p of pairs) {
      p.cleartext.destroy();
      p.encrypted.destroy();
    }
    for (const s of sockets) s.destroy();
    if (server.listening) await new Promise((r) => server.close(r));
  });
  server.on("connection", (s) => {
    sockets.push(s);
    s.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  port = createTediousSQLServerPort(
    sqlServerConnectionContract({
      host: "127.0.0.1",
      port: server.address().port,
      user: username,
      password,
      database: "fictional_database",
      ssl: true,
      ...(ca ? { ca: ca.toString() } : {}),
    }),
  );
  const accepted = once(server, "connection");
  const outcome = port.connect().then(
    () => ({ success: true }),
    (error) => ({ error }),
  );
  const [socket] = await accepted;
  const wire = [];
  socket.on("data", (c) => wire.push(c));
  const io = new MessageIO(socket, 4096, new Debug());
  const prelogin = await read(io, TYPE.PRELOGIN);
  noCredentials(prelogin);
  // The actual driver asks for full encryption, not login-only encryption.
  let encrypt;
  for (let i = 0; prelogin[i] !== 255; i += 5)
    if (prelogin[i] === 1) encrypt = prelogin[prelogin.readUInt16BE(i + 1)];
  assert.equal(encrypt, 1);
  async function tls() {
    const pair = new DuplexPair();
    const cleartext = new TLSSocket(pair.socket1, {
      isServer: true,
      key,
      cert: certificate,
      maxVersion: "TLSv1.2",
      minVersion: "TLSv1.2",
    });
    cleartext.on("error", () => {});
    const secure = { cleartext, encrypted: pair.socket2 };
    pairs.push(secure);
    const established = once(cleartext, "secure");
    established.catch(() => {});
    for (let i = 0; i < 2; i++) {
      secure.encrypted.write(await read(io, TYPE.PRELOGIN));
      await once(secure.encrypted, "readable");
      const chunks = [];
      let chunk;
      while ((chunk = secure.encrypted.read())) chunks.push(chunk);
      await once(io.sendMessage(TYPE.PRELOGIN, Buffer.concat(chunks)), "end");
    }
    socket.unpipe();
    io.outgoingMessageStream.unpipe(socket);
    socket.pipe(secure.encrypted);
    secure.encrypted.pipe(socket);
    const encryptedIO = new MessageIO(cleartext, 4096, new Debug());
    await established;
    assert.equal(cleartext.getProtocol(), "TLSv1.2");
    return encryptedIO;
  }
  async function failed() {
    const result = await outcome;
    assert.equal(result.success, undefined);
    assert.equal(result.error.message, "SQL Server WIP transport failed");
    await port.closed.catch((e) =>
      assert.equal(e.message, "SQL Server WIP transport failed"),
    );
    assert.equal(sockets.length, 1);
    noCredentials(Buffer.concat(wire));
  }
  return { io, tls, failed, socket, wire, outcome };
}
for (const encryption of [0, 2, undefined, 4])
  test(
    `PRELOGIN ${encryption} rejects without plaintext LOGIN7 or retry`,
    { timeout: 8000 },
    async (t) => {
      const f = await fixture(t);
      const after = [];
      f.socket.on("data", (c) => after.push(c));
      f.io.sendMessage(TYPE.RESPONSE, response(encryption));
      await f.failed();
      assert.equal(Buffer.concat(after).length, 0);
    },
  );
for (const encryption of [1, 3])
  test(
    `ENCRYPT ${encryption} carries LOGIN7 only after trusted TLS, then synthetic peer rejects`,
    { timeout: 8000 },
    async (t) => {
      const f = await fixture(t);
      f.io.sendMessage(TYPE.RESPONSE, response(encryption));
      const secure = await f.tls();
      const login = await read(secure, TYPE.LOGIN7);
      assert.equal(login.includes(Buffer.from(username, "utf16le")), true);
      assert.equal(
        login.includes(Buffer.from("fictional_database", "utf16le")),
        true,
      );
      // Intentionally do not ACK login, run SQL or claim authentication success.
      f.socket.destroy();
      await f.failed();
    },
  );
for (const [name, options] of [
  ["untrusted CA", { ca: null }],
  ["hostname mismatch", { certificate: wrongCert, ca: wrongCert }],
])
  test(`${name} sends no decrypted LOGIN7`, { timeout: 8000 }, async (t) => {
    const f = await fixture(t, options);
    f.io.sendMessage(TYPE.RESPONSE, response(1));
    const secure = await f.tls();
    const next = secure.incomingMessageIterator.next();
    await f.failed();
    assert.equal((await next).done, true);
  });
