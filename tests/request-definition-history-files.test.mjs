import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeProject,
  readProject,
  recoverProject,
} from "../src/project-files.mjs";

const timestamp = "2026-11-04T00:00:00.000Z";
function fixture() {
  const request = {
    id: "request-a",
    name: "current",
    method: "GET",
    url: "http://127.0.0.1:1/current",
  };
  return {
    version: 1,
    id: "history-project",
    name: "history",
    requests: [request],
    environments: [],
    plans: [],
    cases: [],
    protocols: [],
    settings: {},
    globalVariables: {},
    servers: [],
    history: [],
    runs: [],
    protocolRuns: [],
    documents: [],
    dictionary: [],
    parameterDictionary: [],
    folders: [],
    requestDefinitionHistory: {
      version: 1,
      projectId: "history-project",
      entries: [
        {
          requestId: request.id,
          lineageId: "b1ae29b0-98b2-4a7e-93f2-a7b8f0c6a90d",
          currentVersion: 2,
          currentCreatedAt: timestamp,
          currentTag: "",
          retired: false,
          versions: [
            {
              id: "a28bc832-332a-429c-8ed1-d7ad024d8292",
              version: 1,
              createdAt: timestamp,
              tag: "before",
              definition: {
                ...request,
                name: "previous",
                url: "http://127.0.0.1:1/previous",
              },
            },
          ],
        },
      ],
    },
  };
}
async function directory(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "definition-history-files-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("definition history is a declared required file and round-trips independently of execution history", async (t) => {
  const root = await directory(t),
    project = fixture();
  project.history = [{ id: "execution-only", status: "passed" }];
  await writeProject(root, project);
  const manifest = JSON.parse(
    await readFile(path.join(root, "project.json"), "utf8"),
  );
  assert.equal(manifest.requestDefinitionHistoryFormat, 1);
  assert.equal(Object.hasOwn(manifest, "requestDefinitionHistory"), false);
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(root, "history/definitions.json"), "utf8"),
    ),
    project.requestDefinitionHistory,
  );
  const reopened = await readProject(root, project.id);
  assert.deepEqual(
    reopened.requestDefinitionHistory,
    project.requestDefinitionHistory,
  );
  assert.deepEqual(reopened.history, project.history);
  assert.equal(
    Object.hasOwn(reopened, "requestDefinitionHistoryFormat"),
    false,
  );
  await rm(path.join(root, "history/definitions.json"));
  await assert.rejects(readProject(root, project.id), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, ".transaction.json")), {
    code: "ENOENT",
  });
});
test("legacy projects without a definition-history marker read without creating a history file", async (t) => {
  const root = await directory(t),
    project = fixture();
  delete project.requestDefinitionHistory;
  await writeProject(root, project);
  const before = await readFile(path.join(root, "project.json"));
  const reopened = await readProject(root, project.id);
  assert.equal(reopened.requestDefinitionHistory, undefined);
  assert.deepEqual(await readFile(path.join(root, "project.json")), before);
  await assert.rejects(readFile(path.join(root, "history/definitions.json")), {
    code: "ENOENT",
  });
});
test("invalid history owner fails before publishing a journal or changing current definition", async (t) => {
  const root = await directory(t),
    project = fixture();
  await writeProject(root, project);
  const before = await readFile(path.join(root, "project.json"));
  const bad = structuredClone(project);
  bad.requestDefinitionHistory.projectId = "other-project";
  bad.requests[0].name = "must-not-write";
  await assert.rejects(writeProject(root, bad), /历史|history/i);
  assert.deepEqual(await readFile(path.join(root, "project.json")), before);
  assert.equal(
    (await readProject(root, project.id)).requests[0].name,
    "current",
  );
  await assert.rejects(readFile(path.join(root, ".transaction.json")), {
    code: "ENOENT",
  });
});
test("recovery validates the full history before applying any pending project bytes", async (t) => {
  const root = await directory(t),
    project = fixture();
  await writeProject(root, project);
  const before = await readFile(path.join(root, "project.json"));
  const bad = structuredClone(project);
  bad.requestDefinitionHistory.entries[0].versions[0].definition.id =
    "other-request";
  bad.requests[0].name = "must-not-recover";
  const journal = JSON.stringify(bad);
  await writeFile(path.join(root, ".transaction.json"), journal);
  await assert.rejects(recoverProject(root, project.id), /历史|history/i);
  assert.deepEqual(await readFile(path.join(root, "project.json")), before);
  assert.equal(
    await readFile(path.join(root, ".transaction.json"), "utf8"),
    journal,
  );
  const requestName =
    "key-" + Buffer.from("request-a").toString("base64url") + ".json";
  assert.equal(
    JSON.parse(await readFile(path.join(root, "apis", requestName), "utf8"))
      .name,
    "current",
  );
});
test("valid interrupted journal applies the exact history once without inventing versions", async (t) => {
  const root = await directory(t),
    project = fixture();
  const prior = structuredClone(project);
  delete prior.requestDefinitionHistory;
  await writeProject(root, prior);
  const journal = JSON.stringify(project);
  await writeFile(path.join(root, ".transaction.json"), journal);
  const once = await readProject(root, project.id),
    twice = await readProject(root, project.id);
  assert.deepEqual(
    once.requestDefinitionHistory,
    project.requestDefinitionHistory,
  );
  assert.deepEqual(
    twice.requestDefinitionHistory,
    project.requestDefinitionHistory,
  );
  assert.equal(twice.requestDefinitionHistory.entries[0].versions.length, 1);
  await assert.rejects(readFile(path.join(root, ".transaction.json")), {
    code: "ENOENT",
  });
});

