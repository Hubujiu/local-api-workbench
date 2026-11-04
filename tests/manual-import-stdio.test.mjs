import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serveMCPStdio } from "../src/mcp-stdio.mjs";
import { Store } from "../src/runtime.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const main = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const runtime = new URL("../src/runtime.mjs", import.meta.url).href;
const frame = (message) => JSON.stringify(message) + "\n";
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function waitFor(predicate) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error("Manual import stdio observation timed out");
}
async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function snapshot(directory) {
  const files = {};
  async function visit(at, prefix = "") {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await visit(path.join(at, entry.name), name + "/");
      else
        files[name] = (await readFile(path.join(at, entry.name))).toString(
          "base64",
        );
    }
  }
  await visit(directory);
  return files;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "manual-import-stdio-"));
  const store = new Store(root),
    project = await store.create("Stdio manual import");
  const denied = await store.create("Not granted");
  const clients = [],
    children = [],
    releases = [];
  let hits = 0;
  const peer = http.createServer((_req, res) => {
    hits++;
    res.end("must not run");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const release of releases) await release();
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    for (const child of children) child.kill();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const document = modernApipostFixture();
  document.global.envs[0].server_list[0].uri = `http://127.0.0.1:${peer.address().port}`;
  document.global.global_vars.shared.current_value = "stdio-private-value";
  const input = { format: "apipost", document, selection: { mode: "all" } };
  const args = ({ write = true, preload } = {}) => [
    ...(preload ? ["--import", pathToFileURL(preload).href] : []),
    main,
    "--project",
    project.id,
    ...(write ? ["--write"] : []),
  ];
  const connect = async (options) => {
    const client = new Client({
      name: "manual-import-stdio-sdk",
      version: "1",
    });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: args(options),
      env: { LOCAL_API_DATA: root },
      stderr: "pipe",
    });
    await client.connect(transport);
    return client;
  };
  const call = (client, name, extra = {}, options) =>
    client.callTool(
      {
        name: "localapi_" + name,
        arguments: { projectId: project.id, input, ...extra },
      },
      undefined,
      options,
    );
  return {
    root,
    store,
    project,
    denied,
    input,
    args,
    connect,
    call,
    releases,
    children,
    hits: () => hits,
  };
}

test(
  "stdio supplies stable host session bindings and cancels both import tools without execution activities",
  { timeout: 12000 },
  async () => {
    const bindings = [],
      signals = [],
      activities = [];
    for (let instance = 0; instance < 2; instance++) {
      const input = new PassThrough(),
        output = new PassThrough();
      let text = "";
      output.on("data", (chunk) => {
        text += chunk;
      });
      const seen = [];
      const serving = serveMCPStdio({
        input,
        output,
        dispatch: async (message, context) => {
          seen.push(message.id);
          bindings.push(context.manualImportSessionId);
          signals.push(context.signal);
          assert(context.signal instanceof AbortSignal);
          if (!context.signal.aborted)
            await new Promise((resolve) =>
              context.signal.addEventListener("abort", resolve, { once: true }),
            );
          return {
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: "{}" }] },
          };
        },
        activityFactory(message) {
          activities.push(message);
        },
      });
      for (const [id, name] of [
        [0, "localapi_preview_import"],
        [1, "localapi_apply_import"],
      ])
        input.write(
          frame({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: {} },
          }),
        );
      await waitFor(() => seen.length === 2);
      input.write(
        frame({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 0 },
        }),
      );
      await waitFor(() => signals.at(-2).aborted);
      assert.equal(signals.at(-1).aborted, false);
      input.end();
      await serving;
      assert.equal(signals.at(-1).aborted, true);
      assert(
        !text
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
          .some((message) => message.id === 0),
      );
    }
    assert.equal(bindings[0], bindings[1]);
    assert.equal(bindings[2], bindings[3]);
    assert.notEqual(bindings[0], bindings[2]);
    assert.deepEqual(activities, []);
  },
);

