import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { createMCP } from "../src/mcp.mjs";

// Real owner HTTP + grpc-js acceptance. Run only in the normal GitHub CI suite;
// authoring this file does not require starting a local application or fixture.
const protoFile = new URL("./fixtures/grpc.proto", import.meta.url);
const proto = await readFile(protoFile, "utf8");
const MAX_BYTES = 1024 * 1024;
const secret = "interactive-session-ephemeral-secret";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, label, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  while (true) {
    const result = await read();
    if (result) return result;
    if (Date.now() >= end) throw Error("Timed out waiting for " + label);
    await delay(10);
  }
}
function successful(response) {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
}
function rejected(response) {
  assert(response.status >= 400, JSON.stringify(response));
  assert.equal(typeof response.value.error, "string");
}
function privateTransport(...values) {
  for (const value of values)
    assert.doesNotMatch(
      JSON.stringify(value),
      /interactive-session-ephemeral-secret|BEGIN (?:RSA )?PRIVATE KEY|BEGIN CERTIFICATE/,
    );
}
const evidenceHash = (value) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest("hex");

async function fixture(t, { secure = false } = {}) {
  const calls = [];
  const peer = new grpc.Server();
  const definitions = loader.loadSync(fileURLToPath(protoFile), {
    keepCase: true,
    longs: String,
    bytes: String,
    enums: String,
    defaults: true,
  });
  const trailers = () => {
    const value = new grpc.Metadata();
    value.set("x-private-trailer", secret);
    return value;
  };
  const begin = (method, call) => {
    const value = {
      method,
      messages: [],
      authorization: call.metadata.get("authorization"),
      ended: false,
      cancelled: false,
    };
    calls.push(value);
    call.on("cancelled", () => (value.cancelled = true));
    const metadata = new grpc.Metadata();
    metadata.set("x-private-response", secret);
    call.sendMetadata(metadata);
    return value;
  };
  peer.addService(
    grpc.loadPackageDefinition(definitions).fixture.Echo.service,
    {
      Unary(call, done) {
        const value = begin("Unary", call);
        value.messages.push(call.request);
        done(null, call.request, trailers());
      },
      Slow(call) {
        const value = begin("Slow", call);
        value.messages.push(call.request);
      },
      Watch(call) {
        const value = begin("Watch", call);
        value.messages.push(call.request);
        if (call.request.text === "partial") {
          call.write({ text: "first-before-cancel", count: 1 });
        } else if (call.request.text === "remote-error") {
          call.write({ text: "first-before-error" }, () => {
            call.emit("error", {
              code: grpc.status.PERMISSION_DENIED,
              details: "stream fixture refusal",
              metadata: trailers(),
            });
          });
        } else if (call.request.text === "byte-burst") {
          for (let i = 0; i < 70; i++)
            call.write({ text: "x".repeat(20000), count: i });
          call.end(trailers());
        } else {
          for (let i = 0; i < 3; i++) call.write({ ...call.request, count: i });
          call.end(trailers());
        }
      },
      Overflow(call) {
        begin("Overflow", call).messages.push(call.request);
        for (let i = 0; i < 101; i++) call.write({ count: i });
        call.end(trailers());
      },
      Collect(call, done) {
        const value = begin("Collect", call);
        call.on("data", (message) => value.messages.push(message));
        call.on("end", () => {
          value.ended = true;
          if (
            value.messages.some((message) => message.text === "no-response")
          ) {
            // grpc-js's public callback status-only branch deliberately omits the
            // message. done(null, null) would instead fail response serialization.
            done({ code: grpc.status.OK, details: "OK" }, null, trailers());
            return;
          }
          done(
            null,
            {
              count: value.messages.reduce(
                (sum, message) => sum + message.count,
                0,
              ),
            },
            trailers(),
          );
        });
      },
      Chat(call) {
        const value = begin("Chat", call);
        call.on("data", (message) => {
          value.messages.push(message);
          call.write(message);
        });
        call.on("end", () => {
          value.ended = true;
          call.end(trailers());
        });
      },
    },
  );
  let tls;
  if (secure)
    tls = {
      ca: await readFile(
        new URL("./fixtures/localhost.crt", import.meta.url),
        "utf8",
      ),
      cert: await readFile(
        new URL("./fixtures/localhost.crt", import.meta.url),
        "utf8",
      ),
      key: await readFile(
        new URL("./fixtures/localhost.key", import.meta.url),
        "utf8",
      ),
    };
  const credentials = secure
    ? grpc.ServerCredentials.createSsl(
        Buffer.from(tls.ca),
        [
          {
            private_key: Buffer.from(tls.key),
            cert_chain: Buffer.from(tls.cert),
          },
        ],
        true,
      )
    : grpc.ServerCredentials.createInsecure();
  const port = await new Promise((resolve, reject) =>
    peer.bindAsync("127.0.0.1:0", credentials, (error, boundPort) =>
      error ? reject(error) : resolve(boundPort),
    ),
  );
  const root = await mkdtemp(path.join(tmpdir(), "grpc-live-workflow-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    try {
      await app.close();
    } finally {
      peer.forceShutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
  const project = await app.store.create("interactive gRPC owner");
  const other = await app.store.create("foreign project");
  const request = async (
    action,
    { method = "POST", body = {}, projectId = project.id, headers = {} } = {},
  ) => {
    const response = await fetch(
      app.url + "/api/projects/" + projectId + "/" + action,
      {
        method,
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
          ...headers,
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, value: await response.json() };
  };
  const define = async (method, extra = {}) =>
    successful(
      await request("grpc-definitions", {
        body: {
          target: (secure ? "grpcs://localhost:" : "grpc://127.0.0.1:") + port,
          proto,
          service: "fixture.Echo",
          method,
          timeoutMs: 10000,
          ...extra,
        },
      }),
    ).definition;
  const get = async (id) =>
    successful(await request("grpc-sessions/" + id, { method: "GET" }));
  const wait = (id, predicate, label = "gRPC session state") =>
    until(async () => {
      const value = await get(id);
      return predicate(value) && value;
    }, label);
  return {
    root,
    project,
    other,
    calls,
    tls,
    get app() {
      return app;
    },
    request,
    define,
    get,
    wait,
    async open(definition, extra = {}) {
      return successful(
        await request("grpc-sessions", {
          body: { definitionId: definition.id, ...extra },
        }),
      );
    },
    action(id, action, body = {}) {
      return request("grpc-sessions/" + id + "/" + action, { body });
    },
    async send(id, message) {
      const admitted = successful(
        await request("grpc-sessions/" + id + "/send", { body: { message } }),
      );
      const index = admitted.requestMessages.length - 1;
      return wait(
        id,
        (value) => value.requestMessages[index]?.sendState === "accepted",
        "local send callback and drain",
      );
    },
    saved(id) {
      return wait(
        id,
        (value) => {
          assert(
            !["failed", "unknown"].includes(value.receiptState),
            JSON.stringify(value),
          );
          return (
            value.lifecycle === "terminal" && value.receiptState === "saved"
          );
        },
        "terminal session and durable receipt",
      );
    },
    async record(id) {
      const stored = await new Store(root).get(project.id);
      return stored.protocolRuns.find((record) => record.id === id);
    },
    async restart() {
      await app.close();
      app = await createApp({ root, port: 0 });
    },
  };
}

test("interactive bidi interleaves owner sends and polls, freezes its definition, persists once and restarts without replay", async (t) => {
  const f = await fixture(t, { secure: true });
  const definition = await f.define("Chat", { name: "Frozen secure Chat" });
  let appends = 0;
  const append = f.app.store.append.bind(f.app.store);
  f.app.store.append = async (...args) => {
    if (args[1] === "protocolRuns") appends++;
    return append(...args);
  };
  const opened = await f.open(definition, {
    tls: f.tls,
    metadata: [{ key: "authorization", value: secret }],
  });
  const id = opened.id;
  assert.equal(opened.type, "grpc");
  assert.equal(opened.lifecycle, "active");
  assert.equal(opened.requestState, "writable");
  assert.equal(opened.receiptState, null);
  assert.deepEqual(opened.requestMessages, []);
  assert.deepEqual(opened.messages, []);
  assert.equal(opened.status, null);
  await until(() => f.calls.length === 1, "bidi transport admission");
  assert.equal(
    f.calls[0].messages.length,
    0,
    "opening must not send an implicit {}",
  );
  const first = {
    text: "first",
    big: "9007199254740993",
    blob: "AAEC",
    count: 2,
  };
  const second = { text: "second", count: 3 };
  await f.send(id, first);
  const partial = await f.wait(id, (value) => value.messages.length === 1);
  assert.equal(partial.lifecycle, "active");
  assert.equal(
    partial.status,
    null,
    "a local write receipt is not RPC success",
  );
  assert.equal(partial.requestMessages[0].sendState, "accepted");
  assert.equal(partial.messages[0].big, first.big);
  assert.equal(partial.messages[0].blob, first.blob);
  assert.equal(appends, 0, "polling an active session must not save it");
  await f.define("Watch", {
    ...definition,
    name: "Changed later",
    method: "Watch",
  });
  successful(
    await f.request("grpc-definitions", {
      method: "DELETE",
      body: { id: definition.id },
    }),
  );
  await f.send(id, second);
  await f.wait(id, (value) => value.messages.length === 2);
  successful(await f.action(id, "half-close"));
  const terminal = await f.saved(id);
  assert.equal(terminal.status.code, grpc.status.OK);
  assert.equal(terminal.remoteStatus.code, grpc.status.OK);
  assert.equal(terminal.responseEnded, true);
  assert.equal(terminal.requestState, "halfClosed");
  assert.equal(terminal.terminationReason, "remote");
  assert.equal(terminal.recordSaved, true);
  assert.equal(terminal.recordId, id);
  assert.equal(terminal.definitionHash, opened.definitionHash);
  assert.equal(terminal.deadlineAt, opened.deadlineAt);
  assert.deepEqual(
    terminal.requestMessages.map((entry) => entry.message),
    [first, second],
  );
  assert(
    terminal.requestMessages.every((entry) => entry.sendState === "accepted"),
  );
  assert.deepEqual(
    terminal.messages.map((message) => message.text),
    ["first", "second"],
  );
  assert.deepEqual(f.calls[0].authorization, [secret]);
  assert.deepEqual(
    f.calls[0].messages.map((message) => message.text),
    ["first", "second"],
  );
  assert.equal(f.calls[0].ended, true);
  const record = await f.record(id);
  assert.equal(record.type, "grpc");
  assert.equal(record.mode, "session");
  assert.equal(record.status, "completed");
  assert.deepEqual(record.definition, definition);
  assert.equal(record.definitionHash, evidenceHash(definition));
  assert.equal(record.resultHash, evidenceHash(record.result));
  assert.deepEqual(record.result.messages, terminal.messages);
  assert.equal(Object.hasOwn(record.result, "projectId"), false);
  const immutable = JSON.stringify(record);
  await Promise.all([
    f.get(id),
    f.get(id),
    f.action(id, "cancel"),
    f.action(id, "reconcile"),
  ]);
  assert.equal(
    appends,
    1,
    "GET and repeated terminal operations cannot duplicate persistence",
  );
  assert.equal(JSON.stringify(await f.record(id)), immutable);
  rejected(await f.action(id, "send", { message: { text: "too late" } }));
  const history = successful(await f.request("grpc-runs", { method: "GET" }));
  assert.equal(history.filter((value) => value.id === id).length, 1);
  const backup = successful(await f.request("export", { method: "GET" }));
  privateTransport(
    opened,
    partial,
    terminal,
    history,
    backup,
    await new Store(f.root).get(f.project.id),
  );
  const restoredResponse = await fetch(f.app.url + "/api/restore", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-local-token": f.app.token,
    },
    body: JSON.stringify({ document: backup }),
  });
  assert.equal(restoredResponse.status, 201);
  const restored = await restoredResponse.json();
  assert.notEqual(restored.id, f.project.id);
  assert.deepEqual(restored.protocolRuns, backup.protocolRuns);
  rejected(
    await f.request("grpc-sessions/" + id, {
      method: "GET",
      projectId: restored.id,
    }),
  );
  assert.equal(f.calls.length, 1);
  await f.restart();
  rejected(await f.request("grpc-sessions/" + id, { method: "GET" }));
  rejected(await f.action(id, "reconcile"));
  const reloadedHistory = successful(
    await f.request("grpc-runs", { method: "GET" }),
  );
  assert.deepEqual(reloadedHistory, history);
  assert.equal(
    f.calls.length,
    1,
    "restart and restore must not reopen transport",
  );
  assert.equal(JSON.stringify(await f.record(id)), immutable);
  const mcp = createMCP({ store: f.app.store, projects: [f.project.id] });
  const catalogue = await mcp({ id: 1, method: "tools/list" });
  assert.equal(
    catalogue.result.tools.some((tool) =>
      /grpc.*session|session.*grpc/i.test(tool.name),
    ),
    false,
  );
  const read = await mcp({
    id: 2,
    method: "tools/call",
    params: {
      name: "localapi_get_protocol_run",
      arguments: { projectId: f.project.id, recordId: id },
    },
  });
  assert.notEqual(read.result.isError, true, JSON.stringify(read));
  assert.deepEqual(JSON.parse(read.result.content[0].text), record);
  privateTransport(read);
  assert.equal(
    f.calls.length,
    1,
    "read-only MCP history must not reopen or replay a session",
  );
});

test("client streaming sends only explicitly, aggregates after half-close, and retains callback plus wire status", async (t) => {
  const f = await fixture(t);
  const definition = await f.define("Collect");
  const { id } = await f.open(definition);
  await until(() => f.calls.length === 1, "client-stream admission");
  assert.deepEqual(f.calls[0].messages, []);
  for (const count of [2, 5, 9]) {
    await f.send(id, { count });
    const active = await f.get(id);
    assert.equal(active.lifecycle, "active");
    assert.equal(active.status, null);
    assert.equal(active.messages.length, 0);
    assert.equal(active.requestState, "writable");
  }
  successful(await f.action(id, "half-close"));
  const result = await f.saved(id);
  assert.equal(result.status.code, grpc.status.OK);
  assert.equal(result.remoteStatus.code, grpc.status.OK);
  assert.equal(result.callback.code, grpc.status.OK);
  assert.equal(result.callback.responseReceived, true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].count, 16);
  assert.equal(result.requestMessages.length, 3);
  assert(
    result.requestMessages.every((entry) => entry.sendState === "accepted"),
  );
  assert.equal((await f.record(id)).status, "completed");
  rejected(await f.action(id, "send", { message: { count: 100 } }));
  assert.equal(f.calls[0].messages.length, 3);
});

