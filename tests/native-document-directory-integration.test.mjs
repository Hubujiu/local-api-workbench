import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
import { importIntoProject } from "../src/core.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";
import { nativeAPIDetail, nativeAPIList } from "../src/native-mcp-tools.mjs";
import { deleteAPIResources } from "../src/api-resource-lifecycle.mjs";

// Synthetic source contract only; not a vendor-produced document directory.
test("native directory active doc export and deletion backup survive restart without losing archives", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "document-directory-flow-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  const source = modernApipostFixture(),
    content = "# 原生目录文档\r\n中🌏 {{inert}} <script>no execution</script>";
  source.apis.push({
    target_id: "doc",
    target_type: "doc",
    project_id: source.project_id,
    parent_id: "folder",
    name: "Native document",
    description: content,
    mark_id: "1",
  });
  const directory = nativeDirectoryFixture(source),
    inputBefore = structuredClone(directory);
  const p = await app.store.create("native documents"),
    other = await app.store.create("other");
  const headers = () => ({
    "x-local-token": app.token,
    "content-type": "application/json",
  });
  const imported = await fetch(app.url + "/api/projects/" + p.id + "/import", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ document: directory }),
  });
  assert.equal(imported.status, 200, await imported.clone().text());
  const current = await app.store.get(p.id),
    document = current.documents[0];
  assert.equal(document.content, content);
  assert.equal(document.folder, "Group");
  assert.equal(nativeAPIDetail(current, document.id).api.description, content);
  for (const format of ["apipost", "apipost-directory"]) {
    const response = await fetch(
      app.url + "/api/projects/" + p.id + "/export?format=" + format,
      { headers: headers() },
    );
    assert.equal(response.status, 200);
    const output = await response.json();
    const roundtrip = await app.store.create("doc definition roundtrip");
    importIntoProject(roundtrip, output);
    await app.store.save(roundtrip);
    assert.equal(roundtrip.documents.length, 1);
    assert.equal(roundtrip.documents[0].content, content);
    assert.equal(roundtrip.documents[0].folder, "Group");
    assert.equal(roundtrip.documents[0].title, document.title);
    assert.equal(roundtrip.requests.length, current.requests.length);
  }
  const dispatch = createMCP({
    store: app.store,
    projects: [p.id],
    write: true,
  });
  const deleted = await dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "apipost_delete_apis",
      arguments: {
        project_id: p.id,
        target_ids: ["folder:Group"],
        confirm: true,
      },
    },
  });
  assert.notEqual(deleted.result?.isError, true, JSON.stringify(deleted));
  const saved = await app.store.get(p.id);
  assert.equal(saved.documents.length, 0);
  assert.equal(nativeAPIList(saved, {}).apis.length, 0);
  assert.equal(saved.apiResourceTrash.batches[0].documents[0].content, content);
  for (const format of ["apipost", "apipost-directory"]) {
    const response = await fetch(
      app.url + "/api/projects/" + p.id + "/export?format=" + format,
      { headers: headers() },
    );
    assert.equal(response.status, 400);
    assert.match(await response.text(), /apiResourceTrash.*项目备份/);
  }
  const backup = await (
    await fetch(app.url + "/api/projects/" + p.id + "/export", {
      headers: headers(),
    })
  ).json();
  const restoredResponse = await fetch(app.url + "/api/restore", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ document: backup }),
  });
  assert.equal(restoredResponse.status, 201);
  const restored = await restoredResponse.json();
  assert.deepEqual(restored.apiResourceTrash, saved.apiResourceTrash);
  assert.equal(nativeAPIList(restored, {}).apis.length, 0);
  assert.equal(
    (
      await dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "apipost_list_apis",
          arguments: { project_id: restored.id },
        },
      })
    ).result.isError,
    true,
  );
  assert.equal((await app.store.get(other.id)).apiResourceTrash, undefined);
  assert.deepEqual(directory, inputBefore);
  await stop();
  app = await createApp({ root, port: 0 });
  const reopened = await app.store.get(restored.id);
  assert.deepEqual(reopened.apiResourceTrash, saved.apiResourceTrash);
  assert.equal(nativeAPIList(reopened, {}).apis.length, 0);
});

test("empty imported TCP connection containers cannot be mistaken for ordinary deletable folders", () => {
  const source = nativeProtocolFixture();
  source.apis = source.apis.filter((n) => n.target_type === "socket");
  const p = {
    id: "protocol-owner",
    name: "protocol-owner",
    requests: [],
    environments: [],
    settings: {},
    folders: [],
    documents: [],
    plans: [],
  };
  importIntoProject(p, source);
  assert.equal((p.protocols || []).length, 0);
  assert(p.settings.apipostProtocolSources.length > 0);
  assert(p.folders.includes("TCP"));
  const before = structuredClone(p);
  assert.throws(() => deleteAPIResources(p, ["folder:TCP"]), /协议/);
  assert.deepEqual(p, before);
});
