import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  rename,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
import { Store } from "../src/runtime.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error("Manual import observation timed out");
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
async function fixture(t, write = true) {
  const root = await mkdtemp(path.join(tmpdir(), "manual-import-mcp-"));
  const app = await createApp({ root, port: 0 });
  const connections = [];
  const releases = [];
  let hits = 0;
  const peer = http.createServer((_req, res) => {
    hits++;
    res.end("import must not execute");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const release of releases) release();
    await Promise.all(
      connections.map(({ client }) => client.close().catch(() => {})),
    );
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all(
      [app.server, peer].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Manual import allowed");
  const denied = await app.store.create("Manual import denied");
  const owner = async (route, body) => {
    const response = await fetch(app.url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const grant = {
    enabled: true,
    remember: false,
    projects: [project.id],
    write,
    execute: false,
  };
  const config = await owner("/api/mcp/config", grant);
  const connect = async () => {
    const client = new Client({ name: "manual-import-sdk", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(app.url + "/mcp"),
      {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      },
    );
    const connection = { client, transport };
    connections.push(connection);
    await client.connect(transport);
    return connection;
  };
  const document = modernApipostFixture();
  document.global.envs[0].server_list[0].uri = `http://127.0.0.1:${peer.address().port}`;
  document.global.global_vars.shared.current_value =
    "manual-import-private-value";
  const input = { format: "apipost", document, selection: { mode: "all" } };
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
    app,
    project,
    denied,
    config,
    grant,
    owner,
    connect,
    input,
    call,
    releases,
    hits: () => hits,
  };
}

test(
  "official HTTP MCP read-only preview is complete, private, session-bound and non-mutating",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, false);
    const { client } = await f.connect();
    const tools = (await client.listTools()).tools;
    const previewTool = tools.find(
      (tool) => tool.name === "localapi_preview_import",
    );
    assert(previewTool);
    assert.deepEqual(previewTool.inputSchema.required, ["projectId", "input"]);
    assert.equal(previewTool.inputSchema.additionalProperties, false);
    assert(!tools.some((tool) => tool.name === "localapi_apply_import"));
    const before = await snapshot(f.app.store.directory(f.project.id));
    const preview = decode(await f.call(client, "preview_import"));
    assert.equal(preview.version, 1);
    assert.equal(preview.configRevision, f.project.configRevision);
    assert.equal(typeof preview.token, "string");
    assert.deepEqual(preview.blockers, []);
    assert(
      preview.items.some(
        (item) => item.kind === "api" && item.action === "create",
      ),
    );
    assert(!JSON.stringify(preview).includes("manual-import-private-value"));
    assert(Buffer.byteLength(JSON.stringify(preview)) <= 2 * 1024 * 1024);
    assert.equal(
      (await f.call(client, "apply_import", { token: preview.token })).isError,
      true,
    );
    assert.equal(
      (await f.call(client, "preview_import", { projectId: f.denied.id }))
        .isError,
      true,
    );
    assert.deepEqual(
      await snapshot(f.app.store.directory(f.project.id)),
      before,
    );
    assert.equal(f.hits(), 0);
    const response = await fetch(f.app.url + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + f.config.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "sessionless",
        method: "tools/call",
        params: {
          name: "localapi_preview_import",
          arguments: { projectId: f.project.id, input: f.input },
        },
      }),
    });
    const rejected = await response.json();
    assert(
      response.status !== 200 ||
        rejected.result?.isError === true ||
        rejected.error,
    );
    assert.deepEqual(
      await snapshot(f.app.store.directory(f.project.id)),
      before,
    );
  },
);

test(
  "official HTTP MCP applies only the same session/source/configuration and exposes no saved credentials",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.connect(),
      second = await f.connect();
    assert.notEqual(first.transport.sessionId, second.transport.sessionId);
    const before = await snapshot(f.app.store.directory(f.project.id));
    const preview = decode(await f.call(first.client, "preview_import"));
    for (const [client, extra] of [
      [second.client, {}],
      [first.client, { sessionId: "forged" }],
      [first.client, { manualImportSessionId: "forged" }],
      [
        first.client,
        { input: { ...f.input, selection: { mode: "explicit", keys: [] } } },
      ],
      [first.client, { input: { ...f.input, policies: { api: "ignore" } } }],
      [first.client, { token: preview.token + "x" }],
    ]) {
      assert.equal(
        (
          await f.call(client, "apply_import", {
            token: preview.token,
            ...extra,
          })
        ).isError,
        true,
      );
      assert.deepEqual(
        await snapshot(f.app.store.directory(f.project.id)),
        before,
      );
    }
    const applied = decode(
      await f.call(first.client, "apply_import", { token: preview.token }),
    );
    assert.deepEqual(Object.keys(applied).sort(), [
      "configRevision",
      "counts",
      "noOp",
      "revision",
    ]);
    assert.equal(applied.configRevision, f.project.configRevision + 1);
    assert.equal(applied.noOp, false);
    const saved = await new Store(f.root).get(f.project.id);
    assert.equal(saved.requests.length, 1);
    assert.equal(saved.globalVariables.shared, "manual-import-private-value");
    assert(saved.requestDefinitionHistory.entries.length > 0);
    assert.equal(saved.history.length, 0);
    assert.equal(f.hits(), 0);
    assert.equal(
      (await f.call(first.client, "apply_import", { token: preview.token }))
        .isError,
      true,
    );
    assert.equal((await f.app.store.get(f.project.id)).requests.length, 1);
  },
);

