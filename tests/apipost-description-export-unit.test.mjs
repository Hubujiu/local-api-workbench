import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  exportApipostDescriptions,
  verifyApipostDescriptionDefinitions,
} from "../src/apipost-description-export.mjs";
import { mergeApipostDescriptions } from "../src/apipost-descriptions.mjs";
import { validateParameterDescriptions } from "../public/parameter-descriptions.js";

const id = (kind, value) =>
  kind + createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
const options = { projectId: "target-project", id };
const semantic = (rows) =>
  rows.map(({ key, description }) => ({ key, description }));

test("description export uses current values, remaps IDs and preserves ordered Unicode keys", () => {
  const rows = [
    {
      key: "Name",
      description: '中文 "quote" \\ path\nline',
      apipostSource: { projectId: "old", id: "same" },
    },
    {
      key: "name",
      description: "",
      apipostSource: { projectId: "other", id: "same" },
    },
    { key: "\ud800", description: "first" },
    { key: "\ud801", description: "second" },
  ];
  const before = structuredClone(rows);
  const output = exportApipostDescriptions(rows, options);
  assert.deepEqual(semantic(output), semantic(rows));
  assert.equal(new Set(output.map((entry) => entry.id)).size, rows.length);
  assert.deepEqual(exportApipostDescriptions(rows, options), output);
  assert.notDeepEqual(
    exportApipostDescriptions(rows, {
      ...options,
      projectId: "another-target",
    }).map((entry) => entry.id),
    output.map((entry) => entry.id),
  );
  for (const entry of output) {
    assert.equal(entry.project_id, options.projectId);
    assert.deepEqual(Object.keys(entry).sort(), [
      "description",
      "id",
      "key",
      "project_id",
    ]);
  }
  assert.deepEqual(rows, before);
  const next = mergeApipostDescriptions(output, [], options.projectId);
  verifyApipostDescriptionDefinitions(rows, next);
  rows[0].description = "edited current description";
  assert.equal(
    exportApipostDescriptions(rows, options)[0].description,
    rows[0].description,
  );
  assert.deepEqual(rows[0].apipostSource, before[0].apipostSource);
});

test("empty and omitted catalogues preserve the existing empty-list shape", () => {
  assert.deepEqual(exportApipostDescriptions(undefined, options), []);
  assert.deepEqual(exportApipostDescriptions([], options), []);
  verifyApipostDescriptionDefinitions();
  for (const value of [null, {}, false, ""])
    assert.throws(() => exportApipostDescriptions(value, options));
});

test("description export validates complete definitions and origin before projection", () => {
  const invalid = [
    [{ key: "x", description: "text", unknown: 1 }],
    [
      {
        key: "x",
        description: "text",
        apipostSource: { projectId: "old", extra: true },
      },
    ],
    [
      {
        key: "x",
        description: "text",
        apipostSource: { id: "missing-project" },
      },
    ],
    [
      {
        key: "x",
        description: "text",
        apipostSource: { projectId: "old", id: "" },
      },
    ],
    [
      { key: "x", description: "a" },
      { key: "x", description: "a" },
    ],
    [{ key: " x", description: "a" }],
    [{ key: "x", description: null }],
    [{ key: "x" }],
    Array(2),
  ];
  for (const rows of invalid) {
    const before = structuredClone(rows);
    assert.throws(() => exportApipostDescriptions(rows, options));
    assert.deepEqual(rows, before);
  }
  assert.throws(
    () =>
      exportApipostDescriptions(
        [
          { key: "x", description: "a" },
          { key: "y", description: "b" },
        ],
        { ...options, id: () => "duplicate" },
      ),
    /重复/,
  );
});