test("cancellation after temporary journal bytes but before publication preserves all committed files", async (t) => {
  const root = await directory(t),
    project = fixture();
  await writeProject(root, project);
  const before = await readProject(root, project.id);
  const controller = new AbortController();
  const nativeAborted = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted",
  ).get;
  const { readdirSync } = await import("node:fs");
  let observedPreparedJournal = false;
  // The real AbortController fires only when the production gate has already
  // written its temporary journal. No filesystem or Store method is replaced.
  Object.defineProperty(controller.signal, "aborted", {
    get() {
      if (
        readdirSync(root).some(
          (name) =>
            name.startsWith(".transaction.json.") && name.endsWith(".tmp"),
        )
      ) {
        observedPreparedJournal = true;
        controller.abort();
      }
      return nativeAborted.call(controller.signal);
    },
  });
  const changed = structuredClone(project);
  changed.name = "must not publish";
  await assert.rejects(
    writeProject(root, changed, { signal: controller.signal }),
    { code: "STORE_SAVE_ABORTED" },
  );
  assert.equal(observedPreparedJournal, true);
  assert.deepEqual(await readProject(root, project.id), before);
  assert.equal(
    readdirSync(root).some((name) => name.startsWith(".transaction.json")),
    false,
  );
});

test("published history journal remains recoverable after later cancellation, without rollback or replay", async (t) => {
  const root = await directory(t),
    project = fixture();
  await writeProject(root, project);
  const target = path.join(root, "apis");
  await rm(target, { recursive: true });
  await writeFile(target, "real apply fault");
  const controller = new AbortController();
  const changed = structuredClone(project);
  changed.name = "published";
  await assert.rejects(
    writeProject(root, changed, { signal: controller.signal }),
    { code: "PROJECT_COMMIT_UNCERTAIN" },
  );
  controller.abort();
  const journal = JSON.parse(
    await readFile(path.join(root, ".transaction.json"), "utf8"),
  );
  assert.equal(journal.name, "published");
  assert.deepEqual(
    journal.requestDefinitionHistory,
    project.requestDefinitionHistory,
  );
  await rm(target);
  const recovered = await readProject(root, project.id);
  assert.equal(recovered.name, "published");
  assert.deepEqual(
    recovered.requestDefinitionHistory,
    project.requestDefinitionHistory,
  );
  assert.deepEqual(await readProject(root, project.id), recovered);
});

test("post-publication builtin rename barrier injects a real apply failure only after journal is readable", async (t) => {
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const root = await directory(t),
    project = fixture();
  await writeProject(root, project);
  const journalFile = path.join(root, ".transaction.json"),
    apis = path.join(root, "apis");
  const originalRename = fs.promises.rename;
  let published = 0;
  fs.promises.rename = async (source, destination) => {
    await originalRename(source, destination);
    if (destination === journalFile) {
      const actual = JSON.parse(await readFile(journalFile, "utf8"));
      assert.equal(actual.name, "after barrier");
      published++;
      await rm(apis, { recursive: true });
      await writeFile(apis, "physical failure after publication");
    }
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      writeProject(root, { ...project, name: "after barrier" }),
      { code: "PROJECT_COMMIT_UNCERTAIN" },
    );
    assert.equal(published, 1);
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }
  await rm(apis);
  const recovered = await readProject(root, project.id);
  assert.equal(recovered.name, "after barrier");
  assert.deepEqual(
    recovered.requestDefinitionHistory,
    project.requestDefinitionHistory,
  );
  assert.deepEqual(await readProject(root, project.id), recovered);
});
