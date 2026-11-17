import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";
const sessionId = "native-append-test";
async function fixture(t, directory = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-append-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("native");
  importIntoProject(
    p,
    directory
      ? nativeDirectoryFixture(nativeInheritanceFixture())
      : nativeInheritanceFixture(),
    {
      inheritanceMode: "preserve",
    },
  );
  await store.save(p);
  const source = nativeInheritanceFixture();
  source.apis[1].target_id = "added";
  source.apis[1].url = "/added";
  return {
    root,
    store,
    p: await store.get(p.id),
    input: {
      format: directory ? "apipost-directory" : "apipost",
      document: directory ? nativeDirectoryFixture(source) : source,
      selection: { mode: "all" },
    },
  };
}
test("native create-only preview/apply retains existing definitions and concurrent activity", async (t) => {
  const { root, store, p, input } = await fixture(t);
  const preview = await store.previewManualImport(p.id, input, { sessionId });
  assert.deepEqual(preview.blockers, []);
  assert.equal(typeof preview.token, "string");
  assert.equal(JSON.stringify(preview).includes("disabled-child"), false);
  await store.append(p.id, "history", { id: "new-activity", status: "passed" });
  const receipts = await Promise.allSettled(
    [store, new Store(root)].map((s) =>
      s.applyManualImport(p.id, { input, token: preview.token }, { sessionId }),
    ),
  );
  assert.equal(receipts.filter((r) => r.status === "fulfilled").length, 1);
  const saved = await store.get(p.id);
  assert.deepEqual(saved.requests[0], p.requests[0]);
  assert.deepEqual(
    saved.settings.nativeInheritance.projectLayer,
    p.settings.nativeInheritance.projectLayer,
  );
  assert.deepEqual(
    saved.settings.nativeInheritance.folders,
    p.settings.nativeInheritance.folders,
  );
  assert.equal(saved.requests.length, 2);
  assert.equal(saved.history[0].id, "new-activity");
  assert.equal(
    saved.requests[1].id,
    preview.items.find((i) => i.kind === "api").targetId,
  );
  assert.deepEqual(saved.environments, p.environments);
});
test("native append rejects semantic conflicts and unsupported policies without writes", async (t) => {
  const { store, p, input } = await fixture(t);
  for (const change of [
    (x) => (x.document.project_id = "foreign"),
    (x) =>
      (x.document.global.global_param.header.parameter[0].value = "changed"),
    (x) => (x.document.global.envs[0].name = "changed"),
    (x) => (x.document.apis[1].target_id = "api"),
    (x) => (x.document.apis[0].name = "Moved"),
    (x) => (x.policies = { api: "url" }),
    (x) => (x.folderMap = { Group: "Elsewhere" }),
    (x) => (x.document.samples = [{}]),
  ]) {
    const bad = structuredClone(input);
    change(bad);
    await assert.rejects(store.previewManualImport(p.id, bad, { sessionId }));
    assert.deepEqual(await store.get(p.id), p);
  }
});

import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { snapshotCase } from "../src/cases.mjs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

test("directory append supports a new nested folder and retains frozen snapshots across restart", async (t) => {
  const { root, store, p, input } = await fixture(t, true);
  const frozen = freezeServiceBinding(p, p.requests[0]);
  p.plans = [
    snapshotPlan({
      id: "frozen-plan",
      name: "Frozen",
      steps: [{ id: "step", request: frozen }],
    }),
  ];
  p.cases = [
    snapshotCase({
      id: "frozen-case",
      name: "Frozen",
      sourceRequestId: frozen.id,
      request: frozen,
    }),
  ];
  await store.save(p);
  const before = await store.get(p.id);
  const source = nativeInheritanceFixture();
  source.apis[1].target_id = "added";
  source.apis[1].parent_id = "nested";
  source.apis.push({
    target_id: "nested",
    target_type: "folder",
    parent_id: "folder",
    name: "Nested",
    request: { auth: { type: "inherit" } },
  });
  input.document = nativeDirectoryFixture(source);
  const preview = await store.previewManualImport(p.id, input, { sessionId });
  assert.deepEqual(preview.blockers, []);
  await store.applyManualImport(
    p.id,
    { input, token: preview.token },
    { sessionId },
  );
  const saved = await new Store(root).get(p.id);
  for (const key of ["plans", "cases"])
    assert.deepEqual(saved[key], before[key]);
  for (const entry of before.requestDefinitionHistory?.entries || [])
    assert.deepEqual(
      saved.requestDefinitionHistory.entries.find(
        (e) => e.requestId === entry.requestId,
      ),
      entry,
    );
  assert.equal(saved.requests[1].folder, "Group/Nested");
  assert.deepEqual(freezeServiceBinding(saved, saved.requests[0]), frozen);
});

test("generic saves and imports cannot forge native append authority", async (t) => {
  const { store, p, input } = await fixture(t);
  assert.throws(() =>
    importIntoProject(p, input.document, { inheritanceMode: "preserve" }),
  );
  const forged = structuredClone(p),
    r = structuredClone(p.requests[0]);
  r.id = "forged";
  r.sourceOperationId = "apipost:forged";
  r.nativeInheritance.sourceId = "forged";
  if (r.nativeMockRoute) r.nativeMockRoute.sourceTargetId = "forged";
  forged.requests.push(r);
  forged.settings.nativeInheritance.bindings.push({
    requestId: r.id,
    sourceId: "forged",
    parentId: "folder",
  });
  await assert.rejects(
    store.save(forged, { nativeAppend: { source: forged, context: {} } }),
  );
  assert.deepEqual(await store.get(p.id), p);
});

