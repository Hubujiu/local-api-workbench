import test from "node:test";
import assert from "node:assert/strict";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
test("native export cannot silently discard empty model folders", () => {
  const p = {
    id: "p",
    name: "P",
    requests: [],
    environments: [{ id: "e", name: "E", variables: {} }],
    settings: {},
    dictionary: [],
    modelFolders: [{ id: "f", name: "Empty", sort: 0, description: "keep" }],
  };
  const before = structuredClone(p);
  for (const exporter of [exportApipost, exportApipostDirectory])
    assert.throws(() => exporter(p), /modelFolders/);
  assert.deepEqual(p, before);
});
