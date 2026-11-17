import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCaseFolders,
  saveCaseFolder,
  removeEmptyCaseFolder,
  caseFolderPath,
  caseCards,
} from "../public/case-folders.js";
import { snapshotCase } from "../src/cases.mjs";
function project() {
  return {
    requests: [{ id: "api" }, { id: "other" }],
    cases: [],
    caseFolders: [],
  };
}
test("case folders preserve nested empty groups, ownership and escaped display", () => {
  const p = project();
  saveCaseFolder(
    p,
    undefined,
    { name: "<root>", sourceRequestId: "api" },
    "root",
  );
  saveCaseFolder(
    p,
    undefined,
    { name: "Child", sourceRequestId: "api", parentId: "root" },
    "child",
  );
  assert.equal(caseFolderPath(p.caseFolders, "child"), "<root> / Child");
  assert.match(caseCards(p, "api", new Map(), false), /&lt;root&gt;/);
  assert.match(caseCards(p, "api", new Map(), false), /空用例分组/);
  assert.doesNotMatch(caseCards(p, "other", new Map(), false), /Child/);
  assert.equal(validateCaseFolders(p).length, 2);
});
test("invalid folder edits and nonempty deletes are atomic", () => {
  const p = project();
  saveCaseFolder(
    p,
    undefined,
    { name: "Root", sourceRequestId: "api" },
    "root",
  );
  saveCaseFolder(
    p,
    undefined,
    { name: "Child", sourceRequestId: "api", parentId: "root" },
    "child",
  );
  const before = structuredClone(p);
  for (const edit of [
    { name: "Cycle", sourceRequestId: "api", parentId: "child" },
    { name: "Cross", sourceRequestId: "other" },
    { name: "Missing", sourceRequestId: "api", parentId: "absent" },
  ]) {
    assert.throws(() => saveCaseFolder(p, "root", edit));
    assert.deepEqual(p, before);
  }
  assert.throws(() => removeEmptyCaseFolder(p, "root"));
  assert.deepEqual(p, before);
  p.cases.push(
    snapshotCase({
      name: "Case",
      sourceRequestId: "api",
      folderId: "child",
      request: { url: "https://example.com" },
    }),
  );
  assert.equal(p.cases[0].folderId, "child");
  assert.throws(() => removeEmptyCaseFolder(p, "child"));
  p.cases = [];
  removeEmptyCaseFolder(p, "child");
  removeEmptyCaseFolder(p, "root");
  assert.deepEqual(p.caseFolders, []);
});
test("case folder graph rejects dangling, cross-interface, cyclic and over-depth links", () => {
  for (const mutate of [
    (p) =>
      p.caseFolders.push({ id: "x", name: "X", sourceRequestId: "missing" }),
    (p) =>
      p.caseFolders.push({
        id: "x",
        name: "X",
        sourceRequestId: "api",
        parentId: "x",
      }),
    (p) =>
      p.cases.push({ id: "c", sourceRequestId: "api", folderId: "missing" }),
    (p) => {
      p.caseFolders.push({ id: "x", name: "X", sourceRequestId: "api" });
      p.cases.push({ id: "c", sourceRequestId: "other", folderId: "x" });
    },
    (p) => {
      for (let i = 0; i < 21; i++)
        p.caseFolders.push({
          id: "g" + i,
          name: "G",
          sourceRequestId: "api",
          parentId: i ? "g" + (i - 1) : "",
        });
    },
  ]) {
    const p = project();
    mutate(p);
    assert.throws(() => validateCaseFolders(p));
  }
  const p = project();
  p.caseFolders = Array.from({ length: 1001 }, (_, i) => ({
    id: "g" + i,
    name: "G",
    sourceRequestId: "api",
  }));
  assert.throws(() => validateCaseFolders(p));
  assert.deepEqual(validateCaseFolders({ requests: [], cases: [] }), []);
});

test("HTTP saves enforce case ownership atomically and groups survive restart and backup restore", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path"),
    { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(join(tmpdir(), "case-folders-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    if (app.server.listening) await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (path, method = "GET", body, ok = true) => {
    const r = await fetch(app.url + path, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(r.ok, ok, await r.clone().text());
    return r.json();
  };
  let p = await call("/api/projects", "POST", { name: "Folders" });
  p.requests.push({
    id: "other",
    name: "Other",
    method: "GET",
    url: "https://example.com",
  });
  const source = p.requests[0].id;
  saveCaseFolder(
    p,
    undefined,
    { name: "Root", sourceRequestId: source },
    "root",
  );
  saveCaseFolder(
    p,
    undefined,
    { name: "Child", sourceRequestId: source, parentId: "root" },
    "child",
  );
  p = await call("/api/projects/" + p.id, "PUT", p);
  const created = await call("/api/projects/" + p.id + "/cases", "POST", {
    name: "Saved case",
    sourceRequestId: source,
    folderId: "child",
    request: p.requests[0],
  });
  await call(
    "/api/projects/" + p.id + "/cases",
    "POST",
    {
      name: "Cross",
      sourceRequestId: "other",
      folderId: "child",
      request: p.requests[1],
    },
    false,
  );
  p = await call("/api/projects/" + p.id);
  assert.deepEqual(p.cases, created.project.cases);
  const bad = structuredClone(p);
  bad.caseFolders[0].parentId = "child";
  await call("/api/projects/" + p.id, "PUT", bad, false);
  assert.deepEqual(
    (await call("/api/projects/" + p.id)).caseFolders,
    p.caseFolders,
  );
  await new Promise((r) => app.server.close(r));
  app = await createApp({ root, port: 0 });
  const backup = await call("/api/projects/" + p.id + "/export"),
    copy = await call("/api/restore", "POST", { document: backup });
  assert.deepEqual(copy.caseFolders, p.caseFolders);
  assert.deepEqual(copy.cases, p.cases);
  const broken = structuredClone(backup);
  broken.caseFolders = [];
  await call("/api/restore", "POST", { document: broken }, false);
});

test("case evidence distinguishes missing response status from an unsent request", () => {
  const p = project();
  p.cases = [
    {
      id: "case",
      name: "Case",
      sourceRequestId: "api",
      request: { method: "GET", url: "https://example.test" },
    },
  ];
  const render = (result) =>
    caseCards(
      p,
      "api",
      new Map([["case", result]]),
      false,
      new Set(),
      new Set(["case"]),
    );
  const interrupted = render({ outcome: "failed", error: "cancelled" });
  assert.match(interrupted, /未取得HTTP响应/);
  assert.doesNotMatch(interrupted, /未请求|未发送/);
  const unsent = render({ outcome: "not-run" });
  assert.match(unsent, /本批次未运行.*未发送/);
  assert.match(render({ outcome: "passed", status: 200 }), /通过.*HTTP 200/);
});
