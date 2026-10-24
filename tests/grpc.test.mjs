import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import {
  inspectGrpcSchema,
  normalizeGrpcDefinition,
  executeGrpc,
} from "../src/grpc.mjs";
const file = new URL("./fixtures/grpc.proto", import.meta.url);
const proto = await readFile(file, "utf8");
async function fixture(t, secure = false, clientCertificate = false) {
  const definition = loader.loadSync(fileURLToPath(file), {
    keepCase: true,
    longs: String,
    bytes: String,
    enums: String,
    defaults: true,
  });
  const server = new grpc.Server(),
    seen = [];
  let signalSlow,
    signalFive,
    slowCount = 0;
  const fiveStarted = new Promise((resolve) => {
    signalFive = resolve;
  });
  const slowStarted = new Promise((resolve) => {
    signalSlow = resolve;
  });
  server.addService(
    grpc.loadPackageDefinition(definition).fixture.Echo.service,
    {
      Unary(call, done) {
        seen.push({
          request: call.request,
          metadata: call.metadata.get("x-test"),
        });
        const headers = new grpc.Metadata();
        headers.set("x-reply", "ok");
        call.sendMetadata(headers);
        done(null, call.request);
      },
      Watch(call) {
        for (let i = 0; i < 3; i++) call.write({ ...call.request, count: i });
        call.end();
      },
      Collect(call, done) {
        let count = 0;
        call.on("data", () => count++);
        call.on("end", () => done(null, { count }));
      },
      Chat(call) {
        call.on("data", (value) => call.write(value));
        call.on("end", () => call.end());
      },
      Fail(_call, done) {
        done({
          code: grpc.status.PERMISSION_DENIED,
          details: "fixture refusal",
        });
      },
      Slow() {
        if (++slowCount === 5) signalFive();
        signalSlow();
      },
      Overflow(call) {
        for (let i = 0; i < 101; i++) call.write({ count: i });
        call.end();
      },
    },
  );
  const cert = secure
    ? await readFile(new URL("./fixtures/localhost.crt", import.meta.url))
    : null;
  const key = secure
    ? await readFile(new URL("./fixtures/localhost.key", import.meta.url))
    : null;
  const credentials = secure
    ? grpc.ServerCredentials.createSsl(
        clientCertificate ? cert : null,
        [{ private_key: key, cert_chain: cert }],
        clientCertificate,
      )
    : grpc.ServerCredentials.createInsecure();
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", credentials, (err, port) =>
      err ? reject(err) : resolve(port),
    ),
  );
  t.after(() => server.forceShutdown());
  return {
    target: (secure ? "grpcs://localhost:" : "grpc://127.0.0.1:") + port,
    seen,
    slowStarted,
    fiveStarted,
    cert,
    key,
  };
}
test("gRPC backend discovers schemas and closes all four RPC styles with precise data and metadata", async (t) => {
  const { target, seen } = await fixture(t);
  const schema = inspectGrpcSchema(proto);
  assert.equal(schema.services[0].name, "fixture.Echo");
  assert.equal(schema.services[0].methods.length, 7);
  const value = {
    text: "hello",
    big: "9007199254740993",
    blob: "AAEC",
    count: 7,
    tags: { key: "value" },
  };
  const call = (method, messages) =>
    executeGrpc({
      target,
      proto,
      service: "fixture.Echo",
      method,
      messages,
      metadata: [{ key: "X-Test", value: "present" }],
    });
  const unary = await call("Unary", [value]);
  assert.equal(unary.status.code, 0);
  assert.equal(unary.messages[0].big, value.big);
  assert.equal(unary.messages[0].blob, value.blob);
  assert.deepEqual(seen[0].metadata, ["present"]);
  assert(unary.metadata.some((x) => x.key === "x-reply" && x.value === "ok"));
  const server = await call("Watch", [value]);
  assert.equal(server.status.code, 0);
  assert.deepEqual(
    server.messages.map((x) => x.count),
    [0, 1, 2],
  );
  const client = await call("Collect", [value, value]);
  assert.equal(client.status.code, 0);
  assert.equal(client.messages[0].count, 2);
  const bidi = await call("Chat", [value, { ...value, text: "second" }]);
  assert.equal(bidi.status.code, 0);
  assert.deepEqual(
    bidi.messages.map((x) => x.text),
    ["hello", "second"],
  );
});
test("gRPC backend retains remote status, bounds streams and honors deadline/cancellation", async (t) => {
  const { target } = await fixture(t);
  const input = { target, proto, service: "fixture.Echo", messages: [{}] };
  assert.equal(
    (await executeGrpc({ ...input, method: "Fail" })).status.code,
    grpc.status.PERMISSION_DENIED,
  );
  assert.equal(
    (await executeGrpc({ ...input, method: "Slow", timeoutMs: 100 })).status
      .code,
    grpc.status.DEADLINE_EXCEEDED,
  );
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await executeGrpc({ ...input, method: "Slow" }, controller.signal)).status
      .code,
    grpc.status.CANCELLED,
  );
  const overflow = await executeGrpc({ ...input, method: "Overflow" });
  assert.equal(overflow.status.code, grpc.status.RESOURCE_EXHAUSTED);
  assert.equal(overflow.truncated, true);
  assert.equal(overflow.messages.length, 100);
});
test("gRPC validation refuses file imports, unsafe targets, coercion and extra fields before connecting", async (t) => {
  const remote = await fixture(t);
  assert.throws(
    () => inspectGrpcSchema('syntax="proto3"; import "../../secret.proto";'),
    /导入/,
  );
  assert.throws(
    () => normalizeGrpcDefinition({ target: "file:///tmp/x", proto }),
    /地址/,
  );
  assert.throws(
    () =>
      normalizeGrpcDefinition({
        target: "grpc://user:pass@localhost:123",
        proto,
      }),
    /地址/,
  );
  const input = {
    target: remote.target,
    proto,
    service: "fixture.Echo",
    method: "Unary",
  };
  for (const message of [
    { toString: 1 },
    { valueOf: 1 },
    { count: "bad" },
    { count: 4294967296 },
    { big: 9007199254740992 },
    { big: "9223372036854775808" },
    { unknown: 1 },
    { blob: "***" },
  ])
    await assert.rejects(executeGrpc({ ...input, messages: [message] }));
  await assert.rejects(executeGrpc({ ...input, messages: [{}, {}] }), /一个/);
  await assert.rejects(
    executeGrpc({
      ...input,
      messages: [{}],
      metadata: [{ key: "bad\nkey", value: "x" }],
    }),
    /metadata/,
  );
});

