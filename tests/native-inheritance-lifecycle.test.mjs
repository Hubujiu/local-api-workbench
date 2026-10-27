import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { importIntoProject } from "../src/core.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";

test("owner atomically renames a preserved folder without changing its source identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-graph-edit-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((r) => {
      app.server.close(r);
      app.server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("graph");
  importIntoProject(p, nativeInheritanceFixture(), {
    inheritanceMode: "preserve",
  });
  await app.store.save(p);
  const before = await app.store.get(p.id),
    f = before.settings.nativeInheritance.folders[0];
  const res = await fetch(
    app.url + "/api/projects/" + p.id + "/native-inheritance-edit",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify({
        configRevision: before.configRevision,
        operation: {
          type: "move-folder",
          sourceId: f.sourceId,
          parentId: "0",
          name: "Renamed",
        },
      }),
    },
  );
  const result = await res.json();
  assert.equal(res.status, 200, JSON.stringify(result));
  assert.equal(
    result.settings.nativeInheritance.folders[0].sourceId,
    f.sourceId,
  );
  assert.equal(result.settings.nativeInheritance.folders[0].path, "Renamed");
  assert.equal(result.requests[0].folder, "Renamed");
});
