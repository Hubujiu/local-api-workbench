import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Server } from "socket.io";
import { reflectGrpc } from "../src/grpc-reflection.mjs";
import { SocketIOSessions } from "../src/socketio.mjs";

// Serial file, isolated by Node's test runner. All civil-clock patches are
// restored even on rejection; there are no production clock/budget overrides.
async function withCivilClock(run) {
  const original = Date.now;
  let offset = 0;
  Date.now = () => original() + offset;
  try {
    return await run((value) => {
      offset = value;
    });
  } finally {
    Date.now = original;
  }
}
async function boundedReply(reply) {
  let timer;
  try {
    return await Promise.race([
      reply,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("fixture acknowledgment timeout")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const wait = async (read) => {
  const end = performance.now() + 5000;
  while (performance.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("protocol clock fixture condition timeout");
};

test("reflection keeps aggregate allowance across civil jumps during version negotiation", async () => {
  const original = Date.now;
  for (const offset of [60000, -60000]) {
    await withCivilClock(async (jump) => {
      const server = new grpc.Server();
      let v1 = 0,
        alpha = 0;
      for (const version of ["v1", "v1alpha"]) {
        const pkg = grpc.loadPackageDefinition(
          loader.loadSync(
            fileURLToPath(
              new URL(
                `../src/vendor/grpc-reflection-${version}.proto`,
                import.meta.url,
              ),
            ),
          ),
        );
        server.addService(
          pkg.grpc.reflection[version].ServerReflection.service,
          {
            ServerReflectionInfo(call) {
              call.on("data", (request) => {
                if (version === "v1") {
                  v1++;
                  jump(offset);
                  call.emit("error", {
                    code: grpc.status.UNIMPLEMENTED,
                    details: "alpha only",
                  });
                } else {
                  alpha++;
                  call.write({
                    originalRequest: request,
                    listServicesResponse: {
                      service: [{ name: "fixture.Echo" }],
                    },
                  });
                  call.end();
                }
              });
            },
          },
        );
      }
      try {
        const port = await new Promise((resolve, reject) =>
          server.bindAsync(
            "127.0.0.1:0",
            grpc.ServerCredentials.createInsecure(),
            (error, port) => (error ? reject(error) : resolve(port)),
          ),
        );
        const result = await reflectGrpc({
          target: `grpc://127.0.0.1:${port}`,
          timeoutMs: 5000,
        });
        assert.equal(result.status.code, 0, JSON.stringify(result));
        assert.equal(result.version, "v1alpha");
        assert.equal(result.queries, 2);
        assert.deepEqual(result.services, [{ name: "fixture.Echo" }]);
        assert.equal(v1, 1);
        assert.equal(alpha, 1);
        assert(
          Number.isSafeInteger(result.durationMs) && result.durationMs >= 0,
        );
      } finally {
        server.forceShutdown();
      }
    });
    assert.equal(Date.now, original);
  }
});

test("Socket.IO ack eligibility and cleanup follow the real thirty-second window", async () => {
  const original = Date.now;
  await withCivilClock(async (jump) => {
    const server = http.createServer(),
      io = new Server(server),
      sessions = new SocketIOSessions();
    let peer;
    io.on("connection", (socket) => {
      peer = socket;
    });
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const session = sessions.start("p", {
        url: `http://127.0.0.1:${server.address().port}`,
      });
      const snapshot = () => sessions.snapshot("p", session.id);
      await wait(() => peer && snapshot().state === "open");
      const answered = new Promise((resolve) =>
        peer.emit("forward", "question", resolve),
      );
      const first = await wait(() =>
        snapshot().events.find((event) => event.event === "forward"),
      );
      jump(60000);
      sessions.acknowledge("p", session.id, {
        ackId: first.ackId,
        args: ["answer"],
      });
      assert.equal(await boundedReply(answered), "answer");
      assert.throws(
        () =>
          sessions.acknowledge("p", session.id, {
            ackId: first.ackId,
            args: [],
          }),
        /不存在|过期/,
      );
      jump(0);
      let staleReplies = 0;
      for (let i = 0; i < 100; i++)
        peer.emit("stale", i, () => {
          staleReplies++;
        });
      const stale = await wait(() => {
        const entries = snapshot().events.filter(
          (event) => event.event === "stale",
        );
        return entries.length === 100 && entries;
      });
      jump(-60000);
      const waitingSince = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 30050));
      assert(performance.now() - waitingSince >= 30000);
      assert.equal(snapshot().state, "open");
      assert.throws(
        () =>
          sessions.acknowledge("p", session.id, {
            ackId: stale[0].ackId,
            args: [],
          }),
        /不存在|过期/,
      );
      const freshAnswer = new Promise((resolve) =>
        peer.emit("fresh", "question", resolve),
      );
      const fresh = await wait(() =>
        snapshot().events.find((event) => event.event === "fresh"),
      );
      assert.equal(
        snapshot().state,
        "open",
        "expired entries must be pruned before the 100-entry cap",
      );
      sessions.acknowledge("p", session.id, {
        ackId: fresh.ackId,
        args: ["fresh answer"],
      });
      assert.equal(await boundedReply(freshAnswer), "fresh answer");
      assert.equal(staleReplies, 0);
    } finally {
      sessions.close();
      await new Promise((resolve) => io.close(resolve));
    }
  });
  assert.equal(Date.now, original);
});
