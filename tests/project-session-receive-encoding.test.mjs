import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { createMCP } from "../src/mcp.mjs";

const binary = Buffer.from([0, 255, 195, 40, 128, 1]);
const unicode = Buffer.from("中文😀");
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("session encoding fixture timeout");
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "session-encoding-"));
  let app = await createApp({ root, port: 0 });
  const sockets = new Set(),
    received = [];
  let connections = 0;
  const tcp = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", (bytes) => {
      received.push(Buffer.from(bytes));
      const message = bytes.toString();
      if (message === "hold") socket.write(binary);
      else socket.end(message === "text" ? unicode : binary);
    });
  });
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const p = await app.store.create("encoding"),
    other = await app.store.create("other");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => tcp.close(resolve));
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  async function request(tail, body, projectId = p.id) {
    const response = await fetch(
      app.url + "/api/projects/" + projectId + "/protocol-sessions" + tail,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, value: await response.json() };
  }
  return {
    root,
    p,
    other,
    received,
    request,
    app: () => app,
    connections: () => connections,
    input: { type: "tcp", host: "127.0.0.1", port: tcp.address().port },
    async restart() {
      await app.close();
      app = await createApp({ root, port: 0 });
    },
    async run(input, message = "binary", stop = false) {
      const started = await request("", input);
      assert.equal(started.status, 200, JSON.stringify(started));
      const id = started.value.id;
      await until(async () => (await request("/" + id)).value.state === "open");
      const sent = await request("/" + id + "/send", { message });
      assert.equal(sent.status, 200);
      if (stop) {
        await until(async () =>
          (await request("/" + id)).value.events.some(
            (e) => e.direction === "received",
          ),
        );
        await request("/" + id + "/stop", {});
      }
      await until(async () => (await request("/" + id)).value.recordSaved);
      return (await app.store.get(p.id)).protocolRuns.find((r) => r.id === id);
    },
  };
}
function assertBytes(record, encoding, expected) {
  const events = record.result.events.filter((e) => e.direction === "received");
  assert(events.length > 0);
  for (const event of events) assert.equal(event.encoding, encoding);
  assert.deepEqual(
    Buffer.concat(events.map((e) => Buffer.from(e.data, encoding))),
    expected,
  );
}
async function detail(store, projectId, recordId, projects = [projectId]) {
  const mcp = createMCP({ store, projects });
  return mcp({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_get_protocol_run",
      arguments: { projectId, recordId },
    },
  });
}

test("explicit project TCP receive encodings preserve actual bytes through restore and restart", async (t) => {
  const f = await fixture(t),
    records = [];
  for (const encoding of ["hex", "base64", "utf8", undefined]) {
    const message =
      encoding === "hex" || encoding === "base64" ? "binary" : "text";
    const record = await f.run(
      { ...f.input, ...(encoding ? { receiveEncoding: encoding } : {}) },
      message,
    );
    assertBytes(
      record,
      encoding || "utf8",
      message === "binary" ? binary : unicode,
    );
    assert.equal(record.definition.receiveEncoding, encoding);
    assert.equal(record.status, "completed");
    records.push(record);
  }
  assert.deepEqual(f.received, [
    Buffer.from("binary"),
    Buffer.from("binary"),
    Buffer.from("text"),
    Buffer.from("text"),
  ]);
  const before = f.connections(),
    saved = await f.app().store.get(f.p.id);
  const response = await fetch(f.app().url + "/api/restore", {
    method: "POST",
    headers: {
      "x-local-token": f.app().token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ document: saved }),
  });
  assert.equal(response.status, 201);
  const copy = await response.json();
  assert.deepEqual(copy.protocolRuns, saved.protocolRuns);
  await f.restart();
  for (const project of [f.p, copy]) {
    const disk = await new Store(f.root).get(project.id);
    assert.deepEqual(disk.protocolRuns, saved.protocolRuns);
    for (const record of records) {
      const result = await detail(f.app().store, project.id, record.id);
      assert.equal(result.result.isError, undefined, JSON.stringify(result));
      assert.deepEqual(JSON.parse(result.result.content[0].text), record);
    }
  }
  const denied = await detail(f.app().store, f.p.id, records[0].id, [
    f.other.id,
  ]);
  assert.equal(denied.result.isError, true);
  assert.equal(
    f.connections(),
    before,
    "restore/readback never opens another socket",
  );
  assert.equal((await f.app().store.get(f.other.id)).protocolRuns.length, 0);
});

