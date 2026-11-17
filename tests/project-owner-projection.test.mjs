import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { projectOwnerResponse } from "../src/project-owner-projection.mjs";

test("owner project views omit only server-owned history, preserving edits and nested literal data", () => {
  const project = {
    id: "project",
    configRevision: 7,
    requests: [{ id: "api", body: { requestDefinitionHistory: "literal" } }],
    settings: { modified: true },
    requestDefinitionHistory: {
      version: 1,
      entries: [{ private: "old credential" }],
    },
  };
  const before = structuredClone(project);
  const view = projectOwnerResponse(project);
  assert.deepEqual(view, {
    id: "project",
    configRevision: 7,
    requests: project.requests,
    settings: project.settings,
  });
  assert.deepEqual(project, before);
  assert.equal(view.requests, project.requests);
  const wrapped = {
    result: { requestDefinitionHistory: "response literal" },
    project,
    other: true,
  };
  assert.deepEqual(projectOwnerResponse(wrapped), {
    ...wrapped,
    project: view,
  });
  assert.equal(wrapped.project, project);
  for (const value of [
    undefined,
    null,
    "text",
    [],
    { requests: [] },
    { requestDefinitionHistory: "schema literal" },
  ])
    assert.equal(projectOwnerResponse(value), value);
});

test("backup restore UI passes parsed object without double string encoding and has no new visual surface", async () => {
  const source = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /document:\s*importMode === "restore" && typeof document === "string"\s*\? JSON\.parse\(document\)\s*: document/,
  );
  const text = JSON.stringify({
    id: "project",
    requests: [{ body: '\\"\\\\'.repeat(1024) }],
  });
  const document = JSON.parse(text);
  const wire = JSON.stringify({ document });
  assert.deepEqual(JSON.parse(wire).document, JSON.parse(text));
  assert.ok(
    Buffer.byteLength(wire) <
      Buffer.byteLength(JSON.stringify({ document: text })),
  );
});
