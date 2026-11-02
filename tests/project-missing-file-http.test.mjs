import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "missing-project-http-"));
  let app;
  t.after(async () => {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("A: initial definition");
  project.requests = [
    normalizeRequest({
      id: "fixture-owned-api",
      name: "A: original API",
      url: "http://127.0.0.1/initial",
    }),
  ];
  await app.store.save(project);
  return { root, app, project };
}
const headers = (app) => ({
  "x-local-token": app.token,
  "content-type": "application/json",
});
const post = (app, route, body) =>
  fetch(app.url + route, {
    method: "POST",
    headers: headers(app),
    body: JSON.stringify(body),
  });
const document = {
  openapi: "3.0.3",
  info: { title: "A: delayed additive import", version: "1" },
  servers: [{ url: "http://127.0.0.1" }],
  paths: {
    "/late-import": {
      get: { responses: { 200: { description: "OK" } } },
    },
  },
};

// This gates the real save before it acquires a lock. Reads, writes, validation,
// journaling and the missing-file error all remain the actual Store operations.
function gateNextSave(store, projectId) {
  const reached = Promise.withResolvers(),
    resume = Promise.withResolvers(),
    save = store.save.bind(store);
  let gated = false;
  store.save = async (project, options) => {
    if (project.id === projectId && !gated) {
      gated = true;
      reached.resolve(structuredClone(project));
      await resume.promise;
    }
    return save(project, options);
  };
  return {
    reached: reached.promise,
    release: () => resume.resolve(),
    restore: () => {
      resume.resolve();
      store.save = save;
    },
  };
}
async function waitForSave(gate, operation) {
  return Promise.race([
    gate.reached,
    operation.then(() => {
      throw Error("fixture request completed before reaching its save gate");
    }),
  ]);
}
async function diskBytes(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await diskBytes(file)
      : (await readFile(file)).toString("base64");
  }
  return result;
}
async function commitLatest(app, root, projectId) {
  const writer = new Store(root),
    project = await writer.get(projectId);
  project.name = "B: committed latest definition";
  project.requests[0].name = "B: edited API";
  project.requests.push(
    normalizeRequest({
      id: "fixture-latest-api",
      name: "B: new API",
      url: "http://127.0.0.1/latest",
    }),
  );
  project.settings.fixtureMarker = "B: latest settings";
  project.globalVariables.fixtureMarker = "B: latest variables";
  await writer.save(project);
  // Actual owner execution supplies persisted history, not a fabricated read
  // result or an in-memory history mutation. The target is this test's app.
  const response = await post(app, `/api/projects/${projectId}/execute`, {
    request: {
      name: "B: executed before archive",
      method: "GET",
      url: app.url + "/",
    },
  });
  assert.equal(response.status, 200);
  const execution = await response.json();
  assert.equal(execution.status, 200);
  assert.equal(execution.outcome, "passed");
  const beforeArchive = await writer.get(projectId);
  assert.equal(beforeArchive.history.length, 1);
  assert.equal(beforeArchive.history[0].response.status, 200);
  beforeArchive.archived = true;
  await writer.save(beforeArchive);
  return writer.get(projectId);
}
async function removeOwnedAPI(store, projectId) {
  const directory = store.directory(projectId),
    manifest = JSON.parse(
      await readFile(path.join(directory, "project.json"), "utf8"),
    ),
    id = "fixture-owned-api";
  assert(manifest.collections.requests.includes(id));
  const file = path.join(
    directory,
    "apis",
    "key-" + Buffer.from(id).toString("base64url") + ".json",
  );
  const bytes = await readFile(file);
  // Only a known, manifest-owned file beneath this mkdtemp fixture is removed.
  await rm(file);
  return { directory, file, bytes, before: await diskBytes(directory) };
}
async function assertPreserved(store, projectId, removed, expected) {
  assert.deepEqual(await diskBytes(removed.directory), removed.before);
  await assert.rejects(readFile(removed.file), { code: "ENOENT" });
  await assert.rejects(
    readFile(path.join(removed.directory, ".transaction.json")),
    { code: "ENOENT" },
  );
  await assert.rejects(store.get(projectId), { code: "ENOENT" });
  // Reinstall the exact removed fixture bytes, not a new save or repair API.
  await writeFile(removed.file, removed.bytes);
  const reopened = await new Store(store.root).get(projectId);
  assert.deepEqual(reopened, expected);
  assert.equal(reopened.archived, true);
  assert.equal(reopened.requests.length, 2);
  assert.equal(reopened.history.length, 1);
  assert(reopened.revision > 1);
  assert(reopened.configRevision > 1);
  assert.equal(
    reopened.requests.some((r) => r.url.endsWith("/late-import")),
    false,
  );
}

