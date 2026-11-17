import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, normalizeRequest } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { writeProject } from "../src/project-files.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";
import {
  MCP_PROJECT_DOCUMENT_BYTES,
  MCP_PROJECT_FRAME_BYTES,
} from "../src/mcp-project-interchange.mjs";

const formats = ["apipost", "apipost-directory"];
const secret = "scoped-sdk-fictional-secret";
const selected = (format = "apipost", id = "chosen") => ({
  format,
  selection: { mode: "explicit", resources: [{ kind: "api", id }] },
});
const accepted = (input, preview) => ({
  ...input,
  configRevision: preview.configRevision,
  scopeDigest: preview.scope.digest,
  acceptedDependencies: preview.scope.dependencies,
});
const decode = (response) => {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
};
const call = (client, projectId, name, input, options) =>
  client.callTool(
    { name: "localapi_" + name, arguments: { projectId, ...input } },
    undefined,
    options,
  );
async function waitFor(predicate) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  throw Error("Scoped export SDK observation timed out");
}
const exists = async (filename) => {
  try {
    await readFile(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
async function fixture(t) {
  let httpEffects = 0,
    databaseEffects = 0;
  const httpPeer = http.createServer((_req, res) => {
    httpEffects++;
    res.end("unexpected execution");
  });
  const databasePeer = net.createServer((socket) => {
    databaseEffects++;
    socket.destroy();
  });
  await Promise.all([
    new Promise((resolve) => httpPeer.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => databasePeer.listen(0, "127.0.0.1", resolve)),
  ]);
  const root = await mkdtemp(path.join(tmpdir(), "scoped-export-sdk-"));
  const app = await createApp({ root, port: 0 });
  const clients = [],
    beforeClose = [];
  t.after(async () => {
    for (const cleanup of beforeClose) await cleanup();
    for (const client of clients) await client.close().catch(() => {});
    await app.close();
    httpPeer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => httpPeer.close(resolve)),
      new Promise((resolve) => databasePeer.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${httpPeer.address().port}`;
  let project = await app.store.create("Scoped SDK source");
  project.folders = ["Parent", "Parent/Chosen", "Other"];
  project.globalVariables = { staticSecret: secret, scriptHits: "0" };
  project.requests = [
    normalizeRequest({
      id: "chosen",
      name: "Selected API",
      folder: "Parent/Chosen",
      method: "POST",
      url: base + "/chosen",
      bodyType: "json",
      body: '{"literal":"{{staticSecret}}"}',
      auth: { type: "basic", username: "fixture", password: secret },
      inheritSharedScripts: false,
      scriptDialect: "apipost8",
      nativeTasks: {
        version: 1,
        before: [
          {
            id: "inert-wait",
            name: "Stored wait",
            type: "wait",
            enabled: 1,
            data: 1,
          },
          {
            id: "inert-script",
            name: "Never execute during export",
            type: "customScript",
            enabled: 1,
            data: 'apt.globals.set("scriptHits", "1"); throw Error("export must not run scripts");',
          },
        ],
        after: [],
      },
    }),
    normalizeRequest({
      id: "other",
      name: "Unselected API",
      folder: "Other",
      url: base + "/other",
    }),
  ];
  project = await app.store.save(project);
  // Store has a real previous definition/history; full project equality below
  // protects it as well as live definitions, counters, revisions and settings.
  project.requests[0].name = "Selected API updated";
  project = await app.store.save(project);
  const peer = await app.store.create("Unchanged ungranted peer");
  const headers = {
    "x-local-token": app.token,
    "content-type": "application/json",
  };
  const owner = async (route, input) => {
    const response = await fetch(app.url + route, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  };
  const configure = async (projects = [project.id]) => {
    const response = await owner("/api/mcp/config", {
      enabled: true,
      projects,
      write: false,
      execute: false,
      remember: false,
    });
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return response.value;
  };
  const connect = async (kind, projectId = project.id, preload) => {
    const client = new Client({
      name: "scoped-definition-export-sdk",
      version: "1",
    });
    clients.push(client);
    const config = kind === "HTTP" ? await configure([projectId]) : undefined;
    const transport =
      kind === "HTTP"
        ? new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          })
        : new StdioClientTransport({
            command: process.execPath,
            args: [
              ...(preload ? ["--import", pathToFileURL(preload).href] : []),
              fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
              "--project",
              projectId,
            ],
            env: {
              LOCAL_API_DATA: root,
              ...(process.platform === "win32"
                ? { SystemRoot: process.env.SystemRoot }
                : {}),
            },
            stderr: "pipe",
          });
    // Observe genuine SDK transport messages; do not replace dispatch or data.
    const sends = [],
      received = [];
    const originalSend = transport.send;
    transport.send = function (...args) {
      const promise = Reflect.apply(originalSend, this, args);
      sends.push({ message: structuredClone(args[0]), promise });
      return promise;
    };
    await client.connect(transport);
    const originalOnmessage = transport.onmessage;
    transport.onmessage = function (message, ...args) {
      received.push(structuredClone(message));
      return Reflect.apply(originalOnmessage, this, [message, ...args]);
    };
    return { client, transport, sends, received };
  };
  return {
    app,
    root,
    project,
    peer,
    owner,
    configure,
    connect,
    base,
    databasePort: databasePeer.address().port,
    beforeClose(cleanup) {
      beforeClose.push(cleanup);
    },
    assertNoEffects() {
      assert.equal(httpEffects, 0, "definition work must not send HTTP");
      assert.equal(
        databaseEffects,
        0,
        "definition work must not connect to a database",
      );
    },
  };
}
function assertRefused(response) {
  assert.equal(response.isError, true, JSON.stringify(response));
  const text = JSON.stringify(response);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('\\"document\\":'), false);
}
async function assertUnchanged(f, before, peerBefore) {
  const reopened = new Store(f.root);
  assert.deepEqual(await reopened.get(f.project.id), before);
  assert.deepEqual(await reopened.get(f.peer.id), peerBefore);
  assert.deepEqual(await readMCPActivities(f.root), []);
  f.assertNoEffects();
}
async function roundtrip(f, document, before) {
  const target = await f.app.store.create("Native selection roundtrip");
  importIntoProject(target, document);
  const saved = await f.app.store.save(target);
  const reopened = await new Store(f.root).get(saved.id);
  assert.deepEqual(reopened, saved);
  assert.equal(reopened.requests.length, 1);
  const actual = reopened.requests[0],
    expected = before.requests[0];
  for (const key of [
    "name",
    "folder",
    "url",
    "method",
    "body",
    "bodyType",
    "auth",
    "inheritSharedScripts",
  ])
    assert.deepEqual(actual[key], expected[key], key);
  assert.deepEqual(
    actual.nativeTasks.before.map(({ id, ...task }) => task),
    expected.nativeTasks.before.map(({ id, ...task }) => task),
  );
  assert.equal(reopened.globalVariables.scriptHits, "0");
  assert.equal(reopened.globalVariables.staticSecret, secret);
  assert.equal(
    reopened.requests.some((request) => request.name === "Unselected API"),
    false,
  );
  assert.deepEqual(reopened.folders, ["Parent", "Parent/Chosen"]);
  for (const key of ["history", "runs", "plans", "protocolRuns"])
    assert.deepEqual(reopened[key], []);
}

for (const kind of ["HTTP", "stdio"])
  test(
    `official ${kind} read-only SDK exports both native selections and persists public-importer roundtrips without effects`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      const before = await f.app.store.get(f.project.id),
        peerBefore = await f.app.store.get(f.peer.id);
      const { client } = await f.connect(kind);
      const catalog = (await client.listTools()).tools;
      for (const name of [
        "preview_project_export",
        "export_project_selection",
        "export_project",
      ])
        assert(catalog.some((tool) => tool.name === "localapi_" + name));
      for (const name of ["execute_api", "save_plan", "import_project"])
        assert(!catalog.some((tool) => tool.name === "localapi_" + name));
      for (const format of formats) {
        const registryBefore = await new Store(f.root).list();
        const input = selected(format);
        const preview = decode(
          await call(client, f.project.id, "preview_project_export", input),
        );
        assert.equal(preview.projectId, f.project.id);
        assert.equal(preview.configRevision, before.configRevision);
        assert.match(preview.scope.digest, /^[a-f0-9]{64}$/);
        assert.equal(Object.hasOwn(preview, "document"), false);
        assert.equal(JSON.stringify(preview).includes(secret), false);
        assert.equal(
          JSON.stringify(preview).includes("apt.globals.set"),
          false,
        );
        assert.deepEqual(preview.scope.dependencies, [
          { kind: "environment", id: before.environments[0].id },
          { kind: "folder", id: "Parent" },
          { kind: "folder", id: "Parent/Chosen" },
          { kind: "globals", id: "configuration" },
        ]);
        assert(preview.warnings.some((warning) => /认证|敏感/.test(warning)));
        const output = decode(
          await call(
            client,
            f.project.id,
            "export_project_selection",
            accepted(input, preview),
          ),
        );
        assert.equal(output.scope.digest, preview.scope.digest);
        assert.equal(
          output.documentBytes,
          Buffer.byteLength(JSON.stringify(output.document)),
        );
        assert.deepEqual(await new Store(f.root).list(), registryBefore);
        await roundtrip(f, output.document, before);
        // Existing full native tool retains its full-project schema and output.
        const full = decode(
          await call(client, f.project.id, "export_project", { format }),
        );
        assert.deepEqual(full, {
          projectId: f.project.id,
          format,
          document: (format === "apipost"
            ? exportApipost
            : exportApipostDirectory)(before),
        });
        const all = { requests: [], environments: [], settings: {} };
        importIntoProject(all, full.document);
        assert.equal(all.requests.length, 2);
        await assertUnchanged(f, before, peerBefore);
      }
      await client.close();
      const restarted = await f.connect(kind);
      decode(
        await call(
          restarted.client,
          f.project.id,
          "preview_project_export",
          selected(),
        ),
      );
      await assertUnchanged(f, before, peerBefore);
    },
  );

for (const kind of ["HTTP", "stdio"])
  test(
    `official ${kind} SDK requires exact dependencies, digest, revision and project authority`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      const before = await f.app.store.get(f.project.id),
        peerBefore = await f.app.store.get(f.peer.id);
      const { client } = await f.connect(kind);
      const input = selected(),
        preview = decode(
          await call(client, f.project.id, "preview_project_export", input),
        );
      const good = accepted(input, preview);
      for (const changed of [
        { acceptedDependencies: undefined },
        { acceptedDependencies: [] },
        {
          acceptedDependencies: [
            ...good.acceptedDependencies,
            { kind: "api", id: "other" },
          ],
        },
        {
          acceptedDependencies: [
            ...good.acceptedDependencies,
            good.acceptedDependencies[0],
          ],
        },
        { configRevision: undefined },
        { configRevision: before.configRevision - 1 },
        { scopeDigest: undefined },
        { scopeDigest: "0".repeat(64) },
        { format: "apipost-directory" },
        { selection: { mode: "all" } },
        { modelNameMode: "preserve" },
        { unknown: true },
      ])
        assertRefused(
          await call(client, f.project.id, "export_project_selection", {
            ...good,
            ...changed,
          }),
        );
      for (const [name, args] of [
        ["preview_project_export", input],
        ["export_project_selection", good],
      ])
        assertRefused(await call(client, f.peer.id, name, args));
      assertRefused(
        await call(client, f.project.id, "preview_project_export", {
          ...input,
          selection: { mode: "explicit", resources: [] },
        }),
      );
      await assertUnchanged(f, before, peerBefore);
      const changed = await f.app.store.get(f.project.id);
      changed.requests[0].name = "New configuration";
      const updated = await f.app.store.save(changed);
      assertRefused(
        await call(client, f.project.id, "export_project_selection", good),
      );
      const fresh = decode(
        await call(client, f.project.id, "preview_project_export", input),
      );
      assert.equal(fresh.configRevision, updated.configRevision);
      updated.archived = true;
      const archived = await f.app.store.save(updated);
      for (const [name, args] of [
        ["preview_project_export", input],
        ["export_project_selection", accepted(input, fresh)],
      ])
        assertRefused(await call(client, f.project.id, name, args));
      await assertUnchanged(f, archived, peerBefore);
    },
  );

// Hold the real cross-process project lock, then call the genuine Store.get.
// The wrapper only observes admission/settlement; it never supplies a project.
async function holdRead(store, projectId) {
  const unlock = await acquireFileLock(store.lockFile(projectId));
  const original = store.get;
  let started = false,
    entered,
    settled,
    releasePromise;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const done = new Promise((resolve) => {
    settled = resolve;
  });
  store.get = async function (...args) {
    if (args[0] !== projectId || started)
      return Reflect.apply(original, this, args);
    started = true;
    const pending = Reflect.apply(original, this, args);
    entered();
    try {
      return await pending;
    } finally {
      settled();
    }
  };
  const release = () => (releasePromise ??= unlock());
  return {
    ready,
    get started() {
      return started;
    },
    done,
    release,
    async dispose() {
      store.get = original;
      await release();
      if (started) await done;
    },
  };
}

// Observe bytes handed to the genuine HTTP response independently of what the
// SDK does with a locally aborted request. Cancellation must suppress the server
// artifact, not merely make the client stop waiting for it.
function observeNextMCPResponse(server) {
  let observed, finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const listener = (request, response) => {
    if (request.url !== "/mcp" || request.method !== "POST") return;
    server.off("request", listener);
    const chunks = [];
    const originalWrite = response.write,
      originalEnd = response.end;
    const capture = (chunk, encoding) => {
      if (chunk !== undefined && chunk !== null && typeof chunk !== "function")
        chunks.push(
          Buffer.isBuffer(chunk)
            ? Buffer.from(chunk)
            : Buffer.from(
                chunk,
                typeof encoding === "string" ? encoding : undefined,
              ),
        );
    };
    response.write = function (...args) {
      capture(args[0], args[1]);
      return Reflect.apply(originalWrite, this, args);
    };
    response.end = function (...args) {
      capture(args[0], args[1]);
      return Reflect.apply(originalEnd, this, args);
    };
    response.once("finish", () => {
      observed = {
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      finish(observed);
    });
  };
  server.on("request", listener);
  return {
    done,
    get observed() {
      return observed;
    },
    dispose() {
      server.off("request", listener);
    },
  };
}

test(
  "official HTTP SDK cancellation and owner grant revocation suppress queued Store.get preview/export artifacts",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const before = await f.app.store.get(f.project.id),
      peerBefore = await f.app.store.get(f.peer.id);
    for (const action of ["cancel", "revoke"])
      for (const name of [
        "preview_project_export",
        "export_project_selection",
      ]) {
        const session = await f.connect("HTTP");
        const preview = decode(
          await call(
            session.client,
            f.project.id,
            "preview_project_export",
            selected(),
          ),
        );
        const input =
          name === "preview_project_export"
            ? selected()
            : accepted(selected(), preview);
        const held = await holdRead(f.app.store, f.project.id);
        const response = observeNextMCPResponse(f.app.server);
        f.beforeClose(held.dispose);
        t.after(response.dispose);
        try {
          const controller = new AbortController();
          const pending = call(session.client, f.project.id, name, input, {
            signal: controller.signal,
          }).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          await waitFor(() => held.started);
          if (action === "cancel") {
            controller.abort();
            await waitFor(() =>
              session.sends.some(
                ({ message }) => message.method === "notifications/cancelled",
              ),
            );
            // The real HTTP 202 confirms the server consumed cancellation before
            // we unblock its project read, rather than racing a fixed sleep.
            await session.sends.find(
              ({ message }) => message.method === "notifications/cancelled",
            ).promise;
          } else await f.configure([]);
          await held.release();
          const outcome = await pending;
          await held.done;
          const wireResponse = await response.done;
          if (action === "cancel") {
            assert.equal(wireResponse.status, 202);
            assert.equal(
              wireResponse.body,
              "",
              "server emits no cancelled artifact",
            );
          } else {
            assert.equal(wireResponse.status, 200);
            const wireError = JSON.parse(wireResponse.body);
            assert.equal(wireError.error?.code, -32000);
            assert.equal(Object.hasOwn(wireError, "result"), false);
            assert.equal(wireResponse.body.includes(secret), false);
          }
          assert(
            outcome.error || outcome.value?.isError,
            action + " must not return an artifact",
          );
          if (outcome.value)
            assert.equal(JSON.stringify(outcome.value).includes(secret), false);
          await session.client.ping();
          const request = session.sends
            .filter(({ message }) => message.method === "tools/call")
            .at(-1).message;
          const responses = session.received.filter(
            (message) => message.id === request.id,
          );
          assert(
            responses.every(
              (message) => !message.result || message.result.isError === true,
            ),
          );
        } finally {
          response.dispose();
          await held.dispose();
          await session.client.close();
        }
        await assertUnchanged(f, before, peerBefore);
      }
  },
);

for (const kind of ["HTTP", "stdio"])
  test(
    `official ${kind} scoped database rebind roundtrips definitions without runtime credentials or execution`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      const source = nativeDatabaseFixture(f.base + "/database");
      source.global.db_link[0].config.default.db_config.host = "127.0.0.1";
      source.global.db_link[0].config.default.db_config.port = f.databasePort;
      let project = await f.app.store.get(f.project.id);
      project.requests = [];
      project.folders = [];
      project.globalVariables = {};
      importIntoProject(project, source);
      project = await f.app.store.save(project);
      const peerBefore = await f.app.store.get(f.peer.id);
      const { client } = await f.connect(kind);
      for (const format of formats) {
        const input = {
          ...selected(format, project.requests[0].id),
          databaseMode: "rebind",
        };
        const preview = decode(
          await call(client, project.id, "preview_project_export", input),
        );
        const output = decode(
          await call(
            client,
            project.id,
            "export_project_selection",
            accepted(input, preview),
          ),
        );
        for (const value of [
          "discard-this-fictional-password",
          "private-host.invalid",
          "synthetic-user",
          "synthetic-db",
        ])
          assert.equal(JSON.stringify(output).includes(value), false);
        const target = await f.app.store.create("Database rebind imported");
        importIntoProject(target, output.document);
        const saved = await f.app.store.save(target);
        const reopened = await new Store(f.root).get(saved.id);
        assert.equal(reopened.requests.length, 1);
        assert.equal(
          reopened.requests[0].nativeTasks.before.filter(
            (task) => task.type === "database",
          ).length,
          1,
        );
        assert.deepEqual(
          reopened.settings.apipostDatabases,
          saved.settings.apipostDatabases,
        );
        assert.equal(reopened.runs.length, 0);
        await assertUnchanged(f, project, peerBefore);
      }
    },
  );

test(
  "official stdio SDK cancellation suppresses the real entrypoint's queued preview/export artifacts",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const before = await f.app.store.get(f.project.id),
      peerBefore = await f.app.store.get(f.peer.id);
    for (const name of ["preview_project_export", "export_project_selection"]) {
      const prefix = path.join(f.root, name),
        armed = prefix + ".armed",
        entered = prefix + ".entered",
        settled = prefix + ".settled",
        preload = prefix + ".mjs";
      // Test-only observation around the actual Store read. The parent owns the
      // real project lock; no substitute result, dispatch, exporter or SDK is used.
      await writeFile(
        preload,
        `
      import { existsSync, writeFileSync } from "node:fs";
      import { Store } from ${JSON.stringify(new URL("../src/runtime.mjs", import.meta.url).href)};
      const original = Store.prototype.get;
      let observed = false;
      Store.prototype.get = async function (...args) {
        if (observed || args[0] !== ${JSON.stringify(f.project.id)} ||
            !existsSync(${JSON.stringify(armed)})) return Reflect.apply(original, this, args);
        observed = true;
        const pending = Reflect.apply(original, this, args);
        writeFileSync(${JSON.stringify(entered)}, "real-store-get-entered");
        try { return await pending; }
        finally { writeFileSync(${JSON.stringify(settled)}, "real-store-get-settled"); }
      };
    `,
      );
      const session = await f.connect("stdio", f.project.id, preload);
      const preview = decode(
        await call(
          session.client,
          f.project.id,
          "preview_project_export",
          selected(),
        ),
      );
      const input =
        name === "preview_project_export"
          ? selected()
          : accepted(selected(), preview);
      const unlock = await acquireFileLock(f.app.store.lockFile(f.project.id));
      f.beforeClose(unlock);
      try {
        await writeFile(armed, "observe exactly one read");
        const controller = new AbortController();
        const pending = call(session.client, f.project.id, name, input, {
          signal: controller.signal,
        }).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await waitFor(() => exists(entered));
        assert.equal(
          await exists(settled),
          false,
          "real read is still blocked on the project lock",
        );
        controller.abort();
        await waitFor(() =>
          session.sends.some(
            ({ message }) => message.method === "notifications/cancelled",
          ),
        );
        await session.sends.find(
          ({ message }) => message.method === "notifications/cancelled",
        ).promise;
        // stdin preserves order, and the ping reply establishes that the real
        // handler has consumed the preceding cancellation notification.
        await session.client.ping();
        await unlock();
        const outcome = await pending;
        assert(outcome.error || outcome.value?.isError);
        await waitFor(() => exists(settled));
        await session.client.ping();
        const request = session.sends
          .filter(({ message }) => message.method === "tools/call")
          .at(-1).message;
        const replies = session.received.filter(
          (message) => message.id === request.id,
        );
        assert(
          replies.every(
            (message) => !message.result || message.result.isError === true,
          ),
        );
        decode(
          await call(
            session.client,
            f.project.id,
            "preview_project_export",
            selected(),
          ),
        );
      } finally {
        await unlock();
        await session.client.close();
      }
      await assertUnchanged(f, before, peerBefore);
    }
  },
);

test(
  "official HTTP and stdio SDK previews reject an artifact below 4 MiB whose complete encoded frame exceeds 8 MiB",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    let source = await f.app.store.get(f.project.id);
    source.folders = [];
    source.globalVariables = {};
    source.requests = [
      normalizeRequest({
        id: "chosen",
        name: "Dense backslash payload",
        method: "POST",
        url: f.base + "/never-send",
        bodyType: "raw",
        body: "",
        headers: [{ key: "Content-Type", value: "text/plain", enabled: true }],
      }),
      ...Array.from({ length: 20 }, (_, i) =>
        normalizeRequest({
          id: `unselected-${i}-` + "x".repeat(110),
          name: "Unselected",
          url: f.base + "/unselected",
        }),
      ),
    ];
    source = await f.app.store.save(source);
    const route = "/api/projects/" + source.id;
    const baseline = await f.owner(route + "/export-preview", selected());
    assert.equal(baseline.status, 200, JSON.stringify(baseline.value));
    // Calibrate against the real owner converter, including this fixture's source
    // identity and metadata. Each literal backslash costs two document bytes.
    const count = Math.floor(
      (MCP_PROJECT_DOCUMENT_BYTES - baseline.value.documentBytes - 32) / 2,
    );
    assert(count > 2_090_000);
    source.requests[0].body = "\\".repeat(count);
    delete source.requestDefinitionHistory;
    // A legacy definition can exceed the new history-detail limit. Persist using
    // the genuine project format, without imposing a new save quota on that data.
    await writeProject(f.app.store.directory(source.id), source);
    const before = await new Store(f.root).get(source.id),
      peerBefore = await f.app.store.get(f.peer.id);
    const ownerPreview = await f.owner(route + "/export-preview", selected());
    assert.equal(ownerPreview.status, 200, JSON.stringify(ownerPreview.value));
    assert(ownerPreview.value.documentBytes <= MCP_PROJECT_DOCUMENT_BYTES);
    const ownerExport = await f.owner(
      route + "/export-selection",
      accepted(selected(), ownerPreview.value),
    );
    assert.equal(
      ownerExport.status,
      200,
      JSON.stringify(ownerExport.value.error),
    );
    assert.equal(
      Buffer.byteLength(JSON.stringify(ownerExport.value.document)),
      ownerPreview.value.documentBytes,
    );
    const encoded =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify(ownerExport.value) }],
        },
      }) + "\n";
    assert(
      Buffer.byteLength(encoded) > MCP_PROJECT_FRAME_BYTES,
      "the fixture must exceed the actual complete frame limit, not only a guessed raw document bound",
    );
    for (const kind of ["HTTP", "stdio"]) {
      const { client } = await f.connect(kind);
      const response = await call(
        client,
        source.id,
        "preview_project_export",
        selected(),
      );
      assertRefused(response);
      assert.match(response.content[0].text, /8 MiB/);
      assert(Buffer.byteLength(JSON.stringify(response)) < 1024);
      assertRefused(
        await call(
          client,
          source.id,
          "export_project_selection",
          accepted(selected(), ownerPreview.value),
        ),
      );
      await client.ping();
      await client.close();
    }
    await assertUnchanged(f, before, peerBefore);
  },
);
