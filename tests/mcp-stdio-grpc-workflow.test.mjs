import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/runtime.mjs";

const protoFile = new URL("./fixtures/grpc.proto", import.meta.url);
const proto = await readFile(protoFile, "utf8");
const main = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function until(check) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw Error("stdio gRPC observation timed out");
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "stdio-grpc-sdk-"));
  const store = new Store(root);
  await store.init();
  let unaryCalls = 0;
  const calls = [],
    clients = [],
    peer = new grpc.Server();
  peer.addService(
    grpc.loadPackageDefinition(
      loader.loadSync(fileURLToPath(protoFile), {
        keepCase: true,
        longs: String,
        bytes: String,
        enums: String,
        defaults: true,
      }),
    ).fixture.Echo.service,
    {
      Unary(call, callback) {
        unaryCalls++;
        callback(null, call.request);
      },
      Chat(call) {
        const entry = {
          nonce: randomUUID(),
          messages: [],
          ended: false,
          cancelled: false,
        };
        calls.push(entry);
        call.on("error", () => {});
        call.on("cancelled", () => (entry.cancelled = true));
        call.on("data", (message) => {
          entry.messages.push(message);
          call.write({
            text:
              message.text === "answer:" + entry.nonce
                ? "accepted:" + entry.nonce
                : "echo:" + message.text,
          });
        });
        call.on("end", () => {
          entry.ended = true;
          call.end();
        });
        call.write({ text: "challenge:" + entry.nonce });
      },
    },
  );
  const port = await new Promise((resolve, reject) =>
    peer.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (e, port) => (e ? reject(e) : resolve(port)),
    ),
  );
  const project = await store.create("stdio gRPC"),
    other = await store.create("not granted");
  for (const p of [project, other]) {
    p.settings.grpcDefinitions = [
      {
        id: "chat",
        name: "chat",
        target: `grpc://127.0.0.1:${port}`,
        proto,
        service: "fixture.Echo",
        method: "Chat",
        timeoutMs: 30000,
      },
    ];
    p.plans = [
      {
        id: "finite",
        name: "finite",
        steps: [
          {
            id: "rpc",
            type: "grpc",
            grpc: {
              definition: { ...p.settings.grpcDefinitions[0], method: "Unary" },
              messages: [{ text: "finite" }],
            },
          },
        ],
      },
    ];
    await store.save(p);
  }
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    peer.forceShutdown();
    await rm(root, { recursive: true, force: true });
  });
  const connect = async (flags = ["--write", "--execute"]) => {
    const client = new Client({ name: "stdio-grpc-test", version: "1" });
    client.onerror = () => {};
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [main, "--project", project.id, ...flags],
        env: { LOCAL_API_DATA: root },
        stderr: "pipe",
      }),
    );
    return client;
  };
  const invoke = (c, action, args = {}) =>
    c.callTool({
      name:
        action === "operation"
          ? "localapi_get_grpc_operation"
          : `localapi_${action}_grpc_session`,
      arguments: { projectId: project.id, ...args },
    });
  const get = async (c, id) =>
    decode(await invoke(c, "get", { sessionId: id }));
  const start = async (c, operationId) => {
    const op = decode(
      await invoke(c, "start", { definitionId: "chat", operationId }),
    );
    assert.equal(op.state, "started");
    await until(async () => (await get(c, op.sessionId)).messages.length > 0);
    return op.sessionId;
  };
  return {
    root,
    store,
    project,
    other,
    calls,
    connect,
    invoke,
    get,
    start,
    get unaryCalls() {
      return unaryCalls;
    },
  };
}

