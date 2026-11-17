// Cross-contract regression: real session grants, owner ledger and native SET
// broker against independent loopback RESP peers. These tests establish local
// close and acknowledgement facts, not Redis durability or server-side rollback.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { channel } from "node:diagnostics_channel";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { createNativeWriteOwner } from "../src/native-write-owner.mjs";
import {
  createNativeWriteExecution,
  assertNativeWritePlan,
  executeNativeWrite,
  finishNativeWrite,
} from "../src/native-write-execution.mjs";
import { parseRESP } from "../src/redis.mjs";

const projectId = "revoked-project";
const peerId = "peer-project";
const bindingId = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
const revoked = { code: "NATIVE_WRITE_REVOKED" };
const denied = { code: "NATIVE_WRITE_DENIED" };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function settle(promise) {
  const state = { done: false };
  state.promise = promise.then(
    (value) => Object.assign(state, { done: true, value }),
    (error) => Object.assign(state, { done: true, error }),
  );
  return state;
}
async function until(predicate, message) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(message);
}
function project(id) {
  return {
    id,
    name: id,
    requests: [
      {
        id: "request",
        name: "Native SET",
        method: "GET",
        url: "http://example.invalid/",
        inheritSharedScripts: false,
        nativeTasks: {
          version: 1,
          before: [
            {
              id: "write-task",
              type: "database",
              enabled: 1,
              data: {
                connectionId: bindingId,
                query: JSON.stringify(["SET", id, "fixture-value"]),
                resultShape: "redis-value",
                writeIntent: "redis-set",
                isConsoleOutput: -1,
                variables: [],
              },
            },
          ],
          after: [],
        },
      },
    ],
    environments: [{ id: "environment", name: "Env", variables: {} }],
    settings: {
      apipostDatabases: [{ id: bindingId, type: "redis", name: "Redis" }],
    },
    globalVariables: {},
    history: [],
    runs: [],
    protocolRuns: [],
    configRevision: 1,
    revision: 1,
  };
}
async function fixture(t, { holdSet = false, afterReceipt } = {}) {
  const sockets = [],
    clients = [],
    commands = [],
    executions = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      for (;;) {
        const parsed = parseRESP(bytes);
        if (!parsed) break;
        bytes = bytes.subarray(parsed.bytes);
        const args = parsed.value.map((value) => value.toString());
        const entry = { args, socket, remotePort: socket.remotePort };
        commands.push(entry);
        if (args[0] === "GET" && args[1].startsWith("held:")) continue;
        if (args[0] === "SET" && holdSet) continue;
        socket.write(args[0] === "GET" ? "$11\r\nfresh-value\r\n" : "+OK\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const listener = ({ socket }) =>
    socket.once("connect", () => {
      if (socket.remotePort !== server.address()?.port) return;
      const record = { socket, localPort: socket.localPort, closed: false };
      clients.push(record);
      socket.once("close", () => {
        record.closed = true;
      });
    });
  channel("net.client.socket").subscribe(listener);
  const projects = new Map([projectId, peerId].map((id) => [id, project(id)]));
  const sessions = new DatabaseSessions({
    resolveProject: async (id) => structuredClone(projects.get(id)),
  });
  const owner = createNativeWriteOwner({
    store: { get: async (id) => structuredClone(projects.get(id)) },
    databaseSessions: sessions,
    async runPrepared(handle, target, context) {
      const capability = createNativeWriteExecution(handle, target, context);
      const operation =
        handle.snapshot.plan.steps[0].request.nativeTasks.before[0].data;
      const execution = {
        capability,
        operation,
        target,
        signal: context.signal,
      };
      executions.push(execution);
      assertNativeWritePlan(capability, handle.snapshot.plan);
      try {
        await executeNativeWrite(capability, operation, "before", 0);
      } catch (error) {
        assert.equal(error.code, "NATIVE_WRITE_STOPPED");
        execution.error = error;
      }
      const writeReceipts = await finishNativeWrite(capability);
      execution.writeReceipts = writeReceipts;
      await afterReceipt?.(execution);
      // No persistence adapter is exercised here. Keep that fact explicit.
      return {
        status: execution.error ? "failed" : "passed",
        recordSaved: false,
        writeReceipts,
      };
    },
  });
  t.after(async () => {
    owner.close();
    sessions.close();
    channel("net.client.socket").unsubscribe(listener);
    for (const { socket } of clients) socket.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const config = {
    name: "Explicit fixture target",
    type: "redis",
    host: "127.0.0.1",
    port: server.address().port,
    database: "2",
    password: "FICTIONAL_SESSION_SECRET",
    bindingId,
  };
  function register(id = projectId) {
    return sessions.register(id, config);
  }
  function prepare(id = projectId) {
    return owner.prepare(id, { requestId: "request" });
  }
  function authorize(prepared, id = projectId) {
    return owner.authorize(id, {
      preparationId: prepared.preparationId,
      digest: prepared.digest,
      phase: prepared.review.phase,
      ordinal: prepared.review.ordinal,
      acknowledgeReplacement: true,
    });
  }
  function execute(prepared, grant, id = projectId) {
    return owner.execute(id, {
      preparationId: prepared.preparationId,
      token: grant.token,
    });
  }
  function query(id = projectId, key = "held:" + id, signal) {
    return sessions.query(
      id,
      {
        connectionId: bindingId,
        sql: JSON.stringify(["GET", key]),
        parameters: [],
      },
      signal,
    );
  }
  function command(name, key) {
    return commands.find(({ args }) => args[0] === name && args[1] === key);
  }
  function clientFor(entry) {
    return clients.find(({ localPort }) => localPort === entry.remotePort);
  }
  return {
    sessions,
    owner,
    commands,
    clients,
    executions,
    register,
    prepare,
    authorize,
    execute,
    query,
    command,
    clientFor,
  };
}
function stop(f, change, registered) {
  if (change === "revoke") f.sessions.revoke(projectId, registered.id);
  else f.sessions.close();
}
async function assertReadRevoked(f, read, entry, caller) {
  await until(
    () => read.done && f.clientFor(entry)?.closed,
    "revocation must settle READ after actual local close, before the 3s driver deadline",
  );
  assert.match(read.error?.message ?? "", /会话连接已撤销/);
  assert.equal(read.value, undefined, "a late READ must not publish a result");
  assert.equal(f.clientFor(entry).socket.destroyed, true);
  assert.equal(
    caller.signal.aborted,
    false,
    "grant revoke is not caller cancellation",
  );
}

for (const change of ["revoke", "close"]) {
  test(
    `${change}: held READ and prepared native writes share the grant lifetime; reissue and peers stay independent`,
    { timeout: 12000 },
    async (t) => {
      const f = await fixture(t);
      // close() intentionally closes every project in its own session owner;
      // only revoke() isolates projects within that same owner.
      const peer = change === "revoke" ? f : await fixture(t);
      const registered = f.register();
      peer.register(peerId);
      const target = await f.sessions.captureNativeRedisTarget(
        projectId,
        bindingId,
      );
      const byId = await f.sessions.captureNativeRedisTarget(
        projectId,
        registered.id,
      );
      const peerTarget = await peer.sessions.captureNativeRedisTarget(
        peerId,
        bindingId,
      );
      assert.equal(target.signal, byId.signal);
      const prepared = await f.prepare();
      const authorized = await f.authorize(prepared);
      const onlyPrepared = await f.prepare();
      const peerPrepared = await peer.prepare(peerId);
      const peerGrant = await peer.authorize(peerPrepared, peerId);
      assert.equal(prepared.review.sessionGeneration, target.sessionGeneration);
      assert.equal(
        f.clients.length,
        0,
        "preparation/authorization do not connect",
      );
      const caller = new AbortController();
      const read = settle(
        f.query(projectId, "held:" + projectId, caller.signal),
      );
      const peerRead = settle(peer.query(peerId));
      await until(
        () =>
          f.command("GET", "held:" + projectId) &&
          peer.command("GET", "held:" + peerId),
        "both READ commands must reach their independent sockets",
      );
      const readCommand = f.command("GET", "held:" + projectId);
      const peerCommand = peer.command("GET", "held:" + peerId);
      assert.throws(() => f.sessions.revoke(peerId, registered.id));
      assert.equal(
        target.signal.aborted,
        false,
        "wrong project must not revoke the grant",
      );
      stop(f, change, registered);
      assert.equal(
        target.signal.aborted,
        true,
        "the captured write target aborts synchronously",
      );
      assert.throws(() => target.assertLive(), revoked);
      await assertReadRevoked(f, read, readCommand, caller);
      assert.equal(
        f.owner.status(projectId, { preparationId: prepared.preparationId })
          .state,
        "revoked",
      );
      assert.equal(
        f.owner.status(projectId, { preparationId: onlyPrepared.preparationId })
          .state,
        "revoked",
      );
      assert.equal(peerRead.done, false);
      assert.equal(peer.clientFor(peerCommand).closed, false);
      assert.equal(peerTarget.signal.aborted, false);
      assert.equal(peerTarget.assertLive(), undefined);

      const replacement = f.register();
      const next = await f.sessions.captureNativeRedisTarget(
        projectId,
        bindingId,
      );
      assert.notEqual(replacement.id, registered.id);
      assert.notEqual(next.sessionGeneration, target.sessionGeneration);
      assert.notEqual(next.signal, target.signal);
      assert.equal(next.signal.aborted, false);
      await assert.rejects(target.revalidate(), revoked);
      await assert.rejects(f.authorize(onlyPrepared), denied);
      await assert.rejects(f.execute(prepared, authorized), denied);
      assert.equal(
        f.executions.length,
        0,
        "old authorization never enters execution",
      );
      assert.equal(
        f.commands.some(({ args }) => args[0] === "SET"),
        false,
      );
      assert.deepEqual((await f.query(projectId, "fresh:" + projectId)).rows, [
        { value: "fresh-value" },
      ]);
      const fresh = await f.prepare();
      assert.equal(fresh.review.sessionGeneration, next.sessionGeneration);
      const freshResult = await f.execute(fresh, await f.authorize(fresh));
      assert.equal(
        freshResult.writeReceipts[0].outcome,
        "acknowledged-applied",
      );
      const peerResult = await peer.execute(peerPrepared, peerGrant, peerId);
      assert.equal(peerResult.writeReceipts[0].outcome, "acknowledged-applied");
      peerCommand.socket.write("$11\r\nfresh-value\r\n");
      await peerRead.promise;
      assert.equal(peerRead.error, undefined);
      assert.deepEqual(peerRead.value.rows, [{ value: "fresh-value" }]);
      await assert.rejects(f.execute(prepared, authorized), denied);
      assert.equal(
        f.commands.filter(
          ({ args }) => args[0] === "SET" && args[1] === projectId,
        ).length,
        1,
      );
      assert.equal(
        f.commands.filter(
          ({ args }) => args[0] === "GET" && args[1] === "held:" + projectId,
        ).length,
        1,
      );
      assert.doesNotMatch(
        JSON.stringify(f.sessions.list(projectId)),
        /FICTIONAL_SESSION_SECRET|controller/,
      );
    },
  );

  for (const response of ["acknowledged-applied", "unknown"]) {
    test(
      `${change}: READ closes while dispatched SET retains ${response} evidence without replay`,
      { timeout: 12000 },
      async (t) => {
        const f = await fixture(t, { holdSet: true });
        const registered = f.register();
        const target = await f.sessions.captureNativeRedisTarget(
          projectId,
          bindingId,
        );
        const prepared = await f.prepare();
        const grant = await f.authorize(prepared);
        const caller = new AbortController();
        const read = settle(
          f.query(projectId, "held:" + projectId, caller.signal),
        );
        await until(
          () => f.command("GET", "held:" + projectId),
          "READ must be held",
        );
        const writing = settle(f.execute(prepared, grant));
        await until(
          () => f.command("SET", projectId),
          "SET must be observed by the peer before revoke",
        );
        const setCommand = f.command("SET", projectId);
        const readCommand = f.command("GET", "held:" + projectId);
        stop(f, change, registered);
        assert.equal(target.signal.aborted, true);
        await assertReadRevoked(f, read, readCommand, caller);
        assert.equal(
          writing.done,
          false,
          "revocation cannot invent a terminal result for an already-sent SET",
        );
        assert.equal(
          f.clientFor(setCommand).closed,
          false,
          "the sent write still owns its ACK/deadline observation",
        );
        assert.equal(f.executions[0].signal.aborted, true);
        if (response === "acknowledged-applied")
          setCommand.socket.write("+OK\r\n");
        else setCommand.socket.end();
        await writing.promise;
        assert.equal(writing.error, undefined);
        const result = writing.value;
        assert.equal(
          result.status,
          "failed",
          "a revoked execution must not continue after SET",
        );
        assert.equal(result.writeReceipts[0].outcome, response);
        assert.equal(f.clientFor(setCommand).closed, true);
        assert.equal(f.clientFor(setCommand).socket.destroyed, true);
        assert.equal(result.writeReceipts[0].projectId, projectId);
        assert.equal(
          result.writeReceipts[0].preparationId,
          prepared.preparationId,
        );
        assert.deepEqual(
          await finishNativeWrite(f.executions[0].capability),
          result.writeReceipts,
        );
        const retained = f.owner.status(projectId, {
          preparationId: prepared.preparationId,
        });
        assert.equal(retained.state, "completed");
        assert.equal(retained.revoked, true);
        assert.deepEqual(retained.writeReceipts, result.writeReceipts);
        f.register();
        await assert.rejects(target.revalidate(), revoked);
        await assert.rejects(f.execute(prepared, grant), denied);
        assert.throws(() =>
          executeNativeWrite(
            f.executions[0].capability,
            f.executions[0].operation,
            "before",
            0,
          ),
        );
        f.owner.revoke(projectId, { preparationId: prepared.preparationId });
        assert.deepEqual(
          f.owner.status(projectId, { preparationId: prepared.preparationId })
            .writeReceipts,
          result.writeReceipts,
        );
        assert.equal(
          f.commands.filter(({ args }) => args[0] === "SET").length,
          1,
        );
        assert.equal(f.clients.length, 2, "no reconnect or implicit replay");
      },
    );
  }

  test(
    `${change}: an already acknowledged SET remains acknowledged while the owner terminal result is pending`,
    { timeout: 12000 },
    async (t) => {
      const receiptReady = deferred();
      const release = deferred();
      t.after(() => release.resolve());
      const f = await fixture(t, {
        afterReceipt: async (execution) => {
          receiptReady.resolve(execution.writeReceipts);
          await release.promise;
        },
      });
      const registered = f.register();
      const prepared = await f.prepare();
      const grant = await f.authorize(prepared);
      const caller = new AbortController();
      const read = settle(
        f.query(projectId, "held:" + projectId, caller.signal),
      );
      await until(
        () => f.command("GET", "held:" + projectId),
        "READ must be held",
      );
      const writing = settle(f.execute(prepared, grant));
      const acknowledged = await receiptReady.promise;
      assert.equal(acknowledged[0].outcome, "acknowledged-applied");
      assert.equal(f.clientFor(f.command("SET", projectId)).closed, true);
      assert.equal(writing.done, false);
      stop(f, change, registered);
      await assertReadRevoked(
        f,
        read,
        f.command("GET", "held:" + projectId),
        caller,
      );
      release.resolve();
      await writing.promise;
      assert.equal(writing.error, undefined);
      assert.deepEqual(writing.value.writeReceipts, acknowledged);
      f.owner.close();
      assert.deepEqual(
        f.owner.status(projectId, { preparationId: prepared.preparationId })
          .writeReceipts,
        acknowledged,
      );
      await assert.rejects(f.execute(prepared, grant), denied);
      assert.equal(
        f.commands.filter(({ args }) => args[0] === "SET").length,
        1,
      );
      assert.equal(f.clients.length, 2);
    },
  );
}
