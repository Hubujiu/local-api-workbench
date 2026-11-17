import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, exportOpenAPI } from "../src/core.mjs";
test("mixed nullable provenance survives persisted Store reopen and backup restore", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nullable-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("nullable");
  for (const [name, version] of [
    ["old", "3.0.3"],
    ["new", "3.1.0"],
  ])
    importIntoProject(p, {
      openapi: version,
      paths: {
        ["/" + name]: {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "string", nullable: true },
                  example: "value",
                },
              },
            },
            responses: { 200: { description: "ok" } },
          },
        },
      },
      components: { schemas: { [name]: { type: "string", nullable: true } } },
    });
  await store.save(p);
  const reopened = new Store(root),
    saved = await reopened.get(p.id),
    out = exportOpenAPI(saved);
  assert.equal(out.components.schemas.old.nullable, true);
  assert.equal(Object.hasOwn(out.components.schemas.new, "nullable"), false);
  const restored = await reopened.restore(JSON.parse(JSON.stringify(saved)));
  const second = new Store(root);
  const copy = await second.get(restored.id);
  const after = exportOpenAPI(copy);
  assert.deepEqual(after.paths, out.paths);
  assert.deepEqual(after.components, out.components);
  assert.notEqual(copy.id, p.id);
});