test("client-stream trailers-only OK preserves missing-response callback failure independently from remote status", async (t) => {
  const f = await fixture(t);
  const definition = await f.define("Collect");
  const opened = await f.open(definition);
  await f.send(opened.id, { text: "no-response" });
  successful(await f.action(opened.id, "half-close"));
  const result = await f.saved(opened.id);
  assert.equal(result.status.code, grpc.status.UNIMPLEMENTED);
  assert.equal(result.remoteStatus.code, grpc.status.OK);
  assert.equal(result.callback.code, grpc.status.UNIMPLEMENTED);
  assert.equal(result.callback.responseReceived, false);
  assert.deepEqual(result.messages, []);
  const record = await f.record(opened.id);
  assert.equal(record.status, "failed");
  assert.equal(record.result.remoteStatus.code, grpc.status.OK);
  assert.equal(record.result.status.code, grpc.status.UNIMPLEMENTED);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].messages.length, 1);
});

test("server streaming retains partial cancellation and remote error evidence without forging OK", async (t) => {
  const f = await fixture(t);
  const definition = await f.define("Watch");
  const { id } = await f.open(definition, { message: { text: "partial" } });
  const partial = await f.wait(id, (value) => value.messages.length === 1);
  assert.equal(partial.requestState, "halfClosed");
  assert.equal(partial.requestMessages[0].sendState, "submitted");
  rejected(await f.action(id, "send", { message: { text: "illegal" } }));
  successful(await f.action(id, "cancel"));
  const cancelled = await f.saved(id);
  assert.equal(cancelled.status.code, grpc.status.CANCELLED);
  assert.equal(cancelled.terminationReason, "cancel");
  assert.equal(cancelled.messages[0].text, "first-before-cancel");
  assert.equal((await f.record(id)).status, "partial");
  await until(() => f.calls[0].cancelled, "remote cancellation");
  const frozen = JSON.stringify(cancelled);
  assert.equal(
    JSON.stringify(await f.get(id)),
    frozen,
    "late transport events cannot rewrite a terminal snapshot",
  );
  const failed = await f.open(definition, {
    message: { text: "remote-error" },
  });
  const result = await f.saved(failed.id);
  assert.equal(result.status.code, grpc.status.PERMISSION_DENIED);
  assert.equal(result.remoteStatus.code, grpc.status.PERMISSION_DENIED);
  assert.equal(result.status.details, "stream fixture refusal");
  assert.equal(result.messages[0].text, "first-before-error");
  assert.notEqual((await f.record(failed.id)).status, "completed");
  privateTransport(
    cancelled,
    result,
    await new Store(f.root).get(f.project.id),
  );
});