test("native append cancellation and uncertain publication retain atomic recovery", async (t) => {
  for (const mode of ["cancel", "uncertain"]) {
    const { root, store, p, input } = await fixture(t),
      preview = await store.previewManualImport(p.id, input, { sessionId });
    const controller = new AbortController(),
      originalWrite = fs.promises.writeFile,
      originalRename = fs.promises.rename;
    let gated = 0;
    if (mode === "cancel")
      fs.promises.writeFile = async function (file, ...args) {
        const value = await originalWrite.call(this, file, ...args);
        if (
          String(file).includes(".transaction.json.") &&
          String(file).endsWith(".tmp")
        ) {
          gated++;
          controller.abort();
        }
        return value;
      };
    else
      fs.promises.rename = async function (from, to) {
        const value = await originalRename.call(this, from, to);
        if (String(to).endsWith(".transaction.json")) {
          gated++;
          throw Error("injected after publication");
        }
        return value;
      };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        store.applyManualImport(
          p.id,
          { input, token: preview.token },
          { sessionId, signal: controller.signal },
        ),
        {
          code:
            mode === "cancel"
              ? "MANUAL_IMPORT_ABORTED"
              : "PROJECT_COMMIT_UNCERTAIN",
        },
      );
    } finally {
      fs.promises.writeFile = originalWrite;
      fs.promises.rename = originalRename;
      syncBuiltinESMExports();
    }
    assert.equal(gated, 1);
    const saved = await new Store(root).get(p.id);
    assert.equal(saved.requests.length, mode === "cancel" ? 1 : 2);
    assert.deepEqual(saved.requests[0], p.requests[0]);
    if (mode === "uncertain")
      await assert.rejects(
        store.applyManualImport(
          p.id,
          { input, token: preview.token },
          { sessionId },
        ),
      );
  }
});

test("native append rejects recycled identities, inactive ancestors and cross-kind collisions", async (t) => {
  for (const recycle of ["recycle-requests", "recycle-folder"]) {
    const { store, p, input } = await fixture(t);
    await store.editNativeInheritance(p.id, {
      configRevision: p.configRevision,
      operation:
        recycle === "recycle-folder"
          ? { type: recycle, sourceId: "folder" }
          : { type: recycle, requestIds: [p.requests[0].id] },
    });
    const before = await store.get(p.id);
    if (recycle === "recycle-requests")
      input.document.apis[1].target_id = "api";
    await assert.rejects(store.previewManualImport(p.id, input, { sessionId }));
    assert.deepEqual(await store.get(p.id), before);
  }
  const { store, p, input } = await fixture(t);
  for (const change of [
    (x) => (x.document.apis[1].target_id = "folder"),
    (x) => {
      x.document.apis.push({
        target_id: "api",
        target_type: "folder",
        parent_id: "0",
        name: "Other",
        request: {},
      });
    },
    (x) => (x.document.apis[0].request.auth = { type: "noauth" }),
    (x) => (x.document.apis[1].project_id = "foreign"),
  ]) {
    const value = structuredClone(input);
    change(value);
    await assert.rejects(store.previewManualImport(p.id, value, { sessionId }));
    assert.deepEqual(await store.get(p.id), p);
  }
});
test("changed configuration, source, options and session invalidate the signed native plan", async (t) => {
  const { store, p, input } = await fixture(t),
    preview = await store.previewManualImport(p.id, input, { sessionId });
  for (const [value, session] of [
    [{ ...input, document: { ...input.document, name: "changed" } }, sessionId],
    [{ ...input, selection: { mode: "explicit", keys: [] } }, sessionId],
    [input, "other-session"],
  ])
    await assert.rejects(
      store.applyManualImport(
        p.id,
        { input: value, token: preview.token },
        { sessionId: session },
      ),
    );
  p.name = "newer";
  await store.save(p);
  await assert.rejects(
    store.applyManualImport(
      p.id,
      { input, token: preview.token },
      { sessionId },
    ),
  );
  assert.equal((await store.get(p.id)).requests.length, 1);
});

import http from "node:http";
import { once } from "node:events";
import { createApp } from "../src/server.mjs";
test("owner preview/apply sends no traffic and appended live API retains ancestor inheritance", async (t) => {
  const { root, store, p, input } = await fixture(t),
    wire = [];
  const peer = http
    .createServer((req, res) => {
      wire.push(req.headers);
      res.end("ok");
    })
    .listen(0, "127.0.0.1");
  await once(peer, "listening");
  const url = `http://127.0.0.1:${peer.address().port}`;
  const server = p.servers[0].id;
  p.environments[0].serverUrls[server] = url;
  p.globalVariables.token = "fictional-token";
  p.globalVariableDefinitions.token = {
    initialValue: "fictional-token",
    description: "",
  };
  await store.save(p);
  input.document.global.envs[0].server_list[0].uri = url;
  input.document.global.global_vars.token = {
    value: "fictional-token",
    current_value: "fictional-token",
  };
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    for (const server of [app.server, peer])
      await new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      });
  });
  const call = async (action, body) => {
    const res = await fetch(`${app.url}/api/projects/${p.id}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    const value = await res.json();
    assert.equal(res.status, 200, JSON.stringify(value));
    return value;
  };
  const preview = await call("import-preview", input);
  assert.deepEqual(preview.blockers, []);
  assert.equal(wire.length, 0);
  await call("import-apply", { input, token: preview.token });
  assert.equal(wire.length, 0);
  const saved = await app.store.get(p.id);
  await call("execute", {
    request: saved.requests[1],
    environmentId: saved.environments[0].id,
  });
  assert.equal(wire.length, 1);
  assert.equal(wire[0]["x-folder"], "folder");
  assert.equal(wire[0]["x-shared"], "project");
  assert.equal(wire[0].authorization, "Bearer fictional-token");
});
