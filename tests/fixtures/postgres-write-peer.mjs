// Independent protocol peer, not a database engine: verifies client lifecycle and
// wire intent only, never server-side transaction durability or rollback effects.
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { readFile } from "node:fs/promises";

const packet = (tag, payload) => {
  const bytes = Buffer.alloc(payload.length + 5);
  bytes[0] = tag.charCodeAt(0);
  bytes.writeUInt32BE(payload.length + 4, 1);
  payload.copy(bytes, 5);
  return bytes;
};
const ready = (state) => packet("Z", Buffer.from(state)),
  complete = (command) => packet("C", Buffer.from(command + "\0"));
const field = Buffer.alloc(18);
field.writeUInt32BE(25, 6);
field.writeInt16BE(-1, 10);
field.writeInt32BE(-1, 12);
const description = packet(
  "T",
  Buffer.concat([Buffer.from([0, 1]), Buffer.from("affected_rows\0"), field]),
);
function row(count) {
  const value = Buffer.from(count),
    length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return packet("D", Buffer.concat([Buffer.from([0, 1]), length, value]));
}
export async function startPostgresWritePeer({
  mode = "commit",
  ssl = false,
} = {}) {
  const sockets = [],
    commands = [],
    startups = [];
  let reach,
    fail,
    release,
    commitACK = false,
    rollbackACK = false;
  const reached = new Promise((resolve, reject) => {
    reach = resolve;
    fail = reject;
  });
  reached.catch(() => {});
  const track = (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    return socket;
  };
  const protocol = (socket) => {
    let bytes = Buffer.alloc(0),
      started = false,
      deferred = false;
    const send = (bytes) => {
      if (!socket.destroyed) socket.write(bytes);
    };
    const result = () =>
      send(
        Buffer.concat([
          row(mode === "rollback" ? "1001" : "1"),
          complete("SELECT 1"),
        ]),
      );
    socket.on("data", (chunk) => {
      try {
        bytes = Buffer.concat([bytes, chunk]);
        while (bytes.length) {
          if (!started) {
            if (bytes.length < 4 || bytes.length < bytes.readUInt32BE(0))
              return;
            const length = bytes.readUInt32BE(0);
            assert.equal(bytes.readUInt32BE(4), 196608);
            startups.push(bytes.subarray(8, length).toString());
            bytes = bytes.subarray(length);
            started = true;
            send(Buffer.concat([packet("R", Buffer.alloc(4)), ready("I")]));
            continue;
          }
          if (bytes.length < 5) return;
          const length = bytes.readUInt32BE(1) + 1;
          if (bytes.length < length) return;
          const tag = String.fromCharCode(bytes[0]),
            payload = bytes.subarray(5, length);
          bytes = bytes.subarray(length);
          if (tag === "Q") {
            const sql = payload.toString().replace(/\0$/, "");
            commands.push(sql);
            if (sql === "BEGIN READ WRITE") {
              if (mode === "hold-begin") {
                reach();
                continue;
              }
              send(Buffer.concat([complete("BEGIN"), ready("T")]));
            } else if (sql === "COMMIT") {
              if (mode === "hold-commit") {
                reach();
                continue;
              }
              commitACK = true;
              send(Buffer.concat([complete("COMMIT"), ready("I")]));
              reach();
            } else if (sql === "ROLLBACK") {
              rollbackACK = true;
              send(Buffer.concat([complete("ROLLBACK"), ready("I")]));
              reach();
            }
          } else if (tag === "P") {
            commands.push("DML PREPARE");
            send(packet("1", Buffer.alloc(0)));
          } else if (tag === "B") send(packet("2", Buffer.alloc(0)));
          else if (tag === "D") send(description);
          else if (tag === "E") {
            commands.push("DML EXECUTE");
            if (mode === "hold-dml") reach();
            else if (mode === "defer-dml") deferred = true;
            else result();
          } else if (tag === "S") {
            if (deferred) {
              release = () => {
                result();
                send(ready("T"));
              };
              reach();
            } else if (mode !== "hold-dml") send(ready("T"));
          } else if (tag === "X") commands.push("TERMINATE");
          else throw Error("Unexpected PostgreSQL packet " + tag);
        }
      } catch (error) {
        fail(error);
        socket.destroy();
      }
    });
  };
  let cert, secureContext;
  if (ssl) {
    cert = await readFile(new URL("./localhost.crt", import.meta.url), "utf8");
    const key = await readFile(new URL("./localhost.key", import.meta.url));
    secureContext = tls.createSecureContext({ cert, key });
  }
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    track(socket);
    if (!ssl) return protocol(socket);
    let bytes = Buffer.alloc(0);
    const negotiate = (chunk) => {
      try {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length < 8) return;
        assert.equal(bytes.readUInt32BE(0), 8);
        assert.equal(bytes.readUInt32BE(4), 80877103);
        socket.pause();
        socket.removeListener("data", negotiate);
        socket.write("S");
        if (bytes.length > 8) socket.unshift(bytes.subarray(8));
        protocol(
          track(
            new tls.TLSSocket(socket, {
              isServer: true,
              secureContext,
              allowHalfOpen: true,
            }),
          ),
        );
      } catch (error) {
        fail(error);
        socket.destroy();
      }
    };
    socket.on("data", negotiate);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    cert,
    sockets,
    commands,
    startups,
    reached,
    stats: () => ({ commitACK, rollbackACK }),
    releaseDML: () => {
      assert(release, "deferred query reached Sync");
      release();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