test("interactive admission and operations enforce token, origin, project ownership and strict preflight before transport", async (t) => {
  const f = await fixture(t);
  const chat = await f.define("Chat");
  const watch = await f.define("Watch");
  const unary = await f.define("Unary");
  for (const body of [
    {},
    { definitionId: "missing-definition" },
    { definitionId: unary.id },
    { definitionId: watch.id },
    { definitionId: chat.id, message: {} },
    { definitionId: chat.id, messages: [] },
    { definitionId: chat.id, target: "grpc://127.0.0.1:1" },
    { definitionId: chat.id, method: "Collect" },
    { definitionId: chat.id, timeoutMs: 30000 },
    { definitionId: chat.id, metadata: [{ key: "bad\nkey", value: "secret" }] },
    { definitionId: chat.id, tls: { rejectUnauthorized: false } },
    { definitionId: watch.id, message: { count: "bad" } },
  ])
    rejected(await f.request("grpc-sessions", { body }));
  rejected(
    await f.request("grpc-sessions", {
      body: { definitionId: chat.id },
      projectId: f.other.id,
    }),
  );
  for (const headers of [
    { "x-local-token": "" },
    { Origin: "https://untrusted.example" },
  ])
    rejected(
      await f.request("grpc-sessions", {
        body: { definitionId: chat.id },
        headers,
      }),
    );
  assert.equal(
    f.calls.length,
    0,
    "invalid admission must not reach any RPC handler",
  );
  const { id } = await f.open(chat);
  await until(() => f.calls.length === 1, "valid admission after rejections");
  for (const [method, suffix, body] of [
    ["GET", "", {}],
    ["POST", "/send", { message: { text: "foreign" } }],
    ["POST", "/half-close", {}],
    ["POST", "/cancel", {}],
    ["POST", "/reconcile", {}],
  ])
    rejected(
      await f.request("grpc-sessions/" + id + suffix, {
        method,
        body,
        projectId: f.other.id,
      }),
    );
  for (const body of [
    {},
    { message: null },
    { message: [] },
    { message: { unknown: true } },
    { message: { big: 9007199254740992 } },
    { message: {}, extra: true },
  ])
    rejected(await f.action(id, "send", body));
  for (const action of ["half-close", "cancel", "reconcile"])
    rejected(await f.action(id, action, { extra: true }));
  rejected(await f.action(id, "reconcile"));
  const stillActive = await f.get(id);
  assert.equal(stillActive.lifecycle, "active");
  assert.deepEqual(stillActive.requestMessages, []);
  assert.deepEqual(f.calls[0].messages, []);
  successful(await f.action(id, "send", { message: { text: "owner" } }));
  await f.wait(id, (value) => value.messages.length === 1);
  successful(await f.action(id, "cancel"));
  await f.saved(id);
  assert.deepEqual(
    f.calls[0].messages.map((value) => value.text),
    ["owner"],
  );
});

