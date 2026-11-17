// These compatibility regressions were observed RED before the independent
// history quota correction. They run real raw admission and disk I/O,
// not the dependency-blocked owner/SDK path.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { importPostmanRawBody } from "../src/postman-raw-body.mjs";
import { writeProject, readProject } from "../src/project-files.mjs";
import { reconcileRequestDefinitionHistory } from "../src/request-definition-history.mjs";

const MIB = 1024 * 1024;
const rawProject = (bytes) => ({
  id: "large-history-compatibility",
  name: "Before",
  requests: [
    {
      id: "api",
      name: "before",
      method: "POST",
      url: "http://127.0.0.1:1/must-not-run",
      ...importPostmanRawBody({
        mode: "raw",
        raw: "x".repeat(bytes),
        options: { raw: { language: "xml" } },
      }),
    },
  ],
  environments: [],
  plans: [],
  cases: [],
  protocols: [],
});
let serial = 0;
const options = () => ({
  now: "2026-11-04T08:00:00.000Z",
  makeId: () => "history-id-" + ++serial,
});
for (const bytes of [2 * MIB, 8 * MIB]) {
  test(`legacy raw ${bytes} bytes persists twice; history must not reject its initial admission`, async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "history-large-compat-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const project = rawProject(bytes);
    assert.ok(
      Buffer.byteLength(JSON.stringify({ document: project })) < 12 * MIB,
    );
    await writeProject(directory, project);
    const read = await readProject(directory, project.id);
    assert.equal(read.requests[0].body.length, bytes);
    assert.deepEqual(read.requests[0].postmanRawBody, {
      version: 1,
      language: "xml",
    });
    read.requests[0].name = "after";
    await writeProject(directory, read);
    assert.equal(
      (await readProject(directory, project.id)).requests[0].name,
      "after",
    );
    const before = structuredClone(project);
    const history = reconcileRequestDefinitionHistory(
      undefined,
      project,
      options(),
    );
    assert.equal(history.entries[0].versions.length, 0);
    assert.deepEqual(project, before);
  });
}

test("an admitted 8MiB raw current must have a real first-edit archival path", () => {
  const before = rawProject(8 * MIB);
  const small = rawProject(1);
  before.requestDefinitionHistory = reconcileRequestDefinitionHistory(
    undefined,
    small,
    options(),
  );
  const next = structuredClone(before);
  next.requests[0].name = "after";
  const frozen = structuredClone(before);
  const history = reconcileRequestDefinitionHistory(before, next, options());
  assert.equal(
    history.entries[0].versions[0].definition.body,
    before.requests[0].body,
  );
  assert.equal(history.entries[0].currentVersion, 2);
  assert.deepEqual(before, frozen);
});

test("a legal 6MiB raw input and its two-version storage require distinct byte budgets", () => {
  const before = rawProject(6 * MIB);
  const project = structuredClone(before);
  project.requestDefinitionHistory = {
    version: 1,
    projectId: project.id,
    entries: [
      {
        requestId: "api",
        lineageId: "lineage",
        currentVersion: 2,
        currentCreatedAt: "2026-11-04T08:00:00.000Z",
        currentTag: "",
        retired: false,
        versions: [
          {
            id: "old",
            version: 1,
            createdAt: "2026-11-04T07:00:00.000Z",
            tag: "",
            definition: before.requests[0],
          },
        ],
      },
    ],
  };
  assert.ok(Buffer.byteLength(JSON.stringify({ document: before })) < 12 * MIB);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ document: project })) > 12 * MIB,
  );
  // This control proves the arithmetic only. The dependency-blocked owner
  // contract checks that Store does not apply an HTTP-input bound to disk state.
});
