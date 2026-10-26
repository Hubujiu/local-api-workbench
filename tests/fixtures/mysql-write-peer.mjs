import net from "node:net";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";

// Independent, deliberately small MySQL wire peer. It is not a storage engine:
// tests assert driver traffic/transport ownership, never remote rollback effects.
const packet = (body, sequence) => {
  const bytes = Buffer.alloc(body.length + 4);
  bytes.writeUIntLE(body.length, 0, 3);
  bytes[3] = sequence;
  body.copy(bytes, 4);
  return bytes;
};
const length = (value) => {
  if (value < 251) return Buffer.from([value]);
  const bytes = Buffer.alloc(3);
  bytes[0] = 252;
  bytes.writeUInt16LE(value, 1);
  return bytes;
};
const string = (value) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([length(bytes.length), bytes]);
};
const ok = (affected = 0, warnings = 0) =>
  Buffer.concat([
    Buffer.from([0]),
    length(affected),
    Buffer.from([0, 2, 0, warnings & 255, warnings >> 8]),
  ]);
const eof = Buffer.from([254, 0, 0, 2, 0]);
function column(name) {
  const tail = Buffer.alloc(13);
  tail[0] = 12;
  tail.writeUInt16LE(45, 1);
  tail.writeUInt32LE(255, 3);
  tail[7] = 253; // MYSQL_TYPE_VAR_STRING
  return Buffer.concat([
    ...["def", "fixture", "", "", name, name].map(string),
    tail,
  ]);
}
function greeting(id) {
  const capabilities = 512 | 8192 | 32768 | 131072 | 524288,
    connectionId = Buffer.alloc(4),
    low = Buffer.alloc(2),
    high = Buffer.alloc(2);
  connectionId.writeUInt32LE(id);
  low.writeUInt16LE(capabilities & 65535);
  high.writeUInt16LE(capabilities >>> 16);
  return packet(
    Buffer.concat([
      Buffer.from([10]),
      Buffer.from("8.0-fictional\0"),
      connectionId,
      Buffer.from("abcdefgh\0"),
      low,
      Buffer.from([45, 2, 0]),
      high,
      Buffer.from([21]),
      Buffer.alloc(10),
      Buffer.from("ijklmnopqrst\0mysql_native_password\0"),
    ]),
    0,
  );
}
export async function startMySQLWritePeer({
  hold,
  fail,
  delays = {},
  count = 1,
  warning = 0,
  engine = "InnoDB",
  tableType = "BASE TABLE",
  errorText = "fictional-server-secret-bound-value",
} = {}) {
  const peers = [],
    clients = [],
    records = [],
    timers = new Set();
  let server;
  const observe = ({ socket }) => {
    socket.once("connect", () => {
      if (socket.remotePort !== server.address()?.port) return;
      const client = { socket, closed: false };
      client.done = new Promise((resolve) =>
        socket.once("close", () => {
          client.closed = true;
          resolve();
        }),
      );
      clients.push(client);
    });
  };
  channel("net.client.socket").subscribe(observe);
  server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const peer = {
      socket,
      id: peers.length + 41,
      role: peers.length % 2 === 0 ? "data" : "control",
      stage: "greeting",
      pending: [],
    };
    peers.push(peer);
    socket.on("error", () => {});
    const send = (bodies, start = 1) => {
      if (!socket.destroyed)
        socket.write(
          Buffer.concat(bodies.map((body, i) => packet(body, start + i))),
        );
    };
    const reply = (stage, callback) => {
      peer.stage = stage;
      const release = () => {
        if (fail === stage) {
          const code = Buffer.alloc(2);
          code.writeUInt16LE(1105);
          send(
            [
              Buffer.concat([
                Buffer.from([255]),
                code,
                Buffer.from("#HY000" + errorText),
              ]),
            ],
            stage.endsWith("handshake") ? 2 : 1,
          );
        } else callback();
      };
      if (hold === stage || (Array.isArray(hold) && hold.includes(stage)))
        peer.pending.push(release);
      else if (delays[stage]) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          release();
        }, delays[stage]);
        timers.add(timer);
      } else release();
    };
    peer.release = () => peer.pending.splice(0).forEach((release) => release());
    let bytes = Buffer.alloc(0),
      authenticated = false,
      nextStatementId = 1;
    const statements = new Map();
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 4) {
        const size = bytes.readUIntLE(0, 3) + 4;
        if (bytes.length < size) return;
        const body = bytes.subarray(4, size);
        bytes = bytes.subarray(size);
        if (!authenticated) {
          authenticated = true;
          reply(peer.role + "-handshake", () => send([ok()], 2));
          continue;
        }
        const command = body[0];
        if (command === 3) {
          const sql = body.subarray(1).toString();
          const stage = sql.startsWith("SET ")
            ? "setup"
            : sql === "START TRANSACTION"
              ? "start"
              : sql.startsWith("SELECT 1 FROM")
                ? "metadata-lock"
                : sql === "COMMIT"
                  ? "commit"
                  : sql === "ROLLBACK"
                    ? "rollback"
                    : sql.startsWith("KILL QUERY")
                      ? "kill"
                      : "unexpected-query";
          records.push({ role: peer.role, stage, sql });
          reply(stage, () => send([ok()]));
        } else if (command === 22) {
          const sql = body.subarray(1).toString(),
            metadata = sql.startsWith("SELECT ENGINE"),
            statementId = nextStatementId++,
            parameters = sql.split("?").length - 1;
          const stage = metadata ? "metadata-prepare" : "dml-prepare";
          statements.set(statementId, { sql, metadata });
          records.push({ role: peer.role, stage, sql, statementId });
          reply(stage, () => {
            const header = Buffer.alloc(12);
            header.writeUInt32LE(statementId, 1);
            header.writeUInt16LE(metadata ? 2 : 0, 5);
            header.writeUInt16LE(parameters, 7);
            send([
              header,
              ...Array.from({ length: parameters }, () => column("?")),
              ...(parameters ? [eof] : []),
              ...(metadata
                ? [column("ENGINE"), column("TABLE_TYPE"), eof]
                : []),
            ]);
          });
        } else if (command === 23) {
          const statementId = body.readUInt32LE(1),
            statement = statements.get(statementId),
            stage = statement?.metadata ? "metadata-execute" : "dml-execute";
          records.push({
            role: peer.role,
            stage,
            sql: statement?.sql,
            statementId,
            bytes: Buffer.from(body),
          });
          reply(stage, () => {
            if (statement?.metadata)
              send([
                Buffer.from([2]),
                column("ENGINE"),
                column("TABLE_TYPE"),
                eof,
                Buffer.concat([
                  Buffer.from([0, 0]),
                  string(engine),
                  string(tableType),
                ]),
                eof,
              ]);
            else send([ok(count, warning)]);
          });
        } else if (command !== 25 && command !== 1) {
          records.push({ role: peer.role, stage: "unexpected", command });
        }
      }
    });
    socket.write(greeting(peer.id));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    peers,
    clients,
    records,
    input: {
      type: "mysql",
      allowWrite: true,
      host: "127.0.0.1",
      port: server.address().port,
      user: "fictional-user",
      password: "fictional-password-never-store",
      database: "fixture",
      sql: "INSERT INTO entries(id,value) VALUES (?,?)",
      parameters: [1, "fictional-bound-value-never-store"],
    },
    async close() {
      channel("net.client.socket").unsubscribe(observe);
      for (const timer of timers) clearTimeout(timer);
      for (const client of clients) client.socket.destroy();
      for (const peer of peers) peer.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