test("description export rejects getters before invoking them", () => {
  for (const location of ["row", "origin", "array"]) {
    let calls = 0;
    const getter = {
      enumerable: true,
      get() {
        calls++;
        return "forbidden";
      },
    };
    const rows = [
      { key: "x", description: "a", apipostSource: { projectId: "old" } },
    ];
    if (location === "row")
      Object.defineProperty(rows[0], "description", getter);
    if (location === "origin")
      Object.defineProperty(rows[0].apipostSource, "id", getter);
    if (location === "array") Object.defineProperty(rows, "0", getter);
    assert.throws(() => exportApipostDescriptions(rows, options));
    assert.equal(calls, 0);
  }
});

test("description limits retain 2000 entries and exact key and text boundaries", () => {
  const rows = Array.from({ length: 2000 }, (_, index) => ({
    key: "k" + index,
    description: "",
  }));
  assert.equal(exportApipostDescriptions(rows, options).length, 2000);
  assert.throws(() =>
    exportApipostDescriptions(
      [...rows, { key: "extra", description: "" }],
      options,
    ),
  );
  assert.equal(
    exportApipostDescriptions(
      [{ key: "k".repeat(200), description: "d".repeat(8000) }],
      options,
    ).length,
    1,
  );
  assert.throws(() =>
    exportApipostDescriptions(
      [{ key: "k".repeat(201), description: "" }],
      options,
    ),
  );
  assert.throws(() =>
    exportApipostDescriptions(
      [{ key: "k", description: "d".repeat(8001) }],
      options,
    ),
  );
});

test("description aggregate limit remains exact after destination provenance remapping", () => {
  const rows = Array.from({ length: 200 }, (_, index) => {
    const key = "key" + index;
    return {
      key,
      description: "",
      apipostSource: {
        projectId: options.projectId,
        id: id("description", JSON.stringify([options.projectId, key])),
      },
    };
  });
  const bytes = () =>
    rows.reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)),
      0,
    );
  let remaining = 1024 * 1024 - bytes();
  for (const entry of rows) {
    const length = Math.min(8000, remaining);
    entry.description = "d".repeat(length);
    remaining -= length;
  }
  assert.equal(remaining, 0);
  assert.equal(bytes(), 1024 * 1024);
  assert.equal(exportApipostDescriptions(rows, options).length, rows.length);
  rows.at(-1).description += "x";
  assert.equal(bytes(), 1024 * 1024 + 1);
  assert.throws(() => exportApipostDescriptions(rows, options), /1MiB/);
});

test("description forward verification detects lost, reordered or changed definitions", () => {
  const rows = [
    { key: "a", description: "first" },
    { key: "b", description: "second" },
  ];
  for (const invalid of [
    rows.slice(1),
    rows.toReversed(),
    [{ key: "a", description: "changed" }, rows[1]],
  ])
    assert.throws(
      () => verifyApipostDescriptionDefinitions(rows, invalid),
      /回读不一致/,
    );
  verifyApipostDescriptionDefinitions(
    rows,
    rows.map((entry) => ({
      ...entry,
      apipostSource: { projectId: "different" },
    })),
  );
});

test("existing import merge keeps same-text target provenance and rejects conflicting or foreign rows", () => {
  const existing = [
    {
      key: "key",
      description: "same",
      apipostSource: { projectId: "earlier", id: "keep" },
    },
  ];
  const before = structuredClone(existing);
  const same = mergeApipostDescriptions(
    [{ id: "incoming", project_id: "source", key: "key", description: "same" }],
    existing,
    "source",
  );
  assert.deepEqual(same, before);
  for (const rows of [
    [{ key: "key", description: "different" }],
    [
      { id: "same", key: "a", description: "x" },
      { id: "same", key: "b", description: "x" },
    ],
    [{ project_id: "foreign", key: "a", description: "x" }],
    [{ key: "a", description: "x", extra: true }],
  ]) {
    assert.throws(() => mergeApipostDescriptions(rows, existing, "source"));
    assert.deepEqual(existing, before);
  }
  const missing = mergeApipostDescriptions([{ key: "missing" }], [], "source");
  assert.deepEqual(missing, [{ key: "missing", description: "" }]);
  validateParameterDescriptions(missing);
});