test(
  "owner additive import fails closed when a required API disappears after a newer commit",
  { timeout: 30000 },
  async (t) => {
    const { root, app, project } = await fixture(t),
      gate = gateNextSave(app.store, project.id);
    const operation = post(app, `/api/projects/${project.id}/import`, {
      document,
    });
    try {
      const stale = await waitForSave(gate, operation);
      assert.equal(stale.revision, project.revision);
      assert.equal(stale.requests.length, 2);
      const latest = await commitLatest(app, root, project.id),
        removed = await removeOwnedAPI(app.store, project.id);
      gate.release();
      const response = await operation,
        error = await response.json();
      assert.equal(response.status, 404);
      assert.match(error.error, /ENOENT/);
      assert.notEqual(error.code, "PROJECT_COMMIT_UNCERTAIN");
      assert.notEqual(error.commit_outcome, "unknown");
      await assertPreserved(app.store, project.id, removed, latest);
    } finally {
      gate.restore();
      await operation.catch(() => {});
    }
  },
);

test(
  "MCP additive sync fails closed on the same real missing-child interleaving",
  { timeout: 30000 },
  async (t) => {
    const { root, app, project } = await fixture(t),
      dispatch = createMCP({
        store: app.store,
        projects: [project.id],
        write: true,
      }),
      gate = gateNextSave(app.store, project.id);
    const operation = dispatch({
      id: 1,
      method: "tools/call",
      params: {
        name: "localapi_sync_openapi",
        arguments: { projectId: project.id, document },
      },
    });
    try {
      const stale = await waitForSave(gate, operation);
      assert.equal(stale.revision, project.revision);
      assert.equal(stale.requests.length, 2);
      const latest = await commitLatest(app, root, project.id),
        removed = await removeOwnedAPI(app.store, project.id);
      gate.release();
      const response = await operation;
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /ENOENT/);
      assert.doesNotMatch(
        response.result.content[0].text,
        /PROJECT_COMMIT_UNCERTAIN/,
      );
      await assertPreserved(app.store, project.id, removed, latest);
      const archived = await dispatch({
        id: 2,
        method: "tools/call",
        params: {
          name: "localapi_get_api_detail",
          arguments: { projectId: project.id, apiId: "fixture-owned-api" },
        },
      });
      assert.equal(archived.result.isError, true);
      assert.match(archived.result.content[0].text, /已归档/);
    } finally {
      gate.restore();
      await operation.catch(() => {});
    }
  },
);

test(
  "owner export restores a new healthy identity while its original required API is missing",
  { timeout: 30000 },
  async (t) => {
    const { root, app, project } = await fixture(t),
      exported = await fetch(app.url + `/api/projects/${project.id}/export`, {
        headers: headers(app),
      });
    assert.equal(exported.status, 200);
    const backup = await exported.json(),
      removed = await removeOwnedAPI(app.store, project.id),
      response = await post(app, "/api/restore", { document: backup });
    assert.equal(response.status, 201);
    const restored = await response.json();
    assert.notEqual(restored.id, project.id);
    assert.equal(restored.revision, 1);
    assert.equal(restored.configRevision, 1);
    assert.deepEqual(restored.requests, backup.requests);
    assert.deepEqual(await diskBytes(removed.directory), removed.before);
    await assert.rejects(readFile(removed.file), { code: "ENOENT" });
    const restart = new Store(root);
    await assert.rejects(restart.get(project.id), { code: "ENOENT" });
    assert.deepEqual(await restart.get(restored.id), restored);
    assert.equal((await restart.list()).length, 2);
    await writeFile(removed.file, removed.bytes);
    assert.deepEqual(await restart.get(project.id), backup);
  },
);