test("gRPC keeps TLS verification and supports explicit CA and mutual TLS", async (t) => {
  const secure = await fixture(t, true, true);
  const input = {
    target: secure.target,
    proto,
    service: "fixture.Echo",
    method: "Unary",
    messages: [{ text: "secure" }],
    timeoutMs: 2000,
  };
  const untrusted = await executeGrpc(input);
  assert.notEqual(untrusted.status.code, 0);
  assert.equal(untrusted.messages.length, 0);
  const noClient = await executeGrpc({
    ...input,
    tls: { ca: secure.cert.toString() },
  });
  assert.notEqual(noClient.status.code, 0);
  const trusted = await executeGrpc({
    ...input,
    tls: {
      ca: secure.cert.toString(),
      cert: secure.cert.toString(),
      key: secure.key.toString(),
    },
  });
  assert.equal(trusted.status.code, 0, JSON.stringify(trusted.status));
  assert.equal(trusted.messages[0].text, "secure");
  await assert.rejects(
    executeGrpc({ ...input, tls: { rejectUnauthorized: false } }),
    /TLS/,
  );
});

test("gRPC project APIs persist definitions, real results, cancellation and failed evidence without transport secrets", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const { Store } = await import("../src/runtime.mjs");
  const remote = await fixture(t),
    root = await mkdtemp(join(tmpdir(), "grpc-api-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("gRPC backend"),
    second = await app.store.create("Other project");
  const base = app.url + "/api/projects/" + project.id,
    headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
  const post = (action, data, override = {}) =>
    fetch(base + "/" + action, {
      method: "POST",
      headers: { ...headers, ...override },
      body: JSON.stringify(data),
    });
  const source = {
    name: "gRPC fixture",
    target: remote.target,
    proto,
    service: "fixture.Echo",
    method: "Unary",
  };
  assert.equal(
    (
      await post("grpc-definitions", source, {
        Origin: "https://untrusted.example",
      })
    ).ok,
    false,
  );
  const denied = await fetch(base + "/grpc-definitions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(source),
  });
  assert.equal(denied.ok, false);
  const discovered = await post("grpc-schema", { proto });
  assert.equal(discovered.status, 200);
  assert.equal((await discovered.json()).services[0].methods.length, 7);
  const created = await post("grpc-definitions", source);
  assert.equal(created.status, 200);
  const { definition } = await created.json();
  assert.equal(
    (await new Store(root).get(project.id)).settings.grpcDefinitions[0].id,
    definition.id,
  );
  const before = await app.store.get(project.id);
  assert.equal(
    (
      await post("grpc-definitions", {
        ...definition,
        proto: 'syntax="proto3"; import "../secret.proto";',
      })
    ).ok,
    false,
  );
  assert.equal((await app.store.get(project.id)).revision, before.revision);
  const foreign = await fetch(
    app.url + "/api/projects/" + second.id + "/grpc-run",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ definitionId: definition.id, messages: [{}] }),
    },
  );
  assert.equal(foreign.ok, false);
  const request = {
    definitionId: definition.id,
    messages: [{ text: "persist", big: "9007199254740993" }],
    metadata: [{ key: "authorization", value: "fixture-secret" }],
  };
  const executed = await post("grpc-run", request);
  assert.equal(executed.status, 200);
  const result = await executed.json();
  assert.equal(result.status.code, 0);
  let saved = await new Store(root).get(project.id);
  assert.equal(saved.protocolRuns[0].id, result.recordId);
  assert.equal(saved.protocolRuns[0].status, "passed");
  assert.equal(
    saved.protocolRuns[0].result.messages[0].big,
    "9007199254740993",
  );
  assert.equal(JSON.stringify(saved).includes("fixture-secret"), false);
  const runCount = saved.protocolRuns.length;
  const stale = structuredClone(saved);
  const failed = await post("grpc-run", {
    definitionId: definition.id,
    method: "Fail",
  });
  assert.equal((await failed.json()).status.code, 7);
  stale.name = "Renamed";
  await app.store.save(stale);
  saved = await new Store(root).get(project.id);
  assert.equal(
    saved.protocolRuns.length,
    runCount + 1,
    "configuration save retains concurrent protocol activity",
  );
  assert.equal(saved.protocolRuns[0].status, "failed");
  const pending = post("grpc-run", {
    definitionId: definition.id,
    method: "Slow",
    runId: "cancel-grpc",
    timeoutMs: 2000,
  });
  await remote.slowStarted;
  assert.equal(
    (
      await post("grpc-run", {
        definitionId: definition.id,
        runId: "cancel-grpc",
      })
    ).ok,
    false,
  );
  await fetch(app.url + "/api/cancel", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "cancel-grpc" }),
  });
  const cancelled = await (await pending).json();
  assert.equal(cancelled.status.code, 1);
  assert.equal(
    (await new Store(root).get(project.id)).protocolRuns[0].status,
    "cancelled",
  );
  const history = await fetch(base + "/grpc-runs", { headers });
  assert.equal(history.status, 200);
  assert((await history.json()).length >= 3);
  const backup = await new Store(root).get(project.id);
  const restoredResponse = await fetch(app.url + "/api/restore", {
    method: "POST",
    headers,
    body: JSON.stringify({ document: backup }),
  });
  assert.equal(restoredResponse.status, 201);
  const restored = await restoredResponse.json();
  assert.notEqual(restored.id, project.id);
  assert.deepEqual(
    restored.settings.grpcDefinitions,
    backup.settings.grpcDefinitions,
  );
  assert.deepEqual(restored.protocolRuns, backup.protocolRuns);
  const originalAppend = app.store.append.bind(app.store),
    beforeRequests = remote.seen.length;
  app.store.append = async (key, field, ...args) => {
    if (field === "protocolRuns") throw Error("fixture disk failure");
    return originalAppend(key, field, ...args);
  };
  try {
    const unsaved = await post("grpc-run", request);
    assert.equal(unsaved.status, 200);
    const value = await unsaved.json();
    assert.equal(value.status.code, 0);
    assert.equal(value.recordSaved, false);
    assert.equal(value.recordId, null);
    assert.match(value.persistenceError, /fixture disk failure/);
    assert.equal(
      remote.seen.length,
      beforeRequests + 1,
      "storage failure must not replay the RPC",
    );
  } finally {
    app.store.append = originalAppend;
  }
  const removed = await fetch(base + "/grpc-definitions", {
    method: "DELETE",
    headers,
    body: JSON.stringify({ id: definition.id }),
  });
  assert.equal(removed.status, 200);
  saved = await new Store(root).get(project.id);
  assert.equal(saved.settings.grpcDefinitions.length, 0);
  assert(
    saved.protocolRuns.length >= 3,
    "deleting a definition preserves execution snapshots",
  );
});