test("invalid explicit TCP receive encoding is rejected before opening or storing a session", async (t) => {
  const f = await fixture(t),
    before = await f.app().store.get(f.p.id);
  for (const receiveEncoding of ["HEX", "latin1", "", null, false, 0, {}, []]) {
    const response = await f.request("", { ...f.input, receiveEncoding });
    assert.equal(response.status, 400, JSON.stringify(response));
    assert.match(response.value.error, /接收编码无效/);
    assert.deepEqual(await f.app().store.get(f.p.id), before);
  }
  assert.equal(f.connections(), 0);
  assert.deepEqual(f.received, []);
  // Invalid calls must not consume any of the five live-session slots either.
  const record = await f.run({ ...f.input, receiveEncoding: "hex" });
  assertBytes(record, "hex", binary);
  assert.equal(f.connections(), 1);
});

test("saved receive encoding stays authoritative including its absent default", async (t) => {
  const f = await fixture(t),
    p = await f.app().store.get(f.p.id);
  p.protocols = [
    {
      id: "hex",
      type: "tcp",
      url: f.input.host,
      port: f.input.port,
      receiveEncoding: "hex",
    },
    { id: "default", type: "tcp", url: f.input.host, port: f.input.port },
  ];
  await f.app().store.save(p);
  const hex = await f.run({ definitionId: "hex", receiveEncoding: "base64" });
  assertBytes(hex, "hex", binary);
  assert.equal(hex.definition.receiveEncoding, "hex");
  const fallback = await f.run(
    { definitionId: "default", receiveEncoding: "hex" },
    "text",
  );
  assertBytes(fallback, "utf8", unicode);
  assert.equal(fallback.definition.receiveEncoding, undefined);
  assert.deepEqual(
    (await f.app().store.get(f.p.id)).protocols,
    (await new Store(f.root).get(f.p.id)).protocols,
  );
});

test("manual TCP stop preserves binary evidence and refused connections preserve encoding without replay", async (t) => {
  const f = await fixture(t);
  const record = await f.run(
    { ...f.input, receiveEncoding: "base64" },
    "hold",
    true,
  );
  assertBytes(record, "base64", binary);
  assert.equal(record.status, "partial");
  assert.equal(record.result.closeReason, "manual");
  const again = await f.request("/" + record.id + "/stop", {});
  assert.equal(again.value.recordSaved, true);
  assert.equal(f.connections(), 1);
  assert.deepEqual(f.received, [Buffer.from("hold")]);
  const vacant = net.createServer();
  vacant.listen(0, "127.0.0.1");
  await once(vacant, "listening");
  const port = vacant.address().port;
  await new Promise((resolve) => vacant.close(resolve));
  const started = await f.request("", {
    ...f.input,
    port,
    receiveEncoding: "hex",
  });
  assert.equal(started.status, 200);
  const id = started.value.id;
  const terminal = await until(async () => {
    const value = (await f.request("/" + id)).value;
    return value.recordSaved && value;
  });
  assert.equal(terminal.state, "error");
  const saved = await f.app().store.get(f.p.id);
  const failed = saved.protocolRuns.find((r) => r.id === id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.definition.receiveEncoding, "hex");
  assert.equal(
    failed.result.events.filter((e) => e.direction === "received").length,
    0,
  );
  assert.equal(failed.result.closeReason, "error");
  await f.restart();
  assert.deepEqual(
    (await new Store(f.root).get(f.p.id)).protocolRuns,
    saved.protocolRuns,
  );
  assert.equal(f.connections(), 1);
  assert.deepEqual(f.received, [Buffer.from("hold")]);
});