test(
  "official stdio SDK bidi challenge sends once and half-closes once with persisted terminal evidence",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect(),
      b = await f.connect();
    const sessionId = await f.start(a, "start");
    assert.equal(
      decode(
        await f.invoke(a, "start", {
          definitionId: "chat",
          operationId: "start",
        }),
      ).sessionId,
      sessionId,
    );
    const nonce = (await f.get(a, sessionId)).messages[0].message.text.slice(
      10,
    );
    const args = {
      sessionId,
      operationId: "send",
      message: { text: "answer:" + nonce },
    };
    decode(await f.invoke(a, "send", args));
    decode(await f.invoke(a, "send", args));
    await until(async () =>
      (await f.get(a, sessionId)).messages.some(
        (m) => m.message?.text === "accepted:" + nonce,
      ),
    );
    assert.equal(
      (await f.invoke(a, "send", { ...args, message: { text: "changed" } }))
        .isError,
      true,
    );
    assert.equal((await f.invoke(b, "get", { sessionId })).isError, true);
    assert.equal(
      (await f.invoke(b, "operation", { operationId: "send" })).isError,
      true,
    );
    assert.equal(
      (await f.invoke(a, "get", { sessionId, projectId: f.other.id })).isError,
      true,
    );
    const op = decode(await f.invoke(a, "operation", { operationId: "send" }));
    assert.equal(op.state, "locally-written");
    assert.equal(op.remoteConfirmed, false);
    assert.equal(op.retrySafe, false);
    decode(await f.invoke(a, "half_close", { sessionId, operationId: "half" }));
    decode(await f.invoke(a, "half_close", { sessionId, operationId: "half" }));
    const terminal = await until(async () => {
      const page = await f.get(a, sessionId);
      return page.lifecycle === "terminal" && page;
    });
    assert.equal(terminal.status.code, grpc.status.OK);
    decode(await f.invoke(a, "cancel", { sessionId }));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].messages.length, 1);
    assert.equal(f.calls[0].ended, true);
    assert.equal((await f.store.get(f.project.id)).protocolRuns.length, 1);
  },
);

test(
  "stdio gRPC EOF cancels peer and persists before child exits",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      client = await f.connect();
    const id = await f.start(client, "start");
    await client.close();
    await until(() => f.calls[0].cancelled);
    const saved = await f.store.get(f.project.id);
    assert.equal(saved.protocolRuns.length, 1);
    assert.equal(saved.protocolRuns[0].id, id);
    assert.equal(f.calls[0].messages.length, 0);
  },
);

test(
  "stdio gRPC advertisement requires both startup grants",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    for (const flags of [[], ["--write"], ["--execute"]]) {
      const c = await f.connect(flags);
      assert.equal(
        (await c.listTools()).tools.some(
          (x) => x.name === "localapi_start_grpc_session",
        ),
        false,
      );
      assert.equal(
        (
          await f.invoke(c, "start", {
            definitionId: "chat",
            operationId: "denied",
          })
        ).isError,
        true,
      );
      await c.close();
    }
    assert.equal(f.calls.length, 0);
  },
);

test(
  "two stdio processes keep separate five-slot gRPC pools and operation identities",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect(),
      b = await f.connect();
    for (let i = 0; i < 5; i++) await f.start(a, "start" + i);
    const rejected = await f.invoke(a, "start", {
      definitionId: "chat",
      operationId: "full",
    });
    assert.equal(rejected.isError, true);
    assert.equal(
      JSON.parse(rejected.content[0].text).state,
      "failed-before-submit",
    );
    const otherId = await f.start(b, "start0");
    assert.equal(f.calls.length, 6);
    await a.close();
    assert.equal((await f.get(b, otherId)).lifecycle, "active");
  },
);

test(
  "canonical stdio finite gRPC plan shares all five interactive slots through entrypoint",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      c = await f.connect(),
      ids = [];
    for (let i = 0; i < 5; i++) ids.push(await f.start(c, "start" + i));
    const run = () =>
      c.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: f.project.id, planId: "finite" },
      });
    const denied = await run();
    assert.match(JSON.stringify(denied), /5个gRPC/);
    assert.equal(f.unaryCalls, 0);
    decode(await f.invoke(c, "cancel", { sessionId: ids[0] }));
    const allowed = decode(await run());
    assert.equal(allowed.status, "passed");
    assert.equal(f.unaryCalls, 1);
  },
);