test(
  "official stdio SDK read scope previews without writes; per-process identity prevents token replay",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t);
    const readOnly = await f.connect({ write: false });
    const before = await snapshot(f.store.directory(f.project.id));
    const tools = (await readOnly.listTools()).tools;
    assert(tools.some((tool) => tool.name === "localapi_preview_import"));
    assert(!tools.some((tool) => tool.name === "localapi_apply_import"));
    const preview = decode(await f.call(readOnly, "preview_import"));
    assert.equal(preview.blockers.length, 0);
    assert(!JSON.stringify(preview).includes("stdio-private-value"));
    assert.equal(
      (await f.call(readOnly, "apply_import", { token: preview.token }))
        .isError,
      true,
    );
    assert.equal(
      (await f.call(readOnly, "preview_import", { projectId: f.denied.id }))
        .isError,
      true,
    );
    assert.deepEqual(await snapshot(f.store.directory(f.project.id)), before);
    const writer = await f.connect();
    assert.equal(
      (await f.call(writer, "apply_import", { token: preview.token })).isError,
      true,
    );
    const fresh = decode(await f.call(writer, "preview_import"));
    for (const extra of [
      { sessionId: "forged" },
      { manualImportSessionId: "forged" },
      { input: { ...f.input, selection: { mode: "all", keys: [] } } },
      { input: { ...f.input, options: { parser: "json5" } } },
    ])
      assert.equal(
        (await f.call(writer, "apply_import", { token: fresh.token, ...extra }))
          .isError,
        true,
      );
    assert.deepEqual(await snapshot(f.store.directory(f.project.id)), before);
    const applied = decode(
      await f.call(writer, "apply_import", { token: fresh.token }),
    );
    assert.deepEqual(Object.keys(applied).sort(), [
      "configRevision",
      "counts",
      "noOp",
      "revision",
    ]);
    const saved = await new Store(f.root).get(f.project.id);
    assert.equal(saved.requests.length, 1);
    assert.equal(saved.globalVariables.shared, "stdio-private-value");
    assert(saved.requestDefinitionHistory.entries.length > 0);
    assert.equal(saved.history.length, 0);
    assert.equal(
      (await f.call(writer, "apply_import", { token: fresh.token })).isError,
      true,
    );
    assert.equal(f.hits(), 0);
    await writer.close();
    const restarted = await f.connect();
    assert.equal(
      (await f.call(restarted, "apply_import", { token: fresh.token })).isError,
      true,
    );
    assert.equal((await f.store.get(f.project.id)).requests.length, 1);
  },
);

test(
  "official stdio SDK explicit empty selection keeps all target bytes and revisions unchanged",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      client = await f.connect();
    const input = { ...f.input, selection: { mode: "explicit", keys: [] } };
    const before = await snapshot(f.store.directory(f.project.id));
    const preview = decode(await f.call(client, "preview_import", { input }));
    assert.equal(preview.noOp, true);
    const applied = decode(
      await f.call(client, "apply_import", { input, token: preview.token }),
    );
    assert.equal(applied.noOp, true);
    assert.equal(applied.configRevision, f.project.configRevision);
    assert.deepEqual(await snapshot(f.store.directory(f.project.id)), before);
    assert.equal(f.hits(), 0);
  },
);