test(
  "HTTP MCP delegates strict nested input checks and supports explicit empty no-op without revisions",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      { client } = await f.connect();
    const before = await snapshot(f.app.store.directory(f.project.id));
    for (const input of [
      { ...f.input, selection: undefined },
      { ...f.input, selection: { mode: "all", keys: [] } },
      { ...f.input, selection: { mode: "explicit", keys: ["api:x", "api:x"] } },
      { ...f.input, policies: { environments: "name" } },
      { ...f.input, options: { parser: "json5" } },
      { ...f.input, sessionId: "forged-nested-identity" },
    ])
      assert.equal(
        (await f.call(client, "preview_import", { input })).isError,
        true,
      );
    const input = { ...f.input, selection: { mode: "explicit", keys: [] } };
    const preview = decode(await f.call(client, "preview_import", { input }));
    assert.equal(preview.noOp, true);
    const applied = decode(
      await f.call(client, "apply_import", { input, token: preview.token }),
    );
    assert.equal(applied.noOp, true);
    assert.equal(applied.configRevision, f.project.configRevision);
    assert.deepEqual(
      await snapshot(f.app.store.directory(f.project.id)),
      before,
    );
  },
);

test(
  "direct MCP requires host session context and rejects envelope getters without invoking them",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const dispatch = createMCP({
      store: f.app.store,
      projects: [f.project.id],
      write: true,
    });
    const message = (args, id = 1) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "localapi_preview_import",
        arguments: args,
      },
    });
    const before = await snapshot(f.app.store.directory(f.project.id));
    assert.equal(
      (await dispatch(message({ projectId: f.project.id, input: f.input })))
        .result.isError,
      true,
    );
    let reads = 0;
    const accessor = { projectId: f.project.id };
    Object.defineProperty(accessor, "input", {
      enumerable: true,
      get() {
        reads++;
        return f.input;
      },
    });
    assert.equal(
      (
        await dispatch(message(accessor), {
          manualImportSessionId: "host-test-session",
        })
      ).result.isError,
      true,
    );
    assert.equal(reads, 0);
    for (const id of [{}, [], null, 0.5, "x".repeat(257)]) {
      const result = await dispatch(
        message({ projectId: f.project.id, input: f.input }, id),
        { manualImportSessionId: "host-test-session" },
      );
      assert.equal(result.error.code, -32600);
      assert.equal(Object.hasOwn(result, "id"), false);
    }
    assert.deepEqual(
      await snapshot(f.app.store.directory(f.project.id)),
      before,
    );
  },
);