test("interactive sessions and finite grpc-run share five slots, released by real cancellation", async (t) => {
  const f = await fixture(t);
  const chat = await f.define("Chat");
  const slow = await f.define("Slow", { timeoutMs: 5000 });
  const unary = await f.define("Unary");
  const plan = successful(
    await f.request("plans", {
      body: {
        steps: [{ type: "grpc", grpc: { definition: unary, messages: [{}] } }],
      },
    }),
  );
  const active = [];
  for (let index = 0; index < 4; index++) active.push(await f.open(chat));
  await until(() => f.calls.length === 4, "four live session transports");
  const pending = f.request("grpc-run", {
    body: { definitionId: slow.id, runId: "shared-session-slot" },
  });
  try {
    await until(
      () => f.calls.some((call) => call.method === "Slow"),
      "finite fifth slot",
    );
    rejected(
      await f.request("grpc-sessions", { body: { definitionId: chat.id } }),
    );
    rejected(await f.request("grpc-run", { body: { definitionId: unary.id } }));
    const reflection = await f.request("grpc-reflection", {
      body: { target: unary.target, service: unary.service },
    });
    rejected(reflection);
    assert.match(reflection.value.error, /5个/);
    const busy = successful(
      await f.request("run", { body: { planId: plan.id } }),
    );
    assert.equal(busy.status, "failed");
    assert.match(busy.results[0].error, /5个/);
    assert.equal(
      f.calls.length,
      5,
      "neither denied admission can reach the peer",
    );
    successful(await f.action(active[0].id, "cancel"));
    await f.saved(active[0].id);
    const admitted = successful(
      await f.request("grpc-run", {
        body: { definitionId: unary.id, messages: [{ text: "freed-slot" }] },
      }),
    );
    assert.equal(admitted.status.code, grpc.status.OK);
    assert.equal(admitted.messages[0].text, "freed-slot");
    assert.equal(f.calls.length, 6);
  } finally {
    const response = await fetch(f.app.url + "/api/cancel", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": f.app.token,
      },
      body: JSON.stringify({ id: "shared-session-slot" }),
    });
    await response.json();
    await Promise.all(active.map((session) => f.action(session.id, "cancel")));
  }
  const finite = successful(await pending);
  assert.equal(finite.status.code, grpc.status.CANCELLED);
  const fresh = await f.open(chat);
  await f.send(fresh.id, { text: "slot-reusable" });
  await f.wait(fresh.id, (value) => value.messages.length === 1);
  successful(await f.action(fresh.id, "cancel"));
  await f.saved(fresh.id);
});

