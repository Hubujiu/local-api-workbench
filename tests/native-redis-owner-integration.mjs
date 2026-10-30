import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { channel } from "node:diagnostics_channel";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { mutateRedis, queryRedis, parseRESP } from "../src/redis.mjs";
import { nativeRedisFixture } from "./fixtures/apipost-redis.mjs";

// Dedicated ordinary-CI Redis service only; never a locally executed provider.
export async function verifyNativeRedisOwnerFlow(config) {
  const key = "localapi:native-owner:" + randomUUID();
  await mutateRedis({
    ...config,
    allowWrite: true,
    command: ["SET", key, "old", "EX", "60"],
  });
  let effects = 0;
  const echo = http.createServer((req, res) => {
    effects++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value: req.headers["x-db-value"] }));
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(
    path.join(os.tmpdir(), "native-redis-owner-real-"),
  );
  let app = await createApp({ root, port: 0 });
  const post = async (projectId, action, data) => {
    const response = await fetch(
      app.url + "/api/projects/" + projectId + "/" + action,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify(data),
      },
    );
    return { status: response.status, data: await response.json() };
  };
  const grant = async (p) =>
    assert.equal(
      (
        await post(p.id, "database-connections", {
          ...config,
          name: "Explicit owner target",
          bindingId: p.settings.apipostDatabases[0].id,
        })
      ).status,
      200,
    );
  const prepare = async (p) => {
    const result = await post(p.id, "native-write/prepare", {
      requestId: p.requests[0].id,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.data;
  };
  const authorize = async (p, prepared) => {
    const result = await post(p.id, "native-write/authorize", {
      preparationId: prepared.preparationId,
      digest: prepared.digest,
      phase: prepared.review.phase,
      ordinal: prepared.review.ordinal,
      acknowledgeReplacement: true,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.data;
  };
  try {
    const p = await app.store.create("Native owner SET real Redis");
    importIntoProject(
      p,
      nativeRedisFixture(`http://127.0.0.1:${echo.address().port}/`, {
        method: "set",
        query: JSON.stringify({ key, value: "new" }),
      }),
    );
    await app.store.save(p);
    await grant(p);
    assert.equal(
      (await post(p.id, "execute", { request: p.requests[0] })).status,
      400,
    );
    assert.equal(effects, 0);
    const prepared = await prepare(p),
      authorization = await authorize(p, prepared);
    assert.equal(
      (await queryRedis({ ...config, command: ["GET", key] })).rows[0].value,
      "old",
    );
    assert.equal(effects, 0);
    const executed = await post(p.id, "native-write/execute", {
      preparationId: authorization.preparationId,
      token: authorization.token,
    });
    assert.equal(executed.status, 200, JSON.stringify(executed));
    assert.equal(executed.data.status, "passed", JSON.stringify(executed.data));
    assert.equal(
      executed.data.writeReceipts[0].outcome,
      "acknowledged-applied",
    );
    assert.equal(executed.data.recordSaved, true);
    assert.equal(effects, 1);
    assert.equal(
      (await queryRedis({ ...config, command: ["GET", key] })).rows[0].value,
      "new",
    );
    assert.equal(
      (await queryRedis({ ...config, command: ["TTL", key] })).rows[0].value,
      -1,
    );
    assert.equal(
      (
        await post(p.id, "native-write/execute", {
          preparationId: authorization.preparationId,
          token: authorization.token,
        })
      ).status,
      400,
    );
    assert.equal(effects, 1);
    const status = await post(p.id, "native-write/status", {
      preparationId: prepared.preparationId,
    });
    assert.deepEqual(status.data.writeReceipts, executed.data.writeReceipts);
    const saved = await app.store.get(p.id);
    assert.deepEqual(
      saved.history.at(-1).writeReceipts,
      executed.data.writeReceipts,
    );
    const restored = restoreProject(saved);
    await app.store.save(restored);
    assert.equal(
      (
        await post(restored.id, "native-write/execute", {
          preparationId: authorization.preparationId,
          token: authorization.token,
        })
      ).status,
      400,
    );
    assert.equal(
      (await post(restored.id, "execute", { request: restored.requests[0] }))
        .status,
      400,
    );
    assert.equal(effects, 1);
    await new Promise((resolve) => {
      app.server.closeAllConnections();
      app.server.close(resolve);
    });
    app = await createApp({ root, port: 0 });
    assert.equal(
      (
        await post(p.id, "native-write/execute", {
          preparationId: authorization.preparationId,
          token: authorization.token,
        })
      ).status,
      400,
    );
    assert.equal(effects, 1);
    console.log(
      "REAL_REDIS_NATIVE_OWNER_SET_ACK_TTL_HISTORY_RESTORE_RESTART_NO_REPLAY_PASS",
    );
    for (const mode of ["drop", "delay"]) {
      await verifyNativeOwnerReplyFault({
        app,
        config,
        post,
        prepare,
        authorize,
        echo,
        effects: () => effects,
        mode,
      });
    }
  } finally {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    echo.closeAllConnections();
    await new Promise((resolve) => echo.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

// Proxy only the real service's reply, never fabricate a successful mutation.
// A per-scenario project and explicit binding prevent cross-target reuse.
async function verifyNativeOwnerReplyFault({
  app,
  config,
  post,
  prepare,
  authorize,
  echo,
  effects,
  mode,
}) {
  assert.equal(String(config.database), "0");
  assert.ok(!config.user && !config.password && !config.ssl);
  const key = "localapi:native-owner:" + mode + ":" + randomUUID();
  const value = "applied-before-" + mode + "-ack";
  const sockets = new Set(),
    closes = [],
    timers = new Set(),
    clients = [];
  let connections = 0,
    commands = 0,
    acknowledged = false,
    forwardedAck = false,
    fault;
  const proxy = net.createServer({ allowHalfOpen: true }, (downstream) => {
    connections++;
    const upstream = net.connect({
      host: config.host,
      port: Number(config.port),
    });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      closes.push(
        new Promise((resolve) =>
          socket.once("close", () => {
            sockets.delete(socket);
            resolve();
          }),
        ),
      );
      socket.on("error", () => {});
    }
    const stop = () => {
      downstream.destroy();
      upstream.destroy();
    };
    downstream.once("end", stop);
    downstream.once("close", () => upstream.destroy());
    upstream.once("error", stop);
    let input = Buffer.alloc(0),
      reply = Buffer.alloc(0);
    downstream.on("data", (bytes) => {
      try {
        input = Buffer.concat([input, bytes]);
        let frame;
        while ((frame = parseRESP(input))) {
          commands++;
          assert.deepEqual(
            frame.value.map((x) => x.toString()),
            ["SET", key, value],
          );
          input = input.subarray(frame.bytes);
        }
        upstream.write(bytes);
      } catch (error) {
        fault = error;
        stop();
      }
    });
    upstream.on("data", (bytes) => {
      try {
        reply = Buffer.concat([reply, bytes]);
        const frame = parseRESP(reply);
        if (!frame) return;
        assert.equal(frame.bytes, reply.length);
        assert.equal(frame.value, "OK");
        assert.equal(acknowledged, false, "one real provider ACK only");
        acknowledged = true;
        if (mode === "delay") {
          // This is a reply fault duration, not a changed script/Redis budget.
          // 2300ms exceeds the existing 2s phase deadline but not the 3s wire
          // deadline. The stopped phase must not discard this eventual ACK.
          const packet = Buffer.from(reply);
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!downstream.destroyed) {
              forwardedAck = true;
              downstream.write(packet);
            }
          }, 2300);
          timers.add(timer);
        }
      } catch (error) {
        fault = error;
        stop();
      }
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = proxy.address().port;
  const observer = ({ socket }) =>
    socket.once("connect", () => {
      if (socket.remotePort !== port) return;
      const record = { socket, closed: false };
      clients.push(record);
      socket.once("close", () => {
        record.closed = true;
      });
    });
  channel("net.client.socket").subscribe(observer);
  try {
    const p = await app.store.create(
      "Native owner real Redis " + mode + " ACK",
    );
    importIntoProject(
      p,
      nativeRedisFixture(
        `http://127.0.0.1:${echo.address().port}/must-not-follow-set`,
        { method: "set", query: JSON.stringify({ key, value }) },
      ),
    );
    await app.store.save(p);
    const registered = await post(p.id, "database-connections", {
      ...config,
      host: "127.0.0.1",
      port,
      name: "Explicit " + mode + " ACK target",
      bindingId: p.settings.apipostDatabases[0].id,
    });
    assert.equal(registered.status, 200, JSON.stringify(registered));
    const beforeEffects = effects();
    const prepared = await prepare(p),
      authorization = await authorize(p, prepared);
    assert.equal(
      connections,
      0,
      "prepare and authorize never connect to provider",
    );
    const executed = await post(p.id, "native-write/execute", {
      preparationId: authorization.preparationId,
      token: authorization.token,
    });
    assert.equal(executed.status, 200, JSON.stringify(executed));
    assert.notEqual(
      executed.data.status,
      "passed",
      "expired script phase must not resume",
    );
    assert.equal(
      executed.data.writeReceipts[0].outcome,
      mode === "drop" ? "unknown" : "acknowledged-applied",
    );
    assert.equal(executed.data.recordSaved, true);
    assert.equal(
      effects(),
      beforeEffects,
      "no HTTP effect after the 2s phase deadline",
    );
    assert.equal(
      acknowledged,
      true,
      "real Redis applied SET and its ACK reached proxy",
    );
    assert.equal(forwardedAck, mode === "delay");
    assert.equal(connections, 1, "no reconnect");
    assert.equal(commands, 1, "no repeat or replay");
    assert.ifError(fault);
    assert.equal(clients.length, 1);
    assert.ok(
      clients.every((x) => x.closed && x.socket.destroyed),
      "owner receipt settlement follows actual local client close",
    );
    assert.equal(
      (await queryRedis({ ...config, command: ["GET", key] })).rows[0].value,
      value,
      "readback independently proves applied mutation without replay",
    );
    const status = await post(p.id, "native-write/status", {
      preparationId: prepared.preparationId,
    });
    assert.deepEqual(status.data.writeReceipts, executed.data.writeReceipts);
    assert.deepEqual(
      (await app.store.get(p.id)).history.at(-1).writeReceipts,
      executed.data.writeReceipts,
    );
    assert.equal(
      (
        await post(p.id, "native-write/execute", {
          preparationId: authorization.preparationId,
          token: authorization.token,
        })
      ).status,
      400,
    );
    assert.equal(connections, 1);
    assert.equal(commands, 1);
    assert.equal(effects(), beforeEffects);
    console.log(
      mode === "drop"
        ? "REAL_REDIS_NATIVE_OWNER_ACK_LOSS_UNKNOWN_APPLIED_NO_REPLAY_LOCAL_CLOSE_PASS"
        : "REAL_REDIS_NATIVE_OWNER_LATE_ACK_AFTER_PHASE_TIMEOUT_RETAINED_NO_HTTP_LOCAL_CLOSE_PASS",
    );
  } finally {
    channel("net.client.socket").unsubscribe(observer);
    for (const timer of timers) clearTimeout(timer);
    const stopped = new Promise((resolve) => proxy.close(resolve));
    for (const socket of sockets) socket.destroy();
    await Promise.all(closes);
    await stopped;
  }
}