// The real Store has already written its journal temporary, but has not crossed
// its last signal gate or published the journal. No mocked Store result is used.
async function gateJournal(t, directory) {
  const entered = deferred(),
    release = deferred();
  const original = fs.promises.writeFile;
  let intercepted = false;
  const mocked = t.mock.method(
    fs.promises,
    "writeFile",
    async function (file, ...args) {
      const result = await original.call(this, file, ...args);
      if (
        !intercepted &&
        typeof file === "string" &&
        path.dirname(file) === directory &&
        /^\.transaction\.json\.[a-f0-9-]{36}\.tmp$/i.test(path.basename(file))
      ) {
        intercepted = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    release.resolve();
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return { entered: entered.promise, release: release.resolve };
}

for (const mode of [
  "cancel",
  "delete-session",
  "revoke-write",
  "revoke-project",
  "close-server",
])
  test(
    `official HTTP MCP ${mode} aborts manual apply at the last pre-publication gate`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t),
        { client, transport } = await f.connect();
      const directory = f.app.store.directory(f.project.id);
      const before = await snapshot(directory);
      const preview = decode(await f.call(client, "preview_import"));
      const gate = await gateJournal(t, directory);
      f.releases.push(gate.release);
      let importSignal;
      const settled = deferred();
      const originalApply = f.app.store.applyManualImport.bind(f.app.store);
      t.mock.method(
        f.app.store,
        "applyManualImport",
        (projectId, input, context) => {
          importSignal = context.signal;
          return originalApply(projectId, input, context).finally(
            settled.resolve,
          );
        },
      );
      const controller = new AbortController();
      const outcome = f
        .call(
          client,
          "apply_import",
          { token: preview.token },
          { signal: controller.signal },
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      await gate.entered;
      await assert.rejects(
        readFile(path.join(directory, ".transaction.json")),
        { code: "ENOENT" },
      );
      let changed;
      if (mode === "cancel") controller.abort();
      else if (mode === "delete-session") {
        const response = await fetch(f.app.url + "/mcp", {
          method: "DELETE",
          headers: {
            Authorization: "Bearer " + f.config.token,
            "mcp-session-id": transport.sessionId,
          },
        });
        assert.equal(response.status, 204);
      } else if (mode === "close-server") {
        changed = new Promise((resolve) => f.app.server.close(resolve));
      } else {
        changed = f.owner("/api/mcp/config", {
          ...f.grant,
          ...(mode === "revoke-write" ? { write: false } : { projects: [] }),
        });
        await waitFor(async () => {
          const config = await f.owner("/api/mcp/config");
          return mode === "revoke-write"
            ? !config.write
            : config.projects.length === 0;
        });
      }
      // SDK cancellation is delivered by a separate notification. Observe the
      // host's leased signal before allowing its real write to continue.
      await waitFor(() => importSignal?.aborted);
      gate.release();
      const result = await outcome;
      await settled.promise;
      if (changed) await changed;
      assert(result.error || result.value?.isError === true);
      assert.deepEqual(await snapshot(directory), before);
      assert.deepEqual(await new Store(f.root).get(f.project.id), f.project);
      assert.equal(f.hits(), 0);
    },
  );

test(
  "authorization epoch changes invalidate a prior preview even after write is restored",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      { client } = await f.connect();
    const preview = decode(await f.call(client, "preview_import"));
    await f.owner("/api/mcp/config", { ...f.grant, write: false });
    await f.owner("/api/mcp/config", f.grant);
    assert.equal(
      (await f.call(client, "apply_import", { token: preview.token })).isError,
      true,
    );
    assert.equal((await f.app.store.get(f.project.id)).requests.length, 0);
    const fresh = decode(await f.call(client, "preview_import"));
    decode(await f.call(client, "apply_import", { token: fresh.token }));
    assert.equal((await f.app.store.get(f.project.id)).requests.length, 1);
  },
);

test(
  "HTTP MCP preserves uncertain-commit metadata and recovery imports exactly once after a real publication fault",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      { client } = await f.connect();
    const preview = decode(await f.call(client, "preview_import"));
    const directory = f.app.store.directory(f.project.id);
    const journalFile = path.join(directory, ".transaction.json");
    const history = path.join(directory, "history"),
      retained = path.join(directory, "history-retained");
    const original = fs.promises.rename;
    let injected = 0;
    const mocked = t.mock.method(
      fs.promises,
      "rename",
      async function (source, destination) {
        const result = await original.call(this, source, destination);
        if (!injected && destination === journalFile) {
          injected++;
          await original.call(this, history, retained);
          await writeFile(history, "physical post-publication history fault");
        }
        return result;
      },
    );
    syncBuiltinESMExports();
    let response;
    try {
      response = await f.call(client, "apply_import", { token: preview.token });
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(response.isError, true);
    const outcome = JSON.parse(response.content[0].text);
    assert.equal(outcome.code, "PROJECT_COMMIT_UNCERTAIN");
    assert.equal(outcome.project_id, f.project.id);
    assert.equal(outcome.commit_outcome, "unknown");
    assert.equal(outcome.retry_safe, false);
    assert(!JSON.stringify(response).includes("manual-import-private-value"));
    assert(!JSON.stringify(response).includes(f.root));
    assert(!JSON.stringify(response).includes(preview.token));
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    assert.equal(journal.requests.length, 1);
    await rm(history);
    await rename(retained, history);
    const recovered = await new Store(f.root).get(f.project.id);
    assert.equal(recovered.requests.length, 1);
    assert.equal(recovered.requests[0].id, journal.requests[0].id);
    assert.equal(recovered.configRevision, f.project.configRevision + 1);
    await assert.rejects(readFile(journalFile), { code: "ENOENT" });
    assert.equal(
      (await f.call(client, "apply_import", { token: preview.token })).isError,
      true,
    );
    assert.equal((await f.app.store.get(f.project.id)).requests.length, 1);
    assert.equal(injected, 1);
    assert.equal(f.hits(), 0);
  },
);