test("polling and repeated sends never renew the saved definition's total deadline", async (t) => {
  const f = await fixture(t);
  const definition = await f.define("Chat", { timeoutMs: 1200 });
  const opened = await f.open(definition);
  assert.equal(
    Date.parse(opened.deadlineAt) - Date.parse(opened.createdAt),
    1200,
  );
  let sent = 0;
  const result = await until(
    async () => {
      const snapshot = await f.get(opened.id);
      assert.equal(snapshot.deadlineAt, opened.deadlineAt);
      if (snapshot.lifecycle === "terminal") return snapshot;
      if (
        snapshot.requestMessages.some((entry) => entry.sendState === "pending")
      )
        return false;
      const response = await f.action(opened.id, "send", {
        message: { text: "keep-alive-" + sent++ },
      });
      if (response.status !== 200) {
        rejected(response);
        const current = await f.get(opened.id);
        assert(
          current.lifecycle === "terminal" ||
            current.requestMessages.some(
              (entry) => entry.sendState === "pending",
            ),
          "a late sequential send can only race deadline or outstanding local progress",
        );
      }
      // Pace traffic across the configured budget; the next write is gated by
      // observed local receipt state, never an assumption that this delay drains it.
      await delay(Math.floor(definition.timeoutMs / 12));
      return false;
    },
    "fixed deadline despite continued traffic",
    3000,
  );
  assert(sent >= 2, "deadline test must exercise repeated traffic");
  assert.equal(result.status.code, grpc.status.DEADLINE_EXCEEDED);
  assert.equal(result.deadlineAt, opened.deadlineAt);
  assert(
    result.durationMs < 2700,
    "the 1200 ms budget cannot restart on each send",
  );
  const saved = await f.saved(opened.id);
  assert.equal(saved.recordSaved, true);
  assert(saved.requestMessages.every((entry) => entry.sendState !== "pending"));
  rejected(await f.action(opened.id, "send", { message: { text: "late" } }));
  assert.equal(
    (await f.record(opened.id)).result.deadlineAt,
    opened.deadlineAt,
  );
});

