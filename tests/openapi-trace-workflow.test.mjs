import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { importDocument, importIntoProject } from "../src/core.mjs";
import { syncMCPOpenAPI } from "../src/mcp-openapi-sync.mjs";
import { createApp } from "../src/server.mjs";

const modes = ["url_and_folder", "url", "ignore", "both"];
function document(withTrace = false) {
  const source = {
    openapi: "3.1.0",
    info: { title: "TRACE admission", version: "1.0.0" },
    servers: [{ url: "https://example.test" }],
    paths: {
      "/kept": { $ref: "#/components/pathItems/x-Shared" },
      "/empty": {},
      "x-null": null,
      "x-meta": {
        $ref: "https://literal.invalid/path",
        get: {
          responses: { 200: { $ref: "https://literal.invalid/response" } },
        },
        trace: {},
      },
    },
    components: {
      schemas: { NewSchema: { type: "string" } },
      pathItems: {
        "x-Shared": {
          summary: "ordinary path metadata",
          description: "literal TRACE text",
          parameters: [],
          "x-meta": { trace: {}, $ref: "https://literal.invalid/metadata" },
          get: {
            operationId: "kept",
            tags: ["group"],
            responses: { 200: { description: "OK" } },
          },
        },
        "x-Trace": { trace: { responses: { 200: { description: "Echo" } } } },
      },
    },
  };
  if (withTrace)
    source.paths["/trace"] = { $ref: "#/components/pathItems/x-Trace" };
  return source;
}

test("direct import and all sync modes reject mixed/ref TRACE atomically while retaining legal literals", () => {
  const good = document();
  const originalGood = structuredClone(good);
  const rows = importDocument(good);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, "https://example.test/kept");
  assert.equal(rows[0].sourceOperationId, "kept");
  assert.deepEqual(good, originalGood);
  assert.deepEqual(
    importDocument({ openapi: "3.0.3", paths: { "/empty": {} } }),
    [],
  );
  const project = {
    requests: [{ ...rows[0], id: "existing", name: "must not be overwritten" }],
    folders: ["group"],
    environments: [{ id: "env", variables: { preserved: "yes" } }],
    openapiComponents: { schemas: { Preserved: { type: "boolean" } } },
  };
  const before = structuredClone(project);
  const bad = document(true);
  const sourceBefore = structuredClone(bad);
  for (const source of [bad, JSON.stringify(bad)]) {
    assert.throws(() => importDocument(source), /TRACE/);
    for (const sync of [false, true]) {
      assert.throws(
        () => importIntoProject(project, source, { sync }),
        /TRACE/,
      );
      assert.deepEqual(project, before);
    }
    for (const coverMode of modes) {
      assert.throws(
        () => syncMCPOpenAPI(project, { document: source, coverMode }),
        /TRACE/,
      );
      assert.deepEqual(project, before);
    }
  }
  assert.deepEqual(bad, sourceBefore);
  for (const version of ["3.0.3", "3.1.0"]) {
    const direct = {
      openapi: version,
      info: { title: "Mixed operations", version: "1" },
      paths: {
        "/get": { get: { responses: { 200: { description: "OK" } } } },
        "/trace": { trace: { responses: { 200: { description: "Echo" } } } },
      },
    };
    assert.throws(() => importDocument(direct), /TRACE/);
  }
  // TRACE is not a Swagger 2 operation: reject the unsupported field explicitly,
  // without claiming that this malformed Swagger document is a valid feature.
  assert.throws(
    () => importDocument({ swagger: "2.0", paths: { "/": { trace: {} } } }),
    /TRACE/,
  );
  const positive = syncMCPOpenAPI(project, {
    document: good,
    coverMode: "url",
  });
  assert.equal(positive.length, 1);
  assert.equal(positive[0].id, "existing");
  assert.deepEqual(good, originalGood);
});

