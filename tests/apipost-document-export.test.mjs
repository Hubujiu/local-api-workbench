import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { importIntoProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { deleteAPIResources } from "../src/api-resource-lifecycle.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";
const projection = (p) =>
  p.documents.map((d) => ({
    title: d.title,
    content: d.content,
    folder: d.folder || "",
    state: d.statusId
      ? p.settings.statuses.find((s) => s.id === d.statusId).name
      : undefined,
    ...Object.fromEntries(
      ["sort", "version", "status"]
        .filter((k) => d.apipostSource?.[k] !== undefined)
        .map((k) => [k, d.apipostSource[k]]),
    ),
  }));
const close = async (app) => {
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
};
test("active native and plain documents preserve edited definitions through owner JSON/directory double roundtrip, restore and restart", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doc-export-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await close(app);
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, method = "GET", body, status = 200) => {
    const r = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await r.json();
    assert.equal(r.status, status, JSON.stringify(result));
    return result;
  };
  const other = await app.store.create("other"),
    untouched = await app.store.get(other.id);
  for (const sourceFormat of ["json", "directory"]) {
    const source = modernApipostFixture();
    source.apis.push({
      target_type: "doc",
      target_id: "guide",
      project_id: source.project_id,
      parent_id: "folder",
      name: "Guide",
      description: "old",
      sort: 7,
      version: 3,
      status: 0,
      mark_id: "1",
    });
    const document =
        sourceFormat === "json" ? source : nativeDirectoryFixture(source),
      original = structuredClone(document);
    const p = await app.store.create(sourceFormat);
    const imported = await call(`/api/projects/${p.id}/import`, "POST", {
      document,
    });
    assert.deepEqual(document, original);
    const doc = imported.documents[0];
    doc.title = "同名";
    doc.content =
      "# 雪🌏\r\n{{inert}} <script>throw 1</script> https://invalid.example/a";
    doc.folder = "Edited/深层";
    imported.settings.statuses.push({
      id: "edited-status",
      name: "Edited status",
      color: "#112233",
    });
    doc.statusId = "edited-status";
    imported.documents.push({
      id: "plain",
      title: "同名",
      content: "",
      folder: "Other",
    });
    await call(`/api/projects/${p.id}`, "PUT", imported);
    const before = await app.store.get(p.id),
      expected = projection(before);
    for (const onlyDocs of [false, true]) {
      const working = await app.store.get(p.id);
      if (onlyDocs) working.requests = [];
      await app.store.save(working);
      const workingSaved = await app.store.get(p.id);
      for (const format of ["apipost", "apipost-directory"]) {
        const route = `/api/projects/${p.id}/export?format=${format}`;
        assert.equal((await fetch(app.url + route)).status, 403);
        let output = await call(route);
        let target;
        for (let generation = 0; generation < 2; generation++) {
          target = await app.store.create("roundtrip");
          target = await call(`/api/projects/${target.id}/import`, "POST", {
            document: output,
          });
          assert.deepEqual(projection(target), expected);
          assert.equal(target.requests.length, working.requests.length);
          assert.equal(target.documents.length, 2);
          for (const d of target.documents) {
            assert.notEqual(d.id, doc.id);
            assert.equal(typeof d.apipostSource.projectId, "string");
            assert.equal(typeof d.apipostSource.targetId, "string");
            assert.equal(d.folder === "Other" ? d.content === "" : true, true);
          }
          output = await call(
            `/api/projects/${target.id}/export?format=${format}`,
          );
        }
        const backup = await call(`/api/projects/${target.id}/export`);
        const restored = await call(
          "/api/restore",
          "POST",
          { document: backup },
          201,
        );
        assert.deepEqual(restored.documents, target.documents);
        await close(app);
        app = await createApp({ root, port: 0 });
        assert.deepEqual(
          (await app.store.get(restored.id)).documents,
          target.documents,
        );
      }
      assert.deepEqual(await app.store.get(p.id), workingSaved);
    }
    const deleted = deleteAPIResources(before, [
      before.documents[0].id,
    ]).project;
    // The lifecycle helper returns a detached project; deleted archives must never export.
    for (const exporter of [exportApipost, exportApipostDirectory])
      assert.throws(() => exporter(deleted), /apiResourceTrash/);
  }
  assert.deepEqual(await app.store.get(other.id), untouched);
});
test("native document export rejects unrepresentable metadata and archives without mutating the input", () => {
  const base = {
    id: "p",
    name: "p",
    requests: [],
    environments: [{ id: "e", name: "e", variables: {} }],
    settings: {},
    documents: [{ id: "d", title: "D", content: "", folder: "" }],
  };
  const mutations = [
    (d) => (d.title = "x".repeat(201)),
    (d) => (d.title = ""),
    (d) => (d.attributes = { attachment: "x" }),
    (d) => (d.importNotes = ["custom"]),
    (d) => (d.deletedAt = ""),
    (d) => (d.apipostSource = { targetId: "t", unknown: 1 }),
    (d) => (d.apipostSource = { targetId: "t", mark_id: "old" }),
    (d) => (d.statusId = "missing"),
    (d) => (d.content = { html: "x" }),
    (d) => (d.apipostSource = { targetId: "t", version: -1 }),
  ];
  for (const mutate of mutations) {
    const p = structuredClone(base);
    mutate(p.documents[0]);
    const before = structuredClone(p);
    for (const exporter of [exportApipost, exportApipostDirectory])
      assert.throws(() => exporter(p));
    assert.deepEqual(p, before);
  }
  const p = structuredClone(base);
  p.apiResourceTrash = { version: 1, batches: [] };
  for (const exporter of [exportApipost, exportApipostDirectory])
    assert.throws(() => exporter(p), /apiResourceTrash/);
});