test("request count and cumulative bytes are bounded before transport while valid client-stream evidence remains usable", async (t) => {
  const f = await fixture(t);
  const definition = await f.define("Collect", { timeoutMs: 30000 });
  const opened = await f.open(definition);
  for (let count = 0; count < 100; count++)
    await f.send(opened.id, { count: 1 });
  rejected(await f.action(opened.id, "send", { message: { count: 999 } }));
  const bounded = await f.get(opened.id);
  assert.equal(bounded.lifecycle, "active");
  assert.equal(bounded.requestMessages.length, 100);
  assert.equal(
    bounded.requestBytes,
    bounded.requestMessages.reduce((sum, entry) => sum + entry.jsonBytes, 0),
  );
  assert.equal(
    bounded.requestWireBytes,
    bounded.requestMessages.reduce((sum, entry) => sum + entry.wireBytes, 0),
  );
  assert(bounded.requestBytes <= MAX_BYTES);
  assert(bounded.requestWireBytes <= MAX_BYTES);
  successful(await f.action(opened.id, "half-close"));
  const result = await f.saved(opened.id);
  assert.equal(result.status.code, grpc.status.OK);
  assert.equal(result.messages[0].count, 100);
  assert.equal(f.calls[0].messages.length, 100);
  const bytes = await f.open(definition);
  rejected(
    await f.action(bytes.id, "send", {
      message: { text: "z".repeat(MAX_BYTES) },
    }),
  );
  assert.deepEqual((await f.get(bytes.id)).requestMessages, []);
  const large = { text: "x".repeat(300000), count: 1 };
  for (let index = 0; index < 3; index++) await f.send(bytes.id, large);
  rejected(await f.action(bytes.id, "send", { message: large }));
  const boundedBytes = await f.get(bytes.id);
  assert.equal(boundedBytes.requestMessages.length, 3);
  assert(boundedBytes.requestBytes <= MAX_BYTES);
  assert(boundedBytes.requestWireBytes <= MAX_BYTES);
  successful(await f.action(bytes.id, "half-close"));
  const byteResult = await f.saved(bytes.id);
  assert.equal(byteResult.status.code, grpc.status.OK);
  assert.equal(byteResult.messages[0].count, 3);
  assert.equal(
    f.calls[1].messages.length,
    3,
    "rejected bytes must not be sent",
  );
  assert.equal((await f.record(bytes.id)).result.requestMessages.length, 3);
});

test("response count and byte overflow freeze bounded partial evidence", async (t) => {
  const f = await fixture(t);
  for (const [method, message, expectedCount] of [
    ["Overflow", {}, 100],
    ["Watch", { text: "byte-burst" }, null],
  ]) {
    const definition = await f.define(method);
    const opened = await f.open(definition, { message });
    const result = await f.saved(opened.id);
    assert.equal(result.status.code, grpc.status.RESOURCE_EXHAUSTED);
    assert.equal(result.terminationReason, "limit");
    assert.equal(result.truncated, true);
    assert(result.messages.length > 0 && result.messages.length <= 100);
    if (expectedCount !== null)
      assert.equal(result.messages.length, expectedCount);
    else assert(result.messages.length < 70);
    assert.equal(
      result.responseBytes,
      result.messages.reduce(
        (sum, value) => sum + Buffer.byteLength(JSON.stringify(value)),
        0,
      ),
    );
    assert(result.responseBytes <= MAX_BYTES);
    const record = await f.record(opened.id);
    assert.equal(record.status, "partial");
    assert.deepEqual(record.result.messages, result.messages);
    assert.equal(record.result.responseBytes, result.responseBytes);
    const frozen = JSON.stringify(result);
    assert.equal(JSON.stringify(await f.get(opened.id)), frozen);
  }
});

test("parallel sends, half-close and cancel have explicit local receipts, no hidden queue and one immutable record", async (t) => {
  const f = await fixture(t);
  const definition = await f.define("Chat");
  const opened = await f.open(definition);
  await f.send(opened.id, { text: "before-race" });
  await f.wait(opened.id, (value) => value.messages.length === 1);
  let appends = 0;
  const append = f.app.store.append.bind(f.app.store);
  f.app.store.append = async (...args) => {
    if (args[1] === "protocolRuns") appends++;
    return append(...args);
  };
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    text: "racing-" + index,
  }));
  const responses = await Promise.all([
    ...candidates.map((message) => f.action(opened.id, "send", { message })),
    f.action(opened.id, "half-close"),
    f.action(opened.id, "cancel"),
  ]);
  const result = await f.saved(opened.id);
  assert.equal(result.lifecycle, "terminal");
  assert([grpc.status.OK, grpc.status.CANCELLED].includes(result.status.code));
  assert.equal(appends, 1);
  assert(
    result.requestMessages.every((entry) =>
      ["accepted", "failed", "unknown"].includes(entry.sendState),
    ),
  );
  const retained = result.requestMessages.map((entry) => entry.message.text);
  assert.equal(new Set(retained).size, retained.length);
  for (let index = 0; index < candidates.length; index++) {
    const response = responses[index];
    if (response.status === 200) {
      assert(
        retained.includes(candidates[index].text),
        "every admitted send needs a retained receipt",
      );
      const receipt = response.value.requestMessages.find(
        (entry) => entry.message.text === candidates[index].text,
      );
      assert(receipt);
      assert(
        ["pending", "accepted", "failed", "unknown"].includes(
          receipt.sendState,
        ),
      );
      assert.equal(typeof receipt.jsonBytes, "number");
      assert.equal(typeof receipt.wireBytes, "number");
    } else {
      rejected(response);
      assert.equal(
        retained.includes(candidates[index].text),
        false,
        "rejected sends are not queued behind cancel",
      );
    }
  }
  for (const response of responses.slice(candidates.length))
    if (response.status !== 200) rejected(response);
  const observed = f.calls[0].messages.map((message) => message.text);
  assert.equal(new Set(observed).size, observed.length);
  assert(observed.every((message) => retained.includes(message)));
  const immutable = JSON.stringify(await f.record(opened.id));
  const sends = f.calls[0].messages.length;
  successful(await f.action(opened.id, "reconcile"));
  successful(await f.action(opened.id, "cancel"));
  assert.equal(appends, 1);
  assert.equal(JSON.stringify(await f.record(opened.id)), immutable);
  assert.equal(
    f.calls[0].messages.length,
    sends,
    "terminal operations cannot replay sends",
  );
});

