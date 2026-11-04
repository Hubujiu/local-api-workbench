import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { gateProjectSave } from "./fixtures/mcp-missing-file-save-gate.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const assertUnauthorized = (result) => {
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /项目未授权/);
};
const tool = (client, params) =>
  client.callTool(params, undefined, { timeout: 10000 });
async function bounded(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function diskBytes(directory) {
  const output = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, entry.name);
    output[entry.name] = entry.isDirectory()
      ? await diskBytes(file)
      : (await readFile(file)).toString("base64");
  }
  return output;
}
async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await bounded(
    new Promise((resolve) => server.close(resolve)),
    3000,
    "Fixture server did not close",
  );
}

async function fixture(t, transport) {
  const root = await mkdtemp(path.join(os.tmpdir(), "missing-project-sdk-")),
    reached = Promise.withResolvers(),
    resume = Promise.withResolvers(),
    gatePath = "/save-gate/" + randomUUID(),
    clients = [],
    operations = [];
  let app,
    peer,
    restoreGate,
    gateEntries = 0,
    effects = 0;
  const closeClients = async () => {
    const outcomes = await Promise.allSettled(
      clients.splice(0).map(async (entry) => {
        await bounded(
          entry.client.close(),
          6000,
          "SDK transport did not close",
        );
        // Stdio close may return immediately after SIGKILL. Its public onclose
        // callback is the actual child close event, not just a cleared PID field.
        if (entry.exited)
          await bounded(entry.exited, 2000, "SDK stdio child did not exit");
      }),
    );
    const errors = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    if (errors.length) throw new AggregateError(errors, "SDK cleanup failed");
  };
  t.after(async () => {
    // Release the child handshake before closing SDK transports. Never leave a
    // failed assertion holding a subprocess, an HTTP response or a Store gate.
    const errors = [];
    for (const clean of [
      () => {
        resume.resolve();
        restoreGate?.();
      },
      closeClients,
      () =>
        bounded(
          Promise.all(operations.map((operation) => operation.catch(() => {}))),
          3000,
          "SDK operation did not settle after close",
        ),
      () => closeServer(app?.server),
      () => closeServer(peer),
      () => rm(root, { recursive: true, force: true }),
    ]) {
      try {
        await clean();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Fixture cleanup failed");
  });
  const pause = async (proof) => {
    if (++gateEntries !== 1) throw Error("Duplicate save-gate entry");
    reached.resolve(proof);
    await resume.promise;
  };
  peer = http.createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === gatePath) {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 65536) throw Error("Oversized save-gate request");
          chunks.push(chunk);
        }
        await pause(JSON.parse(Buffer.concat(chunks).toString()));
        response.end("resume");
      } else if (request.method === "POST" && request.url === "/effect") {
        for await (const chunk of request) void chunk;
        effects++;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ effects }));
      } else {
        response.writeHead(404).end();
      }
    } catch (error) {
      response.writeHead(500).end("fixture gate failed: " + error.message);
    }
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  const peerURL = `http://127.0.0.1:${peer.address().port}`;
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("A: initial definition"),
    unrelated = await app.store.create("Unrelated project");
  project.requests = [
    normalizeRequest({
      id: "fixture-owned-api",
      name: "A: original API",
      method: "POST",
      url: peerURL + "/effect",
    }),
  ];
  project.documents = [{ id: "fixture-doc", title: "Document", content: "A" }];
  project.settings.fixtureMarker = "A";
  await app.store.save(project);
  const initial = await app.store.get(project.id),
    unrelatedBytes = await diskBytes(app.store.directory(unrelated.id));

  async function owner(route, body, method) {
    const response = await fetch(app.url + route, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, value: await response.json() };
  }
  async function sdk(projectId, gated = false) {
    const client = new Client(
      { name: "missing-file-sdk", version: "1.0.0" },
      { capabilities: {} },
    );
    const entry = { client };
    clients.push(entry);
    if (transport === "stdio") {
      const connection = new StdioClientTransport({
        command: process.execPath,
        args: [
          ...(gated
            ? [
                "--import",
                fileURLToPath(
                  new URL(
                    "./fixtures/mcp-missing-file-save-gate.mjs",
                    import.meta.url,
                  ),
                ),
              ]
            : []),
          fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
          "--project",
          projectId,
          "--write",
        ],
        env: {
          LOCAL_API_DATA: root,
          ...(gated
            ? {
                LOCAL_API_TEST_SAVE_GATE: peerURL + gatePath,
                LOCAL_API_TEST_SAVE_PROJECT: projectId,
              }
            : {}),
        },
        stderr: "pipe",
      });
      // Drain diagnostic output, with a bounded copy for failed startup reports.
      let stderr = "";
      const exited = Promise.withResolvers();
      entry.exited = exited.promise;
      connection.onclose = () => exited.resolve();
      connection.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-8192);
      });
      try {
        await bounded(
          client.connect(connection, { timeout: 10000 }),
          10000,
          "SDK stdio negotiation timed out",
        );
      } catch (error) {
        throw new Error("Official SDK stdio startup failed: " + stderr, {
          cause: error,
        });
      }
    } else {
      const config = await owner("/api/mcp/config", {
        enabled: true,
        projects: [projectId],
        write: true,
        execute: false,
        remember: false,
      });
      assert.equal(config.status, 200);
      if (gated) restoreGate = gateProjectSave(app.store, projectId, pause);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: {
            headers: { Authorization: "Bearer " + config.value.token },
          },
        }),
        { timeout: 10000 },
      );
    }
    assert.equal(client.getServerVersion().name, "local-api-workbench");
    return client;
  }
  return {
    root,
    initial,
    unrelated,
    unrelatedBytes,
    reached: reached.promise,
    owner,
    sdk,
    operations,
    effects: () => effects,
    gateEntries: () => gateEntries,
    store: () => app.store,
    release: () => resume.resolve(),
    async restart() {
      restoreGate?.();
      restoreGate = undefined;
      await closeClients();
      await closeServer(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}

async function commitLatest(f) {
  const writer = new Store(f.root),
    latest = await writer.get(f.initial.id);
  latest.name = "B: committed newer definition";
  latest.requests[0].name = "B: edited API";
  latest.requests.push(
    normalizeRequest({
      id: "fixture-newer-api",
      name: "B: new API",
      url: "http://127.0.0.1/newer",
    }),
  );
  latest.documents[0].content = "B: newer document";
  latest.settings.fixtureMarker = "B: newer settings";
  latest.globalVariables.fixtureMarker = "B: newer variables";
  await writer.save(latest);
  const execution = await f.owner(`/api/projects/${latest.id}/execute`, {
    request: latest.requests[0],
  });
  assert.equal(execution.status, 200);
  assert.equal(execution.value.outcome, "passed");
  assert.equal(execution.value.status, 200);
  assert.equal(f.effects(), 1);
  const archived = await writer.get(latest.id);
  assert.equal(archived.history.length, 1);
  assert.equal(archived.history[0].response.status, 200);
  archived.archived = true;
  await writer.save(archived);
  const exported = await f.owner(`/api/projects/${latest.id}/export`);
  assert.equal(exported.status, 200);
  assert(exported.value.revision > f.initial.revision);
  assert(exported.value.configRevision > f.initial.configRevision);
  return exported.value;
}

for (const transport of ["http", "stdio"])
  for (const missing of ["API", "settings/documents"])
    test(
      `official SDK ${transport}: missing required ${missing} after a newer commit refuses stale sync, preserves peer and restores without replay`,
      { timeout: 30000 },
      async (t) => {
        const f = await fixture(t, transport),
          client = await f.sdk(f.initial.id, true),
          document = {
            openapi: "3.0.3",
            info: { title: "Delayed import", version: "1" },
            servers: [{ url: "http://127.0.0.1" }],
            paths: {
              "/late-import": {
                get: { responses: { 200: { description: "OK" } } },
              },
            },
          },
          operation = client.callTool(
            {
              name: "localapi_sync_openapi",
              arguments: { projectId: f.initial.id, document },
            },
            undefined,
            { timeout: 20000 },
          );
        f.operations.push(operation);
        const stale = await Promise.race([
          f.reached,
          operation.then(() => {
            throw Error(
              "SDK sync completed before reaching the actual Store.save gate",
            );
          }),
        ]);
        assert.equal(stale.id, f.initial.id);
        assert.equal(stale.name, f.initial.name);
        assert.equal(stale.revision, f.initial.revision);
        assert.equal(stale.configRevision, f.initial.configRevision);
        assert.equal(stale.marker, "A");
        assert.deepEqual(stale.historyIds, []);
        assert.deepEqual(stale.documents, f.initial.documents);
        assert.equal(stale.requests.length, 2);
        assert(
          stale.requests.some((request) =>
            request.url.endsWith("/late-import"),
          ),
        );

        const latest = await commitLatest(f),
          directory = f.store().directory(f.initial.id),
          manifest = JSON.parse(
            await readFile(path.join(directory, "project.json"), "utf8"),
          );
        assert(manifest.collections.requests.includes("fixture-owned-api"));
        const relative =
            missing === "API"
              ? path.join(
                  "apis",
                  "key-" +
                    Buffer.from("fixture-owned-api").toString("base64url") +
                    ".json",
                )
              : path.join("settings", "documents.json"),
          file = path.join(directory, relative),
          removedBytes = await readFile(file);
        // A real required file, from the NEWER committed revision, is removed only
        // after the actual SDK conversion has captured the old project snapshot.
        await rm(file);
        const damaged = await diskBytes(directory);
        f.release();
        const result = await operation;
        if (result.isError !== true) {
          // Keep the pre-fix loss observable, not merely a missing error flag.
          // This branch is a diagnostic for RED controls; it never repairs data.
          const overwritten = await new Store(f.root).get(latest.id);
          t.diagnostic(
            "Unexpected SDK success after file loss: " +
              JSON.stringify({
                latestRevision: latest.revision,
                actualRevision: overwritten.revision,
                latestConfigRevision: latest.configRevision,
                actualConfigRevision: overwritten.configRevision,
                latestHistory: latest.history.length,
                actualHistory: overwritten.history.length,
                actualArchived: overwritten.archived === true,
                staleImportPublished: overwritten.requests.some((request) =>
                  request.url.endsWith("/late-import"),
                ),
                actualEffects: f.effects(),
              }),
          );
        }
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /ENOENT/);
        assert(
          result.content[0].text.includes(file),
          "ENOENT must identify the deliberately removed required file",
        );
        assert.doesNotMatch(
          result.content[0].text,
          /PROJECT_COMMIT_UNCERTAIN|commit_outcome/,
        );
        assert.equal(f.gateEntries(), 1);
        assert.deepEqual(await diskBytes(directory), damaged);
        await assert.rejects(readFile(file), { code: "ENOENT" });
        await assert.rejects(
          readFile(path.join(directory, ".transaction.json")),
          { code: "ENOENT" },
        );
        await assert.rejects(new Store(f.root).get(f.initial.id), {
          code: "ENOENT",
        });
        assert.deepEqual(
          await diskBytes(f.store().directory(f.unrelated.id)),
          f.unrelatedBytes,
        );
        assertUnauthorized(
          await tool(client, {
            name: "localapi_list_apis",
            arguments: { projectId: f.unrelated.id },
          }),
        );
        assert.equal(f.effects(), 1);

        // Recover through the actual owner endpoint while the source remains
        // damaged. The restored archive is a new identity, not an implicit grant.
        const restored = await f.owner("/api/restore", { document: latest });
        assert.equal(restored.status, 201);
        const copy = restored.value;
        assert.notEqual(copy.id, latest.id);
        assert.notEqual(copy.id, f.unrelated.id);
        assert.equal(copy.revision, 1);
        assert.equal(copy.configRevision, 1);
        assert.equal(copy.archived, true);
        for (const key of [
          "requests",
          "documents",
          "settings",
          "globalVariables",
          "history",
          "runs",
        ])
          assert.deepEqual(copy[key], latest[key], key);
        assertUnauthorized(
          await tool(client, {
            name: "localapi_list_apis",
            arguments: { projectId: copy.id },
          }),
        );
        assert.deepEqual(await diskBytes(directory), damaged);
        await f.restart();
        const reopened = await f.owner(`/api/projects/${copy.id}/export`);
        assert.equal(reopened.status, 200);
        assert.deepEqual(reopened.value, copy);
        await assert.rejects(new Store(f.root).get(latest.id), {
          code: "ENOENT",
        });
        assert.deepEqual(await diskBytes(directory), damaged);
        assert.deepEqual(
          await diskBytes(f.store().directory(f.unrelated.id)),
          f.unrelatedBytes,
        );
        assert.equal(f.effects(), 1);

        // Only a deliberate owner unarchive and a fresh project grant make the
        // restored evidence visible to another real SDK connection after restart.
        const unarchived = await f.owner(
          `/api/projects/${copy.id}`,
          { ...copy, archived: false },
          "PUT",
        );
        assert.equal(unarchived.status, 200);
        const oldScope = await f.sdk(latest.id);
        assertUnauthorized(
          await tool(oldScope, {
            name: "localapi_list_apis",
            arguments: { projectId: copy.id },
          }),
        );
        const reader = await f.sdk(copy.id);
        assert.deepEqual(
          decode(
            await tool(reader, {
              name: "localapi_get_execution_result",
              arguments: { projectId: copy.id, runId: latest.history[0].id },
            }),
          ),
          latest.history[0],
        );
        for (const id of [latest.id, f.unrelated.id])
          assertUnauthorized(
            await tool(reader, {
              name: "localapi_list_apis",
              arguments: { projectId: id },
            }),
          );
        assert.equal(f.effects(), 1);

        // Reinstall only the exact removed fixture bytes to inspect the original
        // revision. No Store save, rollback API or request replay repairs it.
        await writeFile(file, removedBytes);
        const original = await new Store(f.root).get(latest.id);
        assert.deepEqual(original, latest);
        assert.equal(original.archived, true);
        assert.equal(original.revision, latest.revision);
        assert.equal(original.configRevision, latest.configRevision);
        assert.equal(
          original.requests.some((request) =>
            request.url.endsWith("/late-import"),
          ),
          false,
        );
        assert.deepEqual(
          await diskBytes(f.store().directory(f.unrelated.id)),
          f.unrelatedBytes,
        );
        assert.equal(f.effects(), 1);
      },
    );