test("gRPC rejects missing proto2 required values and invalid Unicode before transport", async () => {
  const required =
    'syntax="proto2"; package strict; message Input {required int32 value=1;} service Service {rpc Send(Input) returns(Input);}';
  await assert.rejects(
    executeGrpc({
      target: "grpc://127.0.0.1:1",
      proto: required,
      service: "strict.Service",
      method: "Send",
      messages: [{}],
    }),
    /必填/,
  );
  await assert.rejects(
    executeGrpc({
      target: "grpc://127.0.0.1:1",
      proto,
      service: "fixture.Echo",
      method: "Unary",
      messages: [{ text: "\ud800" }],
    }),
    /Unicode/,
  );
});

test("gRPC backend concurrency slots are bounded and released after cancellation", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const remote = await fixture(t),
    root = await mkdtemp(join(tmpdir(), "grpc-slots-")),
    app = await createApp({ root, port: 0 });
  const headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    },
    ids = Array.from({ length: 5 }, (_, i) => "slot-" + i),
    pending = [];
  const cancel = (id) =>
    fetch(app.url + "/api/cancel", {
      method: "POST",
      headers,
      body: JSON.stringify({ id }),
    });
  t.after(async () => {
    await Promise.all(ids.map(cancel));
    await Promise.allSettled(pending);
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Slots"),
    base = app.url + "/api/projects/" + project.id;
  const created = await fetch(base + "/grpc-definitions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      target: remote.target,
      proto,
      service: "fixture.Echo",
      method: "Slow",
      timeoutMs: 5000,
    }),
  });
  const { definition } = await created.json();
  const invoke = (runId, method = "Slow") =>
    fetch(base + "/grpc-run", {
      method: "POST",
      headers,
      body: JSON.stringify({ definitionId: definition.id, runId, method }),
    });
  for (const id of ids) pending.push(invoke(id));
  await remote.fiveStarted;
  const rejected = await invoke("sixth");
  assert.equal(rejected.ok, false);
  assert.match((await rejected.json()).error, /5个/);
  const discovery = await fetch(base + "/grpc-reflection", {
    method: "POST",
    headers,
    body: JSON.stringify({ target: remote.target, service: "fixture.Echo" }),
  });
  assert.equal(discovery.ok, false);
  assert.match((await discovery.json()).error, /5个/);
  await Promise.all(ids.map(cancel));
  for (const response of await Promise.all(pending))
    assert.equal((await response.json()).status.code, 1);
  const next = await invoke("after-cancel", "Unary");
  assert.equal(next.status, 200);
  assert.equal((await next.json()).status.code, 0);
});
