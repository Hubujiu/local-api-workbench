import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";

const wireBytes = Buffer.from([0, 255, 195, 40, 128, 1, 222, 173]);
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("session SDK fixture timeout");
}
for (const transport of ["http", "stdio"]) {
  test(`${transport} SDK reads exact project TCP byte evidence after export restore and restart`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "session-encoding-sdk-"));
    let app = await createApp({ root, port: 0 }),
      connections = 0;
    const sockets = new Set(),
      received = [],
      clients = new Set();
    const peer = net.createServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.once("data", (bytes) => {
        received.push(Buffer.from(bytes));
        socket.end(wireBytes);
      });
    });
    peer.listen(0, "127.0.0.1");
    await once(peer, "listening");
    t.after(async () => {
      for (const client of clients) await client.close().catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => peer.close(resolve));
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    async function owner(route, body) {
      const response = await fetch(app.url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, value: await response.json() };
    }
    async function sdk(projectId) {
      const client = new Client(
        { name: "session-encoding-proof", version: "1.0.0" },
        { capabilities: {} },
      );
      clients.add(client);
      if (transport === "stdio") {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
              "--project",
              projectId,
            ],
            env: { LOCAL_API_DATA: root },
            stderr: "pipe",
          }),
        );
      } else {
        const configured = await owner("/api/mcp/config", {
          enabled: true,
          projects: [projectId],
          write: false,
          execute: false,
          remember: false,
        });
        assert.equal(configured.status, 200);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { Authorization: "Bearer " + configured.value.token },
            },
          }),
        );
      }
      return client;
    }
    const source = await app.store.create("source"),
      other = await app.store.create("other");
    const records = [];
    for (const receiveEncoding of ["hex", "base64"]) {
      const route = `/api/projects/${source.id}/protocol-sessions`;
      const start = await owner(route, {
        type: "tcp",
        host: "127.0.0.1",
        port: peer.address().port,
        receiveEncoding,
      });
      assert.equal(start.status, 200);
      const id = start.value.id;
      await until(
        async () => (await owner(route + "/" + id)).value.state === "open",
      );
      const sent = await owner(route + "/" + id + "/send", {
        message: receiveEncoding,
      });
      assert.equal(sent.status, 200);
      await until(
        async () => (await owner(route + "/" + id)).value.recordSaved,
      );
      const record = (await app.store.get(source.id)).protocolRuns.find(
        (item) => item.id === id,
      );
      assert.equal(record.definition.receiveEncoding, receiveEncoding);
      assert.equal(record.status, "completed");
      const events = record.result.events.filter(
        (event) => event.direction === "received",
      );
      assert(events.length);
      for (const event of events) assert.equal(event.encoding, receiveEncoding);
      assert.deepEqual(
        Buffer.concat(
          events.map((event) => Buffer.from(event.data, event.encoding)),
        ),
        wireBytes,
      );
      records.push(record);
    }
    assert.deepEqual(received, [Buffer.from("hex"), Buffer.from("base64")]);
    const backup = await owner(`/api/projects/${source.id}/export`);
    assert.equal(backup.status, 200);
    const restored = await owner("/api/restore", { document: backup.value });
    assert.equal(restored.status, 201);
    assert.deepEqual(restored.value.protocolRuns, backup.value.protocolRuns);
    const snapshot = structuredClone(backup.value.protocolRuns);
    await app.close();
    app = await createApp({ root, port: 0 });
    for (const projectId of [source.id, restored.value.id]) {
      assert.deepEqual(
        (await new Store(root).get(projectId)).protocolRuns,
        snapshot,
      );
      const client = await sdk(projectId);
      const list = decode(
        await client.callTool({
          name: "localapi_list_protocol_runs",
          arguments: { projectId },
        }),
      );
      assert.deepEqual(
        new Set(list.map((item) => item.id)),
        new Set(records.map((item) => item.id)),
      );
      assert(
        list.every(
          (item) =>
            !Object.hasOwn(item, "result") &&
            !Object.hasOwn(item, "definition"),
        ),
      );
      for (const expected of records) {
        const result = decode(
          await client.callTool({
            name: "localapi_get_protocol_run",
            arguments: { projectId, recordId: expected.id },
          }),
        );
        assert.deepEqual(result, expected);
        const bytes = result.result.events
          .filter((e) => e.direction === "received")
          .map((e) => Buffer.from(e.data, e.encoding));
        assert.deepEqual(Buffer.concat(bytes), wireBytes);
      }
      await client.close();
      clients.delete(client);
    }
    const deniedClient = await sdk(other.id);
    // Both target project and target record really exist; only the grant differs.
    assert(
      (await app.store.get(source.id)).protocolRuns.some(
        (record) => record.id === records[0].id,
      ),
    );
    const denied = await deniedClient.callTool({
      name: "localapi_get_protocol_run",
      arguments: { projectId: source.id, recordId: records[0].id },
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /未授权/);
    assert.deepEqual((await app.store.get(other.id)).protocolRuns, []);
    assert.equal(
      connections,
      2,
      "export, restore, restart and both MCP readback paths are inert",
    );
    assert.deepEqual(received, [Buffer.from("hex"), Buffer.from("base64")]);
  });
}