async function diskSnapshot(directory) {
  const output = {};
  async function walk(base, prefix = "") {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await walk(path.join(base, entry.name), name + "/");
      else
        output[name] = (await readFile(path.join(base, entry.name))).toString(
          "base64",
        );
    }
  }
  await walk(directory);
  return output;
}
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function stop(app) {
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
}

test(
  "owner and official SDK HTTP/stdio preserve saved bytes on TRACE rejection and accept legal paths after restart",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openapi-trace-"));
    let app = await createApp({ root, port: 0 });
    const clients = [];
    t.after(async () => {
      await Promise.all(
        clients.map((client) => client.close().catch(() => {})),
      );
      if (app) await stop(app);
      await rm(root, { recursive: true, force: true });
    });
    const project = await app.store.create("TRACE atomic admission");
    const owner = (action, body) =>
      fetch(app.url + action, {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const good = document();
    const bad = document(true);
    const sourceBefore = structuredClone(bad);
    const imported = await owner(`/api/projects/${project.id}/import`, {
      document: good,
    });
    assert.equal(imported.status, 200);
    let before = await app.store.get(project.id);
    assert.equal(before.requests.length, 1);
    let bytesBefore = await diskSnapshot(app.store.directory(project.id));
    const unchanged = async () => {
      assert.deepEqual(await app.store.get(project.id), before);
      assert.deepEqual(
        await diskSnapshot(app.store.directory(project.id)),
        bytesBefore,
      );
      assert.deepEqual(bad, sourceBefore);
    };
    for (const source of [bad, JSON.stringify(bad)]) {
      const rejected = await owner(`/api/projects/${project.id}/import`, {
        document: source,
      });
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /TRACE/);
      await unchanged();
    }
    const configured = await owner("/api/mcp/config", {
      enabled: true,
      projects: [project.id],
      write: true,
      execute: false,
      remember: false,
    });
    assert.equal(configured.status, 200);
    const { token } = await configured.json();
    const transports = [
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      }),
      new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
          "--project",
          project.id,
          "--write",
        ],
        env: { LOCAL_API_DATA: root },
        stderr: "pipe",
      }),
    ];
    for (const transport of transports) {
      const client = new Client(
        { name: "trace-admission", version: "1.0.0" },
        { capabilities: {} },
      );
      clients.push(client);
      await client.connect(transport);
      for (const coverMode of modes) {
        const rejected = await client.callTool({
          name: "localapi_sync_openapi",
          arguments: {
            projectId: project.id,
            document: bad,
            coverMode,
          },
        });
        assert.equal(rejected.isError, true);
        assert.match(rejected.content[0].text, /TRACE/);
        await unchanged();
      }
      // A failed admission must not poison the session or convert literal metadata.
      const ignored = decode(
        await client.callTool({
          name: "localapi_sync_openapi",
          arguments: {
            projectId: project.id,
            document: good,
            coverMode: "ignore",
          },
        }),
      );
      assert.deepEqual(ignored, []);
      // A successful sync may update the disk revision; subsequent rejected syncs
      // are compared with their own exact saved baseline in the next transport.
      before = await app.store.get(project.id);
      bytesBefore = await diskSnapshot(app.store.directory(project.id));
      assert.equal(before.requests.length, 1);
      await client.close();
    }
    const saved = await app.store.get(project.id);
    await stop(app);
    app = undefined;
    app = await createApp({ root, port: 0 });
    assert.deepEqual(await app.store.get(project.id), saved);
    const more = document();
    more.paths["/second"] = more.paths["/kept"];
    delete more.paths["/kept"];
    const afterRestart = await owner(`/api/projects/${project.id}/import`, {
      document: more,
    });
    assert.equal(afterRestart.status, 200);
    const restored = await app.store.get(project.id);
    assert.deepEqual(restored.requests.map((row) => row.url).sort(), [
      "https://example.test/kept",
      "https://example.test/second",
    ]);
  },
);
