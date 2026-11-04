import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";

async function startApp(root) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createApp } from './src/server.mjs';
    const app = await createApp({root:process.env.LOCAL_API_DATA,port:0});
    process.send({url:app.url,token:app.token,pid:process.pid});
    process.on('SIGTERM',()=>{app.server.closeAllConnections();app.server.close(()=>process.exit(0));});
  `,
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, LOCAL_API_DATA: root },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  const ready = await Promise.race([
    once(child, "message").then(([v]) => v),
    once(child, "exit").then(([code]) => {
      throw Error(`app exited ${code}: ${stderr}`);
    }),
  ]);
  return {
    ...ready,
    async stop() {
      const closed = once(child, "exit");
      child.kill();
      await closed;
    },
  };
}
async function cli(root, project, plan) {
  const child = spawn(
    process.execPath,
    ["scripts/run-plan.mjs", "--project", project, "--plan", plan],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, LOCAL_API_DATA: root },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr + stdout);
  return JSON.parse(stdout);
}
async function until(fn) {
  const deadline = Date.now() + 3000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw Error("WS fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test(
  "native WS identity and empty-text intent survive real process restart, frozen CLI execution, evidence and restore",
  { timeout: 30000 },
  async (t) => {
    let connections = 0;
    const frames = [],
      server = http.createServer(),
      wss = new WebSocketServer({ server });
    wss.on("connection", (s) => {
      connections++;
      s.on("error", () => {});
      s.on("message", (b, binary) => {
        frames.push({ text: b.toString(), binary });
        s.send(b.toString());
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const root = await mkdtemp(path.join(tmpdir(), "native-ws-fidelity-")),
      store = new Store(root);
    let app = await startApp(root);
    t.after(async () => {
      await app.stop();
      for (const s of wss.clients) s.terminate();
      await new Promise((r) => wss.close(r));
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const request = async (route, body, method = "POST") => {
      const r = await fetch(app.url + route, {
        method,
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, value: await r.json() };
    };
    const p = await store.create("WS fidelity"),
      other = await store.create("isolated");
    const source = nativeProtocolFixture({
      ws: `ws://127.0.0.1:${server.address().port}/echo?x=one`,
    });
    const a = source.apis[0],
      b = structuredClone(a);
    a.target_id = "a:b";
    a.message[0].param_id = "c";
    b.target_id = "a";
    b.message[0].param_id = "b:c";
    const imp = (id, nodes, src = source) =>
      request(`/api/projects/${id}/import`, {
        document: { ...src, apis: nodes },
      });
    const empty = await store.get(p.id);
    assert.equal((await imp(p.id, [a, b])).status, 400);
    assert.deepEqual(await store.get(p.id), empty);
    assert.equal((await imp(p.id, [a])).status, 200);
    let saved = await store.get(p.id);
    assert.equal(saved.protocols.length, 1);
    assert.equal((await imp(p.id, [a])).status, 200);
    assert.deepEqual((await store.get(p.id)).protocols, saved.protocols);
    assert.deepEqual((await store.get(p.id)).settings, saved.settings);
    saved = await store.get(p.id);
    assert.equal((await imp(p.id, [b])).status, 400);
    assert.deepEqual(await store.get(p.id), saved);
    const oldPid = app.pid;
    await app.stop();
    app = await startApp(root);
    assert.notEqual(app.pid, oldPid);
    assert.equal((await imp(p.id, [b])).status, 400);
    assert.deepEqual(await store.get(p.id), saved);
    const sse = source.apis[3];
    sse.target_id = "a:b:c";
    const collision = await imp(p.id, [sse]);
    assert.equal(collision.status, 400);
    assert.match(collision.value.error, /身份拼接歧义/);
    assert.deepEqual(await store.get(p.id), saved);
    assert.equal((await imp(other.id, [b])).status, 200);
    const otherSource = { ...source, project_id: "separate-source" };
    const otherNode = { ...b, project_id: otherSource.project_id };
    assert.equal((await imp(p.id, [otherNode], otherSource)).status, 200);
    assert.equal((await store.get(p.id)).protocols.length, 2);
    assert.equal(connections, 0);
    const native = structuredClone(a);
    native.target_id = "empty-native";
    native.message[0].request.raw = "";
    assert.equal((await imp(p.id, [native])).status, 200);
    let current = await store.get(p.id),
      def = current.protocols.find((d) => d.message === "");
    assert.equal(def.sendEmptyMessage, true);
    assert.equal(def.templateMode, undefined);
    const post = (body) => request(`/api/projects/${p.id}/protocol`, body);
    for (const value of ["true", 1, null, {}, []]) {
      const denied = await post({
        type: "websocket",
        url: def.url,
        message: "",
        sendEmptyMessage: value,
      });
      assert.equal(denied.status, 400);
    }
    for (const type of ["tcp", "sse"]) {
      const denied = await post({
        type,
        url: type === "tcp" ? "127.0.0.1" : def.url.replace("ws:", "http:"),
        host: "127.0.0.1",
        port: server.address().port,
        sendEmptyMessage: true,
      });
      assert.equal(denied.status, 400);
    }
    assert.equal(
      (
        await post({
          type: "websocket",
          url: def.url,
          message: { encoding: "base64", data: "" },
          sendEmptyMessage: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post({
          type: "websocket",
          url: def.url,
          message: "x".repeat(1048577),
          sendEmptyMessage: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (await post({ definitionId: def.id, sendEmptyMessage: false })).status,
      400,
    );
    assert.equal(connections, 0, "invalid flags must open zero connections");
    for (const message of ["", "nonempty"]) {
      const result = await post({
        definitionId: def.id,
        message,
        maxMessages: 1,
        duration: 500,
      });
      assert.equal(result.status, 200, JSON.stringify(result));
    }
    assert.deepEqual(frames, [
      { text: "", binary: false },
      { text: "nonempty", binary: false },
    ]);
    for (const flag of [undefined, false]) {
      const result = await post({
        type: "websocket",
        url: def.url,
        message: "",
        ...(flag === undefined ? {} : { sendEmptyMessage: flag }),
        duration: 100,
      });
      assert.equal(result.status, 200);
    }
    assert.equal(
      frames.length,
      2,
      "old missing flag and false remain receive-only",
    );
    const live = await request(`/api/projects/${p.id}/protocol-sessions`, {
      type: "websocket",
      url: def.url,
      message: "",
    });
    assert.equal(live.status, 200, JSON.stringify(live));
    await until(
      async () =>
        (
          await request(
            `/api/projects/${p.id}/protocol-sessions/${live.value.id}`,
            undefined,
            "GET",
          )
        ).value.state === "open",
    );
    assert.equal(
      (
        await request(
          `/api/projects/${p.id}/protocol-sessions/${live.value.id}/send`,
          { message: "" },
        )
      ).status,
      200,
    );
    await until(() => frames.length === 3);
    assert.deepEqual(frames.at(-1), { text: "", binary: false });
    await request(
      `/api/projects/${p.id}/protocol-sessions/${live.value.id}/stop`,
      {},
    );
    current = await store.get(p.id);
    const plan = snapshotPlan({
      steps: [
        {
          type: "protocol",
          expectedStatus: "partial",
          protocol: { definition: def, duration: 500, maxMessages: 1 },
        },
      ],
    });
    assert.equal(plan.steps[0].protocol.definition.sendEmptyMessage, true);
    for (const limits of [
      { duration: 99 },
      { duration: 30001 },
      { maxMessages: 0 },
      { maxMessages: 101 },
    ])
      assert.throws(() =>
        snapshotPlan({
          steps: [
            { type: "protocol", protocol: { definition: def, ...limits } },
          ],
        }),
      );
    current.plans.push(plan);
    current.protocols.find((d) => d.id === def.id).message = "live edit";
    delete current.protocols.find((d) => d.id === def.id).sendEmptyMessage;
    await store.save(current);
    const cliResult = await cli(root, p.id, plan.id);
    assert.equal(cliResult.status, "passed");
    assert.deepEqual(frames.at(-1), { text: "", binary: false });
    assert.equal(frames.length, 4);
    const persisted = await store.get(p.id);
    assert.equal(
      persisted.runs.at(-1).results[0].protocol.definition.sendEmptyMessage,
      true,
    );
    assert.equal(
      persisted.protocolRuns.filter(
        (r) => r.definition.sendEmptyMessage === true,
      ).length,
      2,
    );
    const restore = await request("/api/restore", { document: persisted });
    assert.equal(restore.status, 201, JSON.stringify(restore));
    assert.deepEqual(restore.value.runs, persisted.runs);
    assert.deepEqual(restore.value.protocolRuns, persisted.protocolRuns);
    await app.stop();
    app = await startApp(root);
    assert.equal((await cli(root, restore.value.id, plan.id)).status, "passed");
    assert.equal(frames.length, 5);
    assert.deepEqual(frames.at(-1), { text: "", binary: false });
    const legacy = normalizeProtocol({
      type: "websocket",
      url: def.url,
      message: "",
    });
    assert.equal(Object.hasOwn(legacy, "sendEmptyMessage"), false);
  },
);
