import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { createApp } from "../src/server.mjs";
import { createProtocolSessionController } from "../public/protocol-session-controller.js";
const source = (
  await readFile(new URL("../public/app.js", import.meta.url), "utf8")
).replaceAll("\r\n", "\n");
const handlers = source.slice(
  source.indexOf('  on("#session-connect"'),
  source.indexOf('  on("#protocol-run"'),
);
const instance = "11111111-1111-4111-8111-111111111111",
  intent = "22222222-2222-4222-8222-222222222222",
  sid = "33333333-3333-4333-8333-333333333333";
const snapshot = (state = "open") => ({
  id: sid,
  type: "tcp",
  state,
  events: [],
});
const receipt = (state = "open", phase = "started") => ({
  instanceId: instance,
  intentId: intent,
  phase,
  sessionId: sid,
  session: snapshot(state),
  retry_safe: false,
});
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
function storage() {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    data,
  };
}
function harness(api, { store = storage(), instanceId = instance } = {}) {
  const callbacks = {},
    timers = [];
  let next = 0;
  const controller = createProtocolSessionController({
    api,
    storage: store,
    instanceId,
    generateId: () => intent,
    schedule: (fn) => {
      timers.push({ fn, id: ++next });
      return next;
    },
    cancel: (id) => {
      const index = timers.findIndex((t) => t.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const env = {
    sessionController: controller,
    on: (selector, event, fn) => (callbacks[selector] = fn),
    $: () => ({ value: "127.0.0.1" }),
    download() {},
    activeSession: null,
  };
  new Function("env", `with(env){${handlers}}`)(env);
  env.$ = (selector) => ({
    value:
      selector === "#protocol-type"
        ? "tcp"
        : selector === "#protocol-port"
          ? "1234"
          : "127.0.0.1",
  });
  return { controller, callbacks, timers, store, env };
}
const definition = { type: "tcp", host: "127.0.0.1", port: 1234 };
test("actual pending connect rejects second click before a second POST", async () => {
  const wait = deferred();
  let posts = 0;
  const h = harness(async () => {
    posts++;
    return wait.promise;
  });
  const first = h.callbacks["#session-connect"]();
  await assert.rejects(() => h.callbacks["#session-connect"](), /尚未结束/);
  assert.equal(posts, 1);
  wait.resolve(receipt());
  await first;
});
test("old poll cannot resurrect stopped session or schedule a timer", async () => {
  const wait = deferred();
  const h = harness(async (path, method) =>
    method === "GET" || !method
      ? wait.promise
      : path.endsWith("/stop")
        ? receipt("closed", "cancelled")
        : receipt(),
  );
  await h.controller.connect(definition);
  const polling = h.controller.poll();
  await h.callbacks["#session-stop"]();
  wait.resolve(receipt());
  await polling;
  assert.equal(h.controller.status().snapshot.state, "closed");
  assert.equal(h.timers.length, 0);
});
test("stop during held connect claims cancellation; late start is ignored", async () => {
  const wait = deferred();
  let stops = 0;
  const h = harness(async (path) => {
    if (path.endsWith("/stop")) {
      stops++;
      return {
        ...receipt("closed", "cancelled"),
        sessionId: null,
        session: null,
      };
    }
    return wait.promise;
  });
  const start = h.controller.connect(definition);
  await h.controller.stop();
  wait.resolve(receipt());
  await start;
  assert.equal(stops, 1);
  assert.equal(h.controller.status().phase, "closed");
  assert.equal(h.controller.status().snapshot, null);
  assert.equal(h.timers.length, 0);
});
test("send is single-flight and stop defeats late send response without clearing message input", async () => {
  const wait = deferred();
  let sends = 0;
  const h = harness(async (path) => {
    if (path.endsWith("/send")) {
      sends++;
      return wait.promise;
    }
    return path.endsWith("/stop") ? receipt("closed", "cancelled") : receipt();
  });
  await h.controller.connect(definition);
  const sending = h.controller.send("one");
  await assert.rejects(() => h.controller.send("two"));
  await h.controller.stop();
  wait.resolve(snapshot());
  await sending;
  assert.equal(sends, 1);
  assert.equal(h.controller.status().phase, "closed");
  assert.equal(h.timers.length, 0);
});
test("unknown send survives read reconciliation and reload without replay", async () => {
  let sends = 0;
  const store = storage();
  const api = async (path) => {
    if (path.endsWith("/send")) {
      sends++;
      throw Error("lost ack");
    }
    return receipt();
  };
  const h = harness(api, { store });
  await h.controller.connect(definition);
  await assert.rejects(() => h.controller.send("one"), /未确认/);
  await h.controller.poll();
  assert.equal(h.controller.status().canSend, false);
  const restored = harness(api, { store });
  await restored.controller.restore();
  assert.equal(restored.controller.status().canSend, false);
  assert.equal(sends, 1);
});
test("unknown start reload recovers by GET only and never restarts", async () => {
  let starts = 0;
  const store = storage();
  const h = harness(
    async () => {
      starts++;
      throw Error("lost");
    },
    { store },
  );
  await assert.rejects(() => h.controller.connect(definition));
  let reads = 0;
  const resumed = harness(
    async (path, method) => {
      assert.equal(method, undefined);
      reads++;
      return receipt();
    },
    { store },
  );
  await resumed.controller.restore();
  assert.equal(starts, 1);
  assert.equal(reads, 1);
  assert.equal(resumed.controller.status().snapshot.id, sid);
});
test("unknown stop cannot be cleared by stale open read; explicit stop remains available", async () => {
  let stopCalls = 0;
  const h = harness(async (path) => {
    if (path.endsWith("/stop")) {
      stopCalls++;
      if (stopCalls === 1) throw Error("lost stop");
      return receipt("closed", "cancelled");
    }
    return receipt();
  });
  await h.controller.connect(definition);
  await assert.rejects(() => h.controller.stop());
  await h.controller.poll();
  assert.equal(h.controller.status().canConnect, false);
  assert.equal(h.controller.status().canSend, false);
  await h.controller.stop();
  assert.equal(h.controller.status().phase, "closed");
});
test("storage write failure prevents connecting or sending external effects", async () => {
  let calls = 0;
  const store = storage();
  store.setItem = () => {
    throw Error("disk");
  };
  const h = harness(
    async () => {
      calls++;
      return receipt();
    },
    { store },
  );
  await assert.rejects(() => h.controller.connect(definition));
  assert.equal(calls, 0);
});
test("malformed storage fails closed; instance change never replays old intent", async () => {
  for (const raw of [
    "broken",
    JSON.stringify({
      version: 1,
      phase: "sending",
      instanceId: instance,
      intentId: intent,
      type: "ftp",
      sessionId: sid,
    }),
  ]) {
    const store = storage();
    store.setItem("local-api-protocol-intent-v1", raw);
    const h = harness(
      async () => {
        throw Error("must not call");
      },
      { store },
    );
    await h.controller.restore();
    assert.equal(h.controller.status().canConnect, false);
  }
  const store = storage();
  store.setItem(
    "local-api-protocol-intent-v1",
    JSON.stringify({
      version: 1,
      phase: "uncertain-send",
      instanceId: instance,
      intentId: intent,
      type: "tcp",
      sessionId: sid,
    }),
  );
  let calls = 0;
  const h = harness(
    async () => {
      calls++;
    },
    { store, instanceId: "44444444-4444-4444-8444-444444444444" },
  );
  await h.controller.restore();
  assert.equal(calls, 0);
  assert.match(h.controller.status().warning, /远端结果仍未确认/);
});
test("wrong identity and incomplete successful receipt preserve unknown state", async () => {
  for (const bad of [
    { ...receipt(), sessionId: "44444444-4444-4444-8444-444444444444" },
    { ...receipt(), session: null },
    { ...receipt(), instanceId: "wrong" },
  ]) {
    const h = harness(async () => bad);
    await assert.rejects(() => h.controller.connect(definition));
    assert.equal(h.controller.status().canConnect, false);
    assert.equal(h.controller.status().phase, "uncertain-start");
  }
});
test(
  "held real HTTP connect responses create only one TCP connection",
  { timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(tmpdir() + "/session-ui-");
    const sockets = new Set();
    let connections = 0;
    const tcp = net.createServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      await app.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => tcp.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const call = async (path, method = "GET", body) => {
      const response = await fetch(app.url + "/api" + path, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    const session = await call("/session"),
      ready = deferred(),
      release = deferred();
    let posts = 0;
    const h = harness(
      async (path, method, body) => {
        const value = await call(path, method, body);
        if (method === "POST") {
          posts++;
          ready.resolve();
          await release.promise;
        }
        return value;
      },
      { instanceId: session.instanceId },
    );
    h.env.$ = (selector) => ({
      value:
        selector === "#protocol-type"
          ? "tcp"
          : selector === "#protocol-port"
            ? String(tcp.address().port)
            : "127.0.0.1",
    });
    const first = h.callbacks["#session-connect"]();
    await assert.rejects(() => h.callbacks["#session-connect"]());
    await ready.promise;
    release.resolve();
    await first;
    for (
      let i = 0;
      i < 50 && h.controller.status().snapshot.state !== "open";
      i++
    ) {
      await h.controller.poll();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(h.controller.status().snapshot.state, "open");
    assert.equal(posts, 1);
    assert.equal(connections, 1);
  },
);

test("successful start with failed receipt persistence retains known ID for cleanup and reload intent", async () => {
  const store = storage();
  const write = store.setItem;
  let writes = 0;
  store.setItem = (k, v) => {
    if (++writes > 1) throw Error("quota");
    write(k, v);
  };
  const h = harness(
    async (path) =>
      path.endsWith("/stop") ? receipt("closed", "cancelled") : receipt(),
    { store },
  );
  await assert.rejects(() => h.controller.connect(definition));
  assert.equal(h.controller.status().snapshot.id, sid);
  assert.equal(h.controller.status().canConnect, false);
  assert.equal(
    JSON.parse(store.getItem("local-api-protocol-intent-v1")).phase,
    "starting",
  );
  store.setItem = write;
  const restored = harness(async () => receipt(), { store });
  await restored.controller.restore();
  assert.equal(restored.controller.status().snapshot.id, sid);
  await h.controller.stop();
  assert.equal(h.controller.status().phase, "closed");
});
test("unknown delivery warning survives terminal cleanup and same-tab reload", async () => {
  const store = storage();
  const api = async (path) => {
    if (path.endsWith("/send")) throw Error("lost send");
    return path.endsWith("/stop") ? receipt("closed", "cancelled") : receipt();
  };
  const h = harness(api, { store });
  await h.controller.connect(definition);
  await assert.rejects(() => h.controller.send("not replayed"));
  await h.controller.stop();
  assert.match(h.controller.status().warning, /远端结果仍未确认/);
  const resumed = harness(api, { store });
  await resumed.controller.restore();
  assert.match(resumed.controller.status().warning, /远端结果仍未确认/);
  assert.equal(resumed.controller.status().phase, "closed");
});
test("cancelled receipt with live transport and malformed events cannot falsely unlock connect", async () => {
  for (const value of [
    receipt("open", "cancelled"),
    { ...receipt(), session: { ...snapshot(), events: [null] } },
  ]) {
    const h = harness(async () => value);
    await assert.rejects(() => h.controller.connect(definition));
    assert.equal(h.controller.status().canConnect, false);
  }
});
test("late old poll does not block polling of a newer generation", async () => {
  const wait = deferred();
  let reads = 0;
  const h = harness(async (path, method) => {
    if (!method) {
      reads++;
      if (reads === 1) return wait.promise;
      return receipt();
    }
    if (path.endsWith("/send")) return snapshot();
    return receipt();
  });
  await h.controller.connect(definition);
  const old = h.controller.poll();
  await h.controller.send("one");
  await h.controller.poll();
  assert.equal(reads, 2);
  wait.resolve(receipt());
  await old;
  assert.equal(h.controller.status().phase, "active");
});

test(
  "real TCP send held receipt remains uncertain after stop, late receipt and reload",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(tmpdir() + "/protocol-send-held-");
    const received = deferred(),
      release = deferred(),
      ready = deferred();
    const sockets = new Set();
    let bytes = "";
    const tcp = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", (data) => {
        bytes += data.toString();
        received.resolve();
      });
    });
    await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      release.resolve();
      await app.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => tcp.close(r));
      await rm(root, { recursive: true, force: true });
    });
    let sendPosts = 0;
    const api = async (path, method = "GET", body) => {
      const response = await fetch(app.url + "/api" + path, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      if (path.endsWith("/send")) {
        sendPosts++;
        ready.resolve();
        await release.promise;
      }
      return value;
    };
    const { instanceId } = await api("/session");
    const store = storage();
    const h = harness(api, { instanceId, store });
    await h.controller.connect({
      type: "tcp",
      host: "127.0.0.1",
      port: tcp.address().port,
    });
    for (let i = 0; i < 50 && !h.controller.status().canSend; i++) {
      await h.controller.poll();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(h.controller.status().canSend, true);
    const sending = h.controller.send("SIDE EFFECT");
    await Promise.all([ready.promise, received.promise]);
    await h.controller.stop();
    assert.equal(h.controller.status().phase, "closed");
    assert.match(h.controller.status().warning, /远端结果仍未确认/);
    release.resolve();
    await sending;
    const resumed = harness(api, { instanceId, store });
    await resumed.controller.restore();
    assert.equal(resumed.controller.status().phase, "closed");
    assert.match(resumed.controller.status().warning, /远端结果仍未确认/);
    assert.equal(sendPosts, 1);
    assert.equal(bytes, "SIDE EFFECT");
  },
);

test("unknown start can export recovery evidence and existing snapshot fields remain unchanged", async () => {
  const h = harness(async () => {
    throw Error("lost response");
  });
  await assert.rejects(() => h.controller.connect(definition));
  let exported;
  h.env.download = (name, value) => {
    exported = value;
  };
  h.callbacks["#session-export"]();
  assert.equal(exported.connectionRecovery.phase, "uncertain-start");
  assert.equal(exported.connectionRecovery.intentId, intent);
  assert.equal(JSON.stringify(exported).includes("127.0.0.1"), false);
  const known = harness(async () => receipt());
  await known.controller.connect(definition);
  const { connectionRecovery, ...original } = known.controller.evidence();
  assert.deepEqual(original, snapshot());
  assert.equal(connectionRecovery.phase, "active");
});

for (const failure of ["throw", "callback", "late-callback"])
  test(
    `real manager ${failure} write failure with HTTP 200 preserves unknown delivery`,
    { timeout: 15000 },
    async (t) => {
      const { ProtocolSessions } = await import("../src/protocol-sessions.mjs");
      let completeLater;
      const original = ProtocolSessions.prototype.send;
      t.mock.method(ProtocolSessions.prototype, "send", function (id, message) {
        const session = this.get(id);
        session.socket.write = (_data, complete) => {
          if (failure === "throw") throw Error("fixture transport throw");
          if (failure === "late-callback") {
            completeLater = complete;
            return true;
          }
          complete(Error("fixture write callback failure"));
        };
        return original.call(this, id, message);
      });
      const root = await mkdtemp(tmpdir() + "/protocol-send-failure-");
      const sockets = new Set();
      const tcp = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
      const app = await createApp({ root, port: 0 });
      t.after(async () => {
        await app.close();
        for (const s of sockets) s.destroy();
        await new Promise((r) => tcp.close(r));
        await rm(root, { recursive: true, force: true });
      });
      let sends = 0;
      const api = async (path, method = "GET", body) => {
        const response = await fetch(app.url + "/api" + path, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const value = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        if (path.endsWith("/send")) {
          sends++;
          assert.equal(
            value.state,
            failure === "late-callback" ? "open" : "error",
          );
        }
        return value;
      };
      const { instanceId } = await api("/session"),
        store = storage();
      const h = harness(api, { instanceId, store });
      await h.controller.connect({
        type: "tcp",
        host: "127.0.0.1",
        port: tcp.address().port,
      });
      for (let i = 0; i < 50 && !h.controller.status().canSend; i++) {
        await h.controller.poll();
        await new Promise((r) => setTimeout(r, 10));
      }
      await h.controller.send("NOT RETRIED");
      if (completeLater) {
        completeLater(Error("late write failure"));
        await h.controller.poll();
      }
      assert.equal(h.controller.status().phase, "closed");
      assert.equal(h.controller.status().uncertainDelivery, true);
      assert.match(h.controller.status().warning, /远端结果仍未确认/);
      const resumed = harness(api, { instanceId, store });
      await resumed.controller.restore();
      assert.match(resumed.controller.status().warning, /远端结果仍未确认/);
      assert.equal(sends, 1);
    },
  );
