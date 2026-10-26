// Actual TLS over PostgreSQL SSLRequest, not a PostgreSQL SQL server fixture.
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { readFile } from "node:fs/promises";
import {
  explicitPostgresOptions,
  createExplicitPostgresClient,
} from "../../src/postgres-client.mjs";

export async function verifyPostgresTLS() {
  const cert = await readFile(
    new URL("./localhost.crt", import.meta.url),
    "utf8",
  );
  const key = await readFile(
    new URL("./localhost.key", import.meta.url),
    "utf8",
  );
  const secureContext = tls.createSecureContext({ cert, key });
  for (const scenario of [
    { host: "localhost", ca: cert, ok: true },
    { host: "localhost", ok: false, error: /self.signed|certificate/i },
    { host: "wrong.fixture", ca: cert, ok: false, error: /hostname|altnames/i },
  ]) {
    const sockets = new Set(),
      errors = [];
    let negotiations = 0,
      startups = 0,
      passwords = 0;
    const server = net.createServer((raw) => {
      sockets.add(raw);
      raw.on("error", () => {});
      let first = Buffer.alloc(0);
      const negotiate = (chunk) => {
        first = Buffer.concat([first, chunk]);
        if (first.length < 8) return;
        try {
          assert.equal(first.length, 8);
          assert.equal(first.readInt32BE(0), 8);
          assert.equal(first.readInt32BE(4), 80877103);
          negotiations++;
          raw.removeListener("data", negotiate);
          raw.write("S");
          const socket = new tls.TLSSocket(raw, {
            isServer: true,
            secureContext,
          });
          sockets.add(socket);
          socket.on("error", () => {});
          let buffer = Buffer.alloc(0),
            started = false;
          socket.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            try {
              while (buffer.length) {
                if (!started) {
                  if (buffer.length < 4) return;
                  const size = buffer.readInt32BE(0);
                  assert(size >= 8 && size <= 65536);
                  if (buffer.length < size) return;
                  assert.equal(buffer.readInt32BE(4), 196608);
                  assert(
                    buffer.subarray(8, size).includes(Buffer.from("tls-user")),
                  );
                  buffer = buffer.subarray(size);
                  startups++;
                  started = true;
                  socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 3]));
                } else {
                  if (buffer.length < 5) return;
                  const tag = buffer[0],
                    size = buffer.readInt32BE(1);
                  assert(size >= 4 && size <= 65536);
                  if (buffer.length < size + 1) return;
                  const packet = buffer.subarray(0, size + 1);
                  buffer = buffer.subarray(size + 1);
                  if (tag === 88) {
                    socket.end();
                    continue;
                  }
                  assert.equal(tag, 112);
                  assert.equal(
                    packet.subarray(5).toString(),
                    "tls-fictional-password\0",
                  );
                  passwords++;
                  socket.write(
                    Buffer.from([
                      82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73,
                    ]),
                  );
                }
              }
            } catch (e) {
              errors.push(e);
              socket.destroy();
            }
          });
        } catch (e) {
          errors.push(e);
          raw.destroy();
        }
      };
      raw.on("data", negotiate);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const stream = new net.Socket();
    const connect = stream.connect.bind(stream);
    // Route only the fixture's TCP socket; retain logical host for real TLS identity checks.
    stream.connect = () => connect(server.address().port, "127.0.0.1");
    const client = await createExplicitPostgresClient(
      explicitPostgresOptions({
        host: scenario.host,
        port: server.address().port,
        user: "tls-user",
        database: "tls-fixture",
        password: "tls-fictional-password",
        ssl: true,
        ...(scenario.ca ? { ca: scenario.ca } : {}),
      }),
      { stream },
    );
    client.on("error", () => {});
    try {
      if (scenario.ok) await client.connect();
      else await assert.rejects(client.connect(), scenario.error);
      assert.equal(negotiations, 1);
      assert.equal(startups, scenario.ok ? 1 : 0);
      assert.equal(passwords, scenario.ok ? 1 : 0);
      assert.deepEqual(errors, []);
    } finally {
      await client.end().catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  console.log("EXPLICIT_PG_TLS_NEGOTIATION_CA_IDENTITY_PASS");
}