test("normal application shutdown waits for automatic gRPC receipts and restart exposes only inert history", async (t) => {
  const f = await fixture(t);
  const chat = await f.define("Chat");
  const watch = await f.define("Watch");
  const bidi = await f.open(chat);
  const server = await f.open(watch, { message: { text: "partial" } });
  await f.send(bidi.id, { text: "shutdown-evidence" });
  await f.wait(bidi.id, (value) => value.messages.length === 1);
  await f.wait(server.id, (value) => value.messages.length === 1);
  let release,
    attempts = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const append = f.app.store.append.bind(f.app.store);
  f.app.store.append = async (...args) => {
    if (args[1] === "protocolRuns") {
      attempts++;
      await gate;
    }
    return append(...args);
  };
  const closing = f.app.close();
  assert.equal(f.app.close(), closing, "normal shutdown is idempotent");
  let resolved = false;
  closing.then(() => {
    resolved = true;
  });
  try {
    await until(
      () => attempts === 2,
      "two automatic shutdown persistence attempts",
    );
    assert.equal(
      resolved,
      false,
      "shutdown must await durable receipts rather than only transport teardown",
    );
  } finally {
    release();
  }
  const outcome = await closing;
  assert.equal(outcome.allRecordsSaved, true);
  assert.equal(outcome.grpcSessions.length, 2);
  assert.deepEqual(
    outcome.grpcSessions.map((receipt) => receipt.sessionId).sort(),
    [bidi.id, server.id].sort(),
  );
  assert(
    outcome.grpcSessions.every(
      (receipt) =>
        receipt.recordSaved === true && receipt.receiptState === "saved",
    ),
  );
  assert.equal(attempts, 2);
  const stored = await new Store(f.root).get(f.project.id);
  assert.equal(stored.protocolRuns.length, 2);
  for (const record of stored.protocolRuns) {
    assert.equal(record.type, "grpc");
    assert.equal(record.mode, "session");
    assert.equal(record.status, "partial");
    assert.equal(record.result.terminationReason, "shutdown");
    assert.equal(record.result.status.code, grpc.status.CANCELLED);
    assert.equal(record.result.messages.length, 1);
  }
  const callCount = f.calls.length;
  await f.restart();
  for (const id of [bidi.id, server.id])
    rejected(await f.request("grpc-sessions/" + id, { method: "GET" }));
  assert.deepEqual(
    successful(await f.request("grpc-runs", { method: "GET" })),
    stored.protocolRuns,
  );
  assert.equal(f.calls.length, callCount);
});

test("generic save failure stays explicitly unsaved until storage-only reconciliation and never repeats a send", async (t) => {
  const f = await fixture(t);
  const definition = await f.define("Chat");
  const opened = await f.open(definition);
  await f.send(opened.id, { text: "effect-before-disk-failure" });
  await f.wait(opened.id, (value) => value.messages.length === 1);
  const append = f.app.store.append.bind(f.app.store);
  let attempts = 0,
    attemptedRecord;
  f.app.store.append = async (...args) => {
    if (args[1] === "protocolRuns") {
      attempts++;
      attemptedRecord = structuredClone(args[2]);
      throw Error("private-disk-error " + f.root);
    }
    return append(...args);
  };
  try {
    const failed = successful(await f.action(opened.id, "cancel"));
    assert.equal(failed.lifecycle, "terminal");
    assert.equal(failed.receiptState, "failed");
    assert.equal(failed.recordSaved, false);
    assert.equal(failed.recordId, null);
    assert.equal(failed.attemptedRecordId, opened.id);
    assert.equal(failed.persistenceOutcome.code, "RECORD_SAVE_FAILED");
    assert.equal(failed.persistenceOutcome.retry_safe, false);
    assert.equal(JSON.stringify(failed).includes(f.root), false);
    assert.doesNotMatch(JSON.stringify(failed), /private-disk-error/);
    assert.equal(attempts, 1);
    await until(
      () => f.calls[0].cancelled,
      "cancelled stream before storage repair",
    );
    assert.deepEqual(await f.get(opened.id), failed);
    assert.deepEqual(await f.get(opened.id), failed);
    assert.equal(attempts, 1, "GET must not retry failed persistence");
    assert.equal(
      (await new Store(f.root).get(f.project.id)).protocolRuns.length,
      0,
    );
    f.app.store.append = async (...args) => {
      if (args[1] === "protocolRuns") attempts++;
      return append(...args);
    };
    const repaired = await Promise.all([
      f.action(opened.id, "reconcile"),
      f.action(opened.id, "reconcile"),
    ]);
    for (const response of repaired) {
      const receipt = successful(response);
      assert.equal(receipt.receiptState, "saved");
      assert.equal(receipt.recordId, opened.id);
      assert.equal(receipt.recordSaved, true);
      assert.deepEqual(receipt.requestMessages, failed.requestMessages);
      assert.deepEqual(receipt.messages, failed.messages);
    }
    assert.equal(
      attempts,
      2,
      "one failed attempt plus one joined explicit storage retry",
    );
    const stored = await new Store(f.root).get(f.project.id);
    assert.equal(stored.protocolRuns.length, 1);
    assert.deepEqual(stored.protocolRuns[0], attemptedRecord);
    successful(await f.action(opened.id, "cancel"));
    assert.equal(attempts, 2);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].messages.length, 1);
  } finally {
    f.app.store.append = append;
  }
});

