import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { importIntoProject } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";

const cases = [
  ["base64", "AP8BgA==", Buffer.from([0, 255, 1, 128])],
  ["hexadecimal", "00ff0180", Buffer.from([0, 255, 1, 128])],
  ["hexadecimal", "00FF0180", Buffer.from([0, 255, 1, 128])],
  ["base64", Buffer.from("雪🙂").toString("base64"), Buffer.from("雪🙂")],
  ["hexadecimal", Buffer.from("雪🙂").toString("hex"), Buffer.from("雪🙂")],
  ["base64", "", Buffer.alloc(0)],
  ["hexadecimal", "", Buffer.alloc(0)],
  ["base64", "AAAA".repeat(16384), Buffer.alloc(49152)],
  ["hexadecimal", "00".repeat(32768), Buffer.alloc(32768)],
];
function fixture(mode, raw, url) {
  const source = nativeProtocolFixture(url ? { ws: url } : {});
  source.apis = [source.apis[0]];
  source.apis[0].message[0].request = { mode, raw };
  return source;
}
const project = () => ({
  requests: [],
  folders: [],
  environments: [],
  servers: [],
  globalVariables: {},
  settings: {},
});
for (const [index, [mode, raw, bytes]] of cases.entries()) {
  test(`native binary model ${index}: ${mode}, ${raw.length} encoded bytes`, () => {
    const source = fixture(mode, raw),
      before = structuredClone(source),
      p = project();
    importIntoProject(p, source);
    assert.deepEqual(source, before);
    assert.equal(p.protocols.length, 1);
    const d = p.protocols[0];
    assert.deepEqual(d.message, {
      encoding: mode === "base64" ? "base64" : "hex",
      data: raw,
    });
    assert.equal(Object.hasOwn(d, "templateMode"), false);
    assert.equal(Object.hasOwn(d, "sendEmptyMessage"), false);
    assert.deepEqual(Buffer.from(d.message.data, d.message.encoding), bytes);
    assert.deepEqual(
      p.settings.apipostProtocolSources[0].source.message,
      before.apis[0].message,
    );
    const saved = structuredClone(p);
    importIntoProject(p, source);
    assert.deepEqual(p, saved);
  });
}
const invalid = [
  ...["binary", "hex", "utf8", "unknown", "BASE64", null, 1].map((mode) => ({
    mode,
    raw: "00",
  })),
  ...[
    "A",
    "AA",
    "AAA",
    "AB==",
    "AP8BgA",
    "AP8BgA===",
    "AP8BgA==\n",
    " AP8BgA==",
    "__8=",
    "{{value}}",
    "{{fn()}}",
    "AAAA".repeat(16385),
  ].map((raw) => ({ mode: "base64", raw })),
  ...[
    "0",
    "0g",
    "0x00",
    "00 ff",
    "00\nff",
    "{{value}}",
    "{{fn()}}",
    "00".repeat(32769),
  ].map((raw) => ({ mode: "hexadecimal", raw })),
  ...[null, 1, false, {}, [], [0, 255]].flatMap((raw) =>
    ["base64", "hexadecimal"].map((mode) => ({ mode, raw })),
  ),
  ...[
    "binary",
    "path",
    "encoding",
    "sendEmptyMessage",
    "templateMode",
    "compress",
    "fin",
    "parameter",
    "pre_tasks",
    "post_tasks",
  ].map((key) => ({
    mode: "base64",
    raw: "AP8BgA==",
    [key]: key === "parameter" ? [] : true,
  })),
  { mode: "base64" },
  { mode: "hexadecimal" },
  JSON.parse('{"mode":"base64","raw":"AA==","__proto__":{"polluted":true}}'),
];
for (const [index, request] of invalid.entries()) {
  test(`native binary rejects ambiguous or malformed request atomically ${index}`, () => {
    const source = nativeProtocolFixture();
    source.apis[0].message.push({
      param_id: "invalid",
      name: "Invalid",
      request,
    });
    const before = structuredClone(source),
      p = project(),
      prior = structuredClone(p);
    assert.throws(() => importIntoProject(p, source));
    assert.deepEqual(p, prior);
    assert.deepEqual(source, before);
    assert.equal({}.polluted, undefined);
  });
}
test("old websocket target never acquires websocket2 binary semantics", () => {
  const source = fixture("base64", "AA=="),
    p = project(),
    before = structuredClone(p);
  source.apis[0].target_type = "websocket";
  assert.throws(() => importIntoProject(p, source));
  assert.deepEqual(p, before);
});

