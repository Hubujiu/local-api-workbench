import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";
import { selectedDirectoryDocument } from "../public/apipost-directory-input.js";
async function fixture() {
  const root = new URL(
    "./fixtures/original-offline2/directory/",
    import.meta.url,
  );
  const files = [];
  for (const p of (await readdir(root, { recursive: true })).filter((p) =>
    p.endsWith(".json"),
  ))
    files.push({
      path: p.replaceAll("\\", "/"),
      text: await readFile(new URL(p.replaceAll("\\", "/"), root), "utf8"),
    });
  // Original built-in rule implementation is not redistributed. This inert
  // synthetic row exercises the same observed file envelope.
  files.push({
    path: "settings/mock_inner_rules.json",
    text: JSON.stringify([
      { match_rule: "fixture", mock_rule_content: "UNTRUSTED_NOT_EXECUTED" },
    ]),
  });
  return { format: "apipost-offline-directory-v1", files };
}
test("original directory selection imports genuine user records and preserves built-in catalog as inert backup data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const document = await fixture(),
    before = structuredClone(document);
  const selected = await selectedDirectoryDocument(
    document.files.map((f) => ({
      webkitRelativePath: "original/" + f.path,
      size: Buffer.byteLength(f.text),
      arrayBuffer: async () => new TextEncoder().encode(f.text).buffer,
    })),
  );
  const store = new Store(root),
    p = await store.create("native directory");
  importIntoProject(p, selected);
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].scriptDialect, "apipost8");
  assert.equal(p.requests[0].beforeScript.includes("native_value"), true);
  assert.equal(p.environments.at(-1).variables.native_value, "");
  assert.equal(p.settings.apipostDirectoryArtifacts.length, 1);
  assert.equal(
    p.settings.apipostDirectoryArtifacts[0].sourceProjectId,
    "10f7386134404a",
  );
  assert.deepEqual(p.settings.apipostDirectoryArtifacts[0].files, [
    document.files.at(-1),
  ]);
  assert.match(p.requests[0].importNotes.join(" "), /仅保留.*不启用/);
  await store.save(p);
  const loaded = await new Store(root).get(p.id);
  const restored = restoreProject(structuredClone(loaded));
  await store.save(restored);
  assert.deepEqual(
    (await store.get(restored.id)).settings.apipostDirectoryArtifacts,
    p.settings.apipostDirectoryArtifacts,
  );
  assert.deepEqual(document, before);
  // Reimport updates the source record rather than accumulating opaque copies.
  const second = await store.create("repeat");
  importIntoProject(second, document);
  importIntoProject(second, document);
  const count = second.settings.apipostDirectoryArtifacts.length;
  assert.equal(count, 1);
});
test("directory artifact validation preserves existing project atomically and rejects arbitrary paths and oversized retained data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("unchanged");
  for (const change of [
    (d) => d.files.push({ path: "settings/private-code.json", text: "[]" }),
    (d) => {
      d.files.at(-1).text = "{}";
    },
  ]) {
    const d = await fixture();
    change(d);
    const before = structuredClone(p);
    assert.throws(() => importIntoProject(p, d));
    assert.deepEqual(p, before);
  }
  const saved = structuredClone(p);
  saved.settings.apipostDirectoryArtifacts = [
    { sourceProjectId: "x", files: [{ path: "../outside.json", text: "[]" }] },
  ];
  await assert.rejects(store.save(saved));
  assert.deepEqual((await store.get(p.id)).settings, p.settings);
  const big = structuredClone(p);
  big.settings.apipostDirectoryArtifacts = [
    {
      sourceProjectId: "x",
      files: [
        {
          path: "settings/mock_inner_rules.json",
          text: '["' + "x".repeat(4 * 1024 * 1024) + '"]',
        },
      ],
    },
  ];
  await assert.rejects(store.save(big), /4MiB/);
  assert.throws(() => restoreProject(big), /4MiB/);
});
