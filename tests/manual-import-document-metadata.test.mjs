import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";
import { buildManualImportSourceGraph } from "../src/manual-import-source.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";

const context = {
  nonce: Buffer.alloc(32, 9).toString("base64url"),
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_060_000,
};
const documentKey = "document:documents/0";
const globalKey = "globals:configuration";

function canonical() {
  return {
    documents: [
      {
        id: "guide",
        title: "Guide",
        content: 'Literal {"statusId":"missing","attributes":{"unknown":"x"}}',
        statusId: "ready",
        attributes: { owner: "A literal ready value" },
      },
    ],
    settings: {
      statuses: [{ id: "ready", name: "Ready", color: "#26CEA4" }],
      attributes: [{ key: "owner", label: "Owner", type: "text" }],
    },
  };
}

test("document metadata contributes typed status and attribute dependencies, never body-text references", () => {
  const source = canonical();
  const before = structuredClone(source);
  const graph = buildManualImportSourceGraph(source, context);
  const document = graph.nodes.find((node) => node.key === documentKey);
  assert.deepEqual(document.dependencies, [globalKey]);
  assert.deepEqual(
    document.references.map(({ kind, targetKey, key }) => ({
      kind,
      targetKey,
      key,
    })),
    [
      { kind: "status", targetKey: globalKey, key: undefined },
      { kind: "attribute", targetKey: globalKey, key: true },
    ],
  );
  assert.deepEqual(graph.project.documents, source.documents);
  assert.deepEqual(source, before);
  delete source.documents[0].statusId;
  delete source.documents[0].attributes;
  const literalOnly = buildManualImportSourceGraph(source, context);
  const inert = literalOnly.nodes.find((node) => node.key === documentKey);
  assert.deepEqual(inert.dependencies, []);
  assert.deepEqual(inert.references, []);
});

test("dangling document metadata rejects before a source graph can be planned", () => {
  for (const change of [
    (source) => (source.documents[0].statusId = "missing"),
    (source) => (source.documents[0].attributes = { unknown: "value" }),
  ]) {
    const source = canonical();
    change(source);
    const before = structuredClone(source);
    assert.throws(
      () => buildManualImportSourceGraph(source, context),
      /引用目标不存在或类型不匹配/,
    );
    assert.deepEqual(source, before);
  }
});

async function fixture(t, directory = false) {
  const root = await mkdtemp(join(tmpdir(), "document-metadata-import-"));
  const app = await createApp({ root, port: 0 });
  let hits = 0;
  let client;
  const peer = http.createServer((_req, res) => {
    hits++;
    res.end("import must not execute");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    try {
      await client?.close();
      for (const server of [app.server, peer]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const p = await app.store.create("document import target");
  p.settings.statuses = [
    { id: "existing-status", name: "Existing", color: "#ffffff" },
  ];
  p.documents = [
    {
      id: "existing-document",
      title: "Unrelated existing document",
      content: "retain this content",
      statusId: "existing-status",
    },
  ];
  await app.store.save(p);
  const before = await app.store.get(p.id);
  const other = await app.store.create("unrelated project");
  const source = modernApipostFixture();
  source.global.envs[0].server_list[0].uri = `http://127.0.0.1:${peer.address().port}`;
  for (const [id, name] of [
    ["guide", "Selected guide"],
    ["not-selected", "Unselected guide"],
  ])
    source.apis.push({
      target_id: id,
      target_type: "doc",
      project_id: source.project_id,
      parent_id: "folder",
      name,
      description: "Document body",
      mark_id: "1",
    });
  const input = {
    format: directory ? "apipost-directory" : "apipost",
    document: directory ? nativeDirectoryFixture(source) : source,
    selection: { mode: "explicit", keys: [documentKey] },
  };
  const post = async (route, body) => {
    const response = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const owner = async (action, body) => {
    const response = await post(`/api/projects/${p.id}/import-${action}`, body);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  };
  const sdk = async () => {
    const grant = await post("/api/mcp/config", {
      enabled: true,
      remember: false,
      projects: [p.id],
      write: true,
      execute: false,
    });
    assert.equal(grant.status, 200);
    client = new Client({ name: "document-metadata", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer " + grant.data.token },
        },
      }),
    );
    return async (action, body) => {
      const result = await client.callTool({
        name: `localapi_${action}_import`,
        arguments: {
          projectId: p.id,
          ...(action === "preview" ? { input: body } : body),
        },
      });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      return JSON.parse(result.content[0].text);
    };
  };
  return { root, app, p, before, other, input, owner, sdk, hits: () => hits };
}

for (const directory of [false, true])
  for (const transport of ["owner", "sdk"])
    test(`${transport} ${directory ? "directory" : "JSON"} document-only import retains status through reopen and backup without importing unselected documents or APIs`, async (t) => {
      const f = await fixture(t, directory);
      const call = transport === "owner" ? f.owner : await f.sdk();
      const preview = await call("preview", f.input);
      assert.deepEqual(preview.blockers, []);
      assert.deepEqual(await f.app.store.get(f.p.id), f.before);
      await call("apply", { input: f.input, token: preview.token });
      const saved = await new Store(f.root).get(f.p.id);
      assert.equal(saved.documents.length, 2);
      assert.deepEqual(saved.documents[0], f.before.documents[0]);
      assert.equal(saved.documents[1].title, "Selected guide");
      assert.equal(saved.documents[1].content, "Document body");
      const status = saved.settings.statuses.find(
        (entry) => entry.id === saved.documents[1].statusId,
      );
      assert.equal(status?.name, "Ready");
      assert.ok(
        preview.items
          .find((item) => item.key === documentKey)
          .dependencies.includes(globalKey),
      );
      assert.equal(
        preview.items.find((item) => item.key === globalKey).action,
        "create",
      );
      assert.deepEqual(
        saved.settings.statuses[0],
        f.before.settings.statuses[0],
      );
      assert.deepEqual(saved.requests, []);
      assert.equal(saved.environments.length, f.before.environments.length);
      assert.deepEqual(await f.app.store.get(f.other.id), f.other);
      const restored = await f.app.store.restore(saved);
      assert.notEqual(restored.id, saved.id);
      const reopened = await new Store(f.root).get(restored.id);
      assert.deepEqual(reopened.documents, saved.documents);
      assert.deepEqual(reopened.settings.statuses, saved.settings.statuses);
      assert.equal(f.hits(), 0);
    });

test("document status dependency cannot be excluded or silently replace a conflicting registry entry", async (t) => {
  const f = await fixture(t);
  const excluded = structuredClone(f.input);
  excluded.selection.exclude = [globalKey];
  const sessionId = "document-metadata-test";
  await assert.rejects(
    f.app.store.previewManualImport(f.p.id, excluded, { sessionId }),
    { code: "MANUAL_IMPORT_DEPENDENCY_EXCLUDED" },
  );
  assert.deepEqual(await f.app.store.get(f.p.id), f.before);
  const preview = await f.owner("preview", f.input);
  await f.owner("apply", { input: f.input, token: preview.token });
  const modified = await f.app.store.get(f.p.id);
  const statusId = modified.documents[1].statusId;
  modified.settings.statuses.find((entry) => entry.id === statusId).name =
    "A different local meaning";
  await f.app.store.save(modified);
  const before = await f.app.store.get(f.p.id);
  const conflict = await f.owner("preview", f.input);
  assert.ok(conflict.blockers.some((item) => item.key === globalKey));
  assert.equal(conflict.token, undefined);
  assert.deepEqual(await new Store(f.root).get(f.p.id), before);
  assert.equal(f.hits(), 0);
});
