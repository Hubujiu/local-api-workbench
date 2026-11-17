import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { Store } from "../src/runtime.mjs";

const main = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));

test(
  "official SDK stdio accepts invalid-ID errors, never dispatches them, and preserves valid duplicate IDs",
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-stdio-errors-sdk-"));
    const store = new Store(root);
    const project = await store.create("Allowed");
    const before = await store.get(project.id);
    const client = new Client({ name: "stdio-error-sdk", version: "1" });
    const protocolErrors = [];
    client.onerror = (error) => protocolErrors.push(error.message);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [main, "--project", project.id, "--write"],
      env: { LOCAL_API_DATA: root },
      stderr: "pipe",
    });
    t.after(async () => {
      await client.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    });
    await client.connect(transport);

    // The transport's public send method permits wire-level conformance cases
    // without mutating the SDK client's private request counter or process.
    const rawCall = async (id, method = "tools/call") => {
      const previousMessage = transport.onmessage;
      const previousError = transport.onerror;
      let timer;
      try {
        const response = new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(Error("SDK error response timeout")),
            5000,
          );
          transport.onmessage = (message) => {
            if (
              message.id === id ||
              (!Object.hasOwn(message, "id") && message.error)
            )
              resolve(message);
            else previousMessage?.(message);
          };
          transport.onerror = (error) => {
            previousError?.(error);
            reject(
              Error("Official SDK rejected server response: " + error.message),
            );
          };
        });
        await transport.send({
          jsonrpc: "2.0",
          id,
          method,
          ...(method === "tools/call"
            ? {
                params: {
                  name: "localapi_create_project",
                  arguments: { name: "MUST NOT BE CREATED" },
                },
              }
            : {}),
        });
        return await response;
      } finally {
        clearTimeout(timer);
        transport.onmessage = previousMessage;
        transport.onerror = previousError;
      }
    };
    for (const id of [
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      {},
      [],
      true,
      "x".repeat(257),
      "界".repeat(86),
    ]) {
      const response = await rawCall(id);
      assert.equal(Object.hasOwn(response, "id"), false);
      assert.equal(response.error.code, -32600);
      assert(Buffer.byteLength(JSON.stringify(response)) < 4096);
      assert.equal((await store.list()).length, 1);
      assert.deepEqual(await store.get(project.id), before);
      await client.ping();
    }

    // The SDK initialized using numeric zero. Reusing that valid ID must echo
    // zero, not lose it through truthiness/defaulting or dispatch a mutation.
    const zero = await rawCall(0);
    assert.equal(zero.id, 0);
    assert.equal(zero.error.code, -32600);
    await client.ping();
    const empty = await rawCall("", "ping");
    assert.equal(empty.id, "");
    assert.deepEqual(empty.result, {});
    const duplicateEmpty = await rawCall("");
    assert.equal(duplicateEmpty.id, "");
    assert.equal(duplicateEmpty.error.code, -32600);
    await client.ping();

    const listed = await client.callTool({
      name: "localapi_list_projects",
      arguments: {},
    });
    assert.notEqual(listed.isError, true);
    assert.deepEqual(
      JSON.parse(listed.content[0].text).map((item) => item.id),
      [project.id],
    );
    assert.deepEqual(protocolErrors, []);
    assert.equal((await store.list()).length, 1);
    assert.deepEqual(await store.get(project.id), before);
  },
);

test(
  "real stdio parse and schema errors are accepted by official SDK framing and do not dispatch tools",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-stdio-raw-errors-"));
    const store = new Store(root);
    const project = await store.create("Allowed");
    const before = await store.get(project.id);
    const child = spawn(
      process.execPath,
      [main, "--project", project.id, "--write"],
      {
        env: { LOCAL_API_DATA: root },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.stderr.resume();
    const buffer = new ReadBuffer();
    let waiting, framingError;
    const reject = (error) => {
      framingError = error;
      waiting?.reject(error);
    };
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      try {
        buffer.append(chunk);
        let message;
        while ((message = buffer.readMessage()) !== null) {
          if (!waiting) throw Error("Unsolicited stdio response");
          waiting.resolve(message);
          waiting = undefined;
        }
      } catch (error) {
        reject(
          Error("Official SDK framing rejected response: " + error.message),
        );
      }
    });
    child.stdin.on("error", reject);
    t.after(async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      await closed;
      clearTimeout(timer);
      await rm(root, { recursive: true, force: true });
    });
    const exchange = async (wire) => {
      if (framingError) throw framingError;
      let timer;
      try {
        const response = new Promise((resolve, reject) => {
          waiting = { resolve, reject };
          timer = setTimeout(
            () => reject(Error("Raw stdio response timeout")),
            5000,
          );
        });
        child.stdin.write(wire);
        return await response;
      } finally {
        clearTimeout(timer);
        waiting = undefined;
      }
    };
    const rpc = (id, method, params) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params ? { params } : {}),
      }) + "\n";
    const initialized = await exchange(
      rpc("init", "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stdio-frame-errors", version: "1" },
      }),
    );
    assert.equal(initialized.result.serverInfo.name, "local-api-workbench");
    let index = 0;
    for (const [wire, expectedCode] of [
      ['{"jsonrpc":"2.0",\n', -32700],
      ["not json\n", -32700],
      [
        '{"jsonrpc":"2.0","id":"incomplete","method":"tools/call","params":{"name":"localapi_create_project","arguments":{"name":"MUST NOT BE CREATED"}}\n',
        -32700,
      ],
      ["null\n", -32600],
      ["[]\n", -32600],
      ['{"jsonrpc":"2.0","id":"invalid-method","method":5}\n', -32600],
    ]) {
      const response = await exchange(wire);
      assert.equal(Object.hasOwn(response, "id"), false);
      assert.equal(response.error.code, expectedCode);
      assert(Buffer.byteLength(JSON.stringify(response)) < 4096);
      assert.equal((await store.list()).length, 1);
      assert.deepEqual(await store.get(project.id), before);
      const id = "ping-" + index++;
      const ping = await exchange(rpc(id, "ping"));
      assert.equal(ping.id, id);
      assert.deepEqual(ping.result, {});
    }
    const listed = await exchange(
      rpc("final-list", "tools/call", {
        name: "localapi_list_projects",
        arguments: {},
      }),
    );
    assert.notEqual(listed.result.isError, true);
    assert.deepEqual(
      JSON.parse(listed.result.content[0].text).map((item) => item.id),
      [project.id],
    );
    assert.equal(framingError, undefined);
    assert.equal((await store.list()).length, 1);
    assert.deepEqual(await store.get(project.id), before);
  },
);