test("real post-journal disk failure stays unknown through GET and reconciles the same immutable record without append or network replay", async (t) => {
  const f = await fixture(t);
  const definition = await f.define("Chat");
  const opened = await f.open(definition);
  await f.send(opened.id, { text: "effect-before-journal-failure" });
  await f.wait(opened.id, (value) => value.messages.length === 1);
  const directory = f.app.store.directory(f.project.id);
  const apis = path.join(directory, "apis");
  const journalPath = path.join(directory, ".transaction.json");
  const append = f.app.store.append.bind(f.app.store);
  const get = f.app.store.get.bind(f.app.store);
  let appends = 0,
    reads = 0,
    obstacle = false;
  f.app.store.append = async (...args) => {
    if (args[1] === "protocolRuns") appends++;
    return append(...args);
  };
  f.app.store.get = async (...args) => {
    reads++;
    return get(...args);
  };
  try {
    // The fixture project has no API records, so reads remain valid. Its next
    // write publishes the journal, then mkdir(apis) fails on this real file.
    await rm(apis, { recursive: true });
    await writeFile(apis, "private-journal-obstacle");
    obstacle = true;
    const unknown = successful(await f.action(opened.id, "cancel"));
    assert.equal(unknown.receiptState, "unknown");
    assert.equal(unknown.lifecycle, "terminal");
    assert.equal(unknown.recordSaved, false);
    assert.equal(unknown.recordId, null);
    assert.equal(unknown.attemptedRecordId, opened.id);
    assert.equal(unknown.persistenceOutcome.code, "PROJECT_COMMIT_UNCERTAIN");
    assert.equal(unknown.persistenceOutcome.commit_outcome, "unknown");
    assert.equal(unknown.persistenceOutcome.retry_safe, false);
    assert.equal(unknown.persistenceOutcome.project_id, f.project.id);
    assert.equal(JSON.stringify(unknown).includes(f.root), false);
    assert.doesNotMatch(JSON.stringify(unknown), /private-journal-obstacle/);
    assert.equal(appends, 1);
    await until(
      () => f.calls[0].cancelled,
      "remote cancellation before recovery",
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const candidate = journal.protocolRuns.find(
      (record) => record.id === opened.id,
    );
    assert(
      candidate,
      "the uncertain attempt must really have published its immutable journal record",
    );
    const readsBeforePolling = reads;
    assert.deepEqual(await f.get(opened.id), unknown);
    assert.deepEqual(await f.get(opened.id), unknown);
    rejected(
      await f.request("grpc-sessions/" + opened.id, {
        method: "GET",
        projectId: f.other.id,
      }),
    );
    assert.equal(
      reads,
      readsBeforePolling,
      "GET cannot invoke project read/recovery even while storage is damaged",
    );
    assert.equal(appends, 1);
    await rm(apis);
    obstacle = false;
    assert.deepEqual(await f.get(opened.id), unknown);
    assert.equal(
      reads,
      readsBeforePolling,
      "repairing the obstacle alone does not authorize GET to reconcile",
    );
    assert.deepEqual(JSON.parse(await readFile(journalPath, "utf8")), journal);
    const repaired = await Promise.all([
      f.action(opened.id, "reconcile"),
      f.action(opened.id, "reconcile"),
    ]);
    for (const response of repaired) {
      const receipt = successful(response);
      assert.equal(receipt.receiptState, "saved");
      assert.equal(receipt.recordSaved, true);
      assert.equal(receipt.recordId, opened.id);
      assert.equal(receipt.definitionHash, unknown.definitionHash);
      assert.deepEqual(receipt.requestMessages, unknown.requestMessages);
      assert.deepEqual(receipt.messages, unknown.messages);
    }
    assert.equal(
      appends,
      1,
      "matching recovered journal evidence is read back, never appended again",
    );
    const stored = await new Store(f.root).get(f.project.id);
    assert.equal(stored.protocolRuns.length, 1);
    assert.deepEqual(stored.protocolRuns[0], candidate);
    assert.equal(
      stored.protocolRuns[0].resultHash,
      evidenceHash(candidate.result),
    );
    await assert.rejects(readFile(journalPath), { code: "ENOENT" });
    successful(await f.action(opened.id, "cancel"));
    assert.equal(appends, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].messages.length, 1);
  } finally {
    f.app.store.append = append;
    f.app.store.get = get;
    if (obstacle) await rm(apis, { force: true });
  }
});