async function until(fn) {
  const deadline = Date.now() + 4000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw Error("fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function integration(t) {
  let connections = 0,
    hold = false;
  const frames = [],
    server = http.createServer(),
    wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    connections++;
    socket.on("error", () => {});
    socket.on("message", (bytes, isBinary) => {
      frames.push({ bytes: Buffer.from(bytes), isBinary });
      if (!hold) socket.send(bytes, { binary: isBinary });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(path.join(tmpdir(), "native-binary-import-"));
  let app = await createApp({ root, port: 0 });
  async function stop() {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  }
  t.after(async () => {
    await stop();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const request = async (route, body, method = "POST", token) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "content-type": "application/json",
        "x-local-token": token ?? app.token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const owner = await app.store.create("binary owner"),
    peer = await app.store.create("untouched peer");
  return {
    root,
    owner,
    peer,
    frames,
    request,
    store: () => new Store(root),
    connections: () => connections,
    hold: (value) => {
      hold = value;
    },
    url: `ws://127.0.0.1:${server.address().port}/echo?x=one`,
    reopen: async () => {
      await stop();
      app = await createApp({ root, port: 0 });
    },
  };
}

test(
  "native binary owner HTTP import, save, reopen, backup, frozen plan and exact byte wire",
  { timeout: 30000 },
  async (t) => {
    const f = await integration(t),
      route = `/api/projects/${f.owner.id}`;
    const source = fixture("base64", "AP8BgA==", f.url);
    source.apis[0].message = cases.map(([mode, raw], i) => ({
      param_id: `m${i}`,
      name: `Message ${i}`,
      request: { mode, raw },
      response: { mode: "text", raw: "" },
    }));
    const sourceBefore = structuredClone(source),
      peerBefore = await f.store().get(f.peer.id);
    const imported = await f.request(route + "/import", { document: source });
    assert.equal(imported.status, 200, JSON.stringify(imported));
    assert.deepEqual(source, sourceBefore);
    assert.equal(f.connections(), 0, "import must not execute transport");
    const saved = await f.store().get(f.owner.id);
    assert.equal(saved.protocols.length, cases.length);
    assert.deepEqual(
      saved.settings.apipostProtocolSources[0].source.message,
      source.apis[0].message,
    );
    assert.equal(saved.protocolRuns.length, 0);
    assert.equal(saved.runs.length, 0);
    assert.equal((await f.request(route, saved, "PUT")).status, 200);
    await f.reopen();
    const reopened = await f.store().get(f.owner.id);
    assert.deepEqual(reopened.protocols, saved.protocols);
    for (const [i, def] of reopened.protocols.entries()) {
      const result = await f.request(route + "/protocol", {
        definitionId: def.id,
        duration: 1000,
        maxMessages: 1,
      });
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.deepEqual(f.frames[i], { bytes: cases[i][2], isBinary: true });
      assert.equal(result.value.messages[0].encoding, "base64");
      assert.equal(
        result.value.messages[0].data,
        cases[i][2].toString("base64"),
      );
    }
    const def = reopened.protocols[0];
    const plan = await f.request(route + "/plans", {
      name: "Frozen binary",
      steps: [
        {
          type: "protocol",
          expectedStatus: "partial",
          protocol: { definition: def, duration: 1000, maxMessages: 1 },
        },
      ],
    });
    assert.equal(plan.status, 200, JSON.stringify(plan));
    const live = await f.store().get(f.owner.id);
    live.protocols[0].message = { encoding: "hex", data: "deadbeef" };
    assert.equal((await f.request(route, live, "PUT")).status, 200);
    const run = await f.request(route + "/run", { planId: plan.value.id });
    assert.equal(run.status, 200, JSON.stringify(run));
    assert.equal(run.value.status, "passed", JSON.stringify(run));
    assert.deepEqual(f.frames.at(-1), { bytes: cases[0][2], isBinary: true });
    const backup = await f.request(route + "/export", undefined, "GET");
    assert.equal(backup.status, 200);
    assert.equal(backup.value.protocolRuns.length, cases.length);
    for (const record of backup.value.protocolRuns) {
      assert.equal(record.result.messages[0].encoding, "base64");
      assert.equal(typeof record.result.messages[0].data, "string");
    }
    const restored = await f.request("/api/restore", {
      document: backup.value,
    });
    assert.equal(restored.status, 201, JSON.stringify(restored));
    assert.notEqual(restored.value.id, f.owner.id);
    assert.deepEqual(restored.value.protocolRuns, backup.value.protocolRuns);
    assert.deepEqual(restored.value.protocols, backup.value.protocols);
    await f.reopen();
    const replay = await f.request(`/api/projects/${restored.value.id}/run`, {
      planId: plan.value.id,
    });
    assert.equal(replay.value.status, "passed", JSON.stringify(replay));
    assert.deepEqual(f.frames.at(-1), { bytes: cases[0][2], isBinary: true });
    assert.deepEqual(await f.store().get(f.peer.id), peerBefore);
  },
);

test(
  "native binary HTTP rejection is atomic; auth, peer, invalid preflight, cancellation and failure remain honest",
  { timeout: 30000 },
  async (t) => {
    const f = await integration(t),
      route = `/api/projects/${f.owner.id}`;
    const valid = fixture("base64", "AP8BgA==", f.url);
    assert.equal(
      (await f.request(route + "/import", { document: valid })).status,
      200,
    );
    const before = await f.store().get(f.owner.id),
      peerBefore = await f.store().get(f.peer.id),
      def = before.protocols[0];
    for (const request of invalid) {
      const source = structuredClone(valid);
      source.apis[0].message.push({
        param_id: "invalid",
        name: "Invalid",
        request,
      });
      const result = await f.request(route + "/import", { document: source });
      assert.equal(result.status, 400, JSON.stringify(request));
      assert.deepEqual(await f.store().get(f.owner.id), before);
    }
    assert.equal(
      (
        await f.request(
          route + "/import",
          { document: valid },
          "POST",
          "wrong-token",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          route + "/protocol",
          { definitionId: def.id },
          "POST",
          "wrong-token",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(`/api/projects/${f.peer.id}/protocol`, {
          definitionId: def.id,
        })
      ).status,
      400,
    );
    for (const bad of [
      { sendEmptyMessage: true },
      { templateMode: "literal" },
      { message: { encoding: "base64", data: "AB==" } },
    ]) {
      assert.equal(
        (await f.request(route + "/protocol", { definitionId: def.id, ...bad }))
          .status,
        400,
      );
    }
    assert.equal(f.connections(), 0);
    assert.deepEqual(await f.store().get(f.owner.id), before);
    assert.deepEqual(await f.store().get(f.peer.id), peerBefore);
    f.hold(true);
    const pending = f.request(route + "/protocol", {
      definitionId: def.id,
      runId: "cancel-native-binary",
      duration: 30000,
    });
    await until(() => f.frames.length === 1);
    await f.request("/api/cancel", { id: "cancel-native-binary" });
    const cancelled = await pending;
    assert.equal(cancelled.value.recordSaved, true, JSON.stringify(cancelled));
    assert.equal(
      (await f.store().get(f.owner.id)).protocolRuns.at(-1).status,
      "cancelled",
    );
    const closed = http.createServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const deadUrl = `ws://127.0.0.1:${closed.address().port}/`;
    await new Promise((r) => closed.close(r));
    const failed = await f.request(route + "/protocol", {
      type: "websocket",
      url: deadUrl,
      message: def.message,
      duration: 1000,
    });
    assert.equal(failed.value.recordSaved, true, JSON.stringify(failed));
    assert.equal(
      (await f.store().get(f.owner.id)).protocolRuns.at(-1).status,
      "failed",
    );
    assert.deepEqual(await f.store().get(f.peer.id), peerBefore);
  },
);