async function journalGate(f) {
  const directory = f.store.directory(f.project.id);
  const preload = path.join(f.root, "import-journal-gate.mjs");
  const entered = path.join(f.root, "gate-entered"),
    releaseFile = path.join(f.root, "gate-release");
  const aborted = path.join(f.root, "gate-aborted"),
    settled = path.join(f.root, "gate-settled");
  // Observe and delay the real filesystem publication. The wrapped Store method
  // invokes its original implementation and only records the real lease signal.
  await writeFile(
    preload,
    `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    import { setTimeout as delay } from "node:timers/promises";
    import { Store } from ${JSON.stringify(runtime)};
    const originalWrite = fs.promises.writeFile;
    const originalApply = Store.prototype.applyManualImport;
    Store.prototype.applyManualImport = async function (id, input, context) {
      const observe = () => originalWrite(${JSON.stringify(aborted)}, "aborted");
      context.signal.addEventListener("abort", observe, { once: true });
      try { return await originalApply.call(this, id, input, context); }
      finally {
        context.signal.removeEventListener("abort", observe);
        await originalWrite(${JSON.stringify(settled)}, "settled");
      }
    };
    let intercepted = false;
    fs.promises.writeFile = async function (file, ...args) {
      const result = await originalWrite.call(this, file, ...args);
      if (!intercepted && typeof file === "string" && path.dirname(file) === ${JSON.stringify(directory)} &&
          /^\\.transaction\\.json\\.[a-f0-9-]{36}\\.tmp$/i.test(path.basename(file))) {
        intercepted = true;
        await originalWrite(${JSON.stringify(entered)}, "entered");
        while (true) {
          try { await fs.promises.readFile(${JSON.stringify(releaseFile)}); break; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
          await delay(10);
        }
      }
      return result;
    };
    syncBuiltinESMExports();
  `,
  );
  const release = () => writeFile(releaseFile, "release");
  f.releases.push(release);
  return { preload, entered, aborted, settled, release };
}

test(
  "official stdio SDK cancellation aborts real manual apply before journal publication",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t),
      gate = await journalGate(f);
    const client = await f.connect({ preload: gate.preload });
    const before = await snapshot(f.store.directory(f.project.id));
    const preview = decode(await f.call(client, "preview_import"));
    const controller = new AbortController();
    const rejected = assert.rejects(
      f.call(
        client,
        "apply_import",
        { token: preview.token },
        { signal: controller.signal },
      ),
      /abort|cancel/i,
    );
    await waitFor(() => exists(gate.entered));
    await assert.rejects(
      readFile(path.join(f.store.directory(f.project.id), ".transaction.json")),
      { code: "ENOENT" },
    );
    controller.abort();
    await rejected;
    await waitFor(() => exists(gate.aborted));
    await gate.release();
    await waitFor(() => exists(gate.settled));
    await client.ping();
    assert.deepEqual(await snapshot(f.store.directory(f.project.id)), before);
    assert.equal((await f.store.get(f.project.id)).requests.length, 0);
    assert.equal(f.hits(), 0);
    const fresh = decode(await f.call(client, "preview_import"));
    decode(await f.call(client, "apply_import", { token: fresh.token }));
    assert.equal((await f.store.get(f.project.id)).requests.length, 1);
  },
);

test(
  "real stdio EOF aborts manual apply and waits for Store cleanup before process exit",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t),
      gate = await journalGate(f);
    const child = spawn(process.execPath, f.args({ preload: gate.preload }), {
      env: { ...process.env, LOCAL_API_DATA: f.root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    f.children.push(child);
    let bytes = "",
      stderr = "";
    const messages = [];
    child.stdout.on("data", (chunk) => {
      bytes += chunk;
      while (bytes.includes("\n")) {
        const index = bytes.indexOf("\n");
        messages.push(JSON.parse(bytes.slice(0, index)));
        bytes = bytes.slice(index + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.write(
      frame({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    );
    await waitFor(() => messages.some((message) => message.id === 0));
    const call = (id, name, extra = {}) =>
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "localapi_" + name,
            arguments: { projectId: f.project.id, input: f.input, ...extra },
          },
        }),
      );
    const before = await snapshot(f.store.directory(f.project.id));
    call(1, "preview_import");
    await waitFor(() => messages.some((message) => message.id === 1));
    const preview = decode(messages.find((message) => message.id === 1).result);
    call(2, "apply_import", { token: preview.token });
    await waitFor(() => exists(gate.entered));
    child.stdin.end();
    await waitFor(() => exists(gate.aborted));
    await gate.release();
    assert.equal(await exited, 0, stderr);
    assert(await exists(gate.settled));
    assert.equal(
      messages.find((message) => message.id === 2)?.result.isError,
      true,
    );
    assert.deepEqual(await snapshot(f.store.directory(f.project.id)), before);
    assert.equal(
      (await new Store(f.root).get(f.project.id)).requests.length,
      0,
    );
    assert.equal(f.hits(), 0);
  },
);
