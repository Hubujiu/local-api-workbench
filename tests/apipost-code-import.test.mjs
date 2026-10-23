import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const project = () => ({
  requests: [],
  folders: [],
  environments: [],
  servers: [],
  globalVariables: {},
  settings: { statuses: [] },
});
test("modern Apipost code dictionaries retain string codes and labels without enabling HTTP hints", () => {
  const source = modernApipostFixture();
  source.global.codes = [
    {
      code_id: "leading",
      project_id: "fixture",
      code_number: "001",
      code_msg: "保留前导零",
    },
    { code_number: 409, code_msg: "业务冲突" },
  ];
  const original = structuredClone(source),
    p = project();
  importIntoProject(p, source);
  assert.deepEqual(source, original);
  assert.deepEqual(p.settings.statusCodes, [
    {
      code: "001",
      label: "保留前导零",
      apipostSource: { projectId: "fixture", codeId: "leading" },
    },
    { code: 409, label: "业务冲突" },
  ]);
  assert.ok(p.settings.statusCodes.every((x) => x.httpHint !== true));
});

test("code import is atomic for conflicts, invalid or unknown fields and duplicate canonical codes", () => {
  for (const codes of [
    [{ code_number: "ERR", code_msg: "changed" }],
    [{ code_number: "A", code_msg: "ok", extra: 1 }],
    [{ code_number: "A", code_msg: "ok", project_id: "foreign" }],
    [
      { code_number: 200, code_msg: "a" },
      { code_number: "200", code_msg: "b" },
    ],
    [
      { code_number: "A", code_msg: "a", code_id: "same" },
      { code_number: "B", code_msg: "b", code_id: "same" },
    ],
    [{ code_number: "A", code_msg: "" }],
  ]) {
    const p = project();
    p.settings.statusCodes = [
      { code: "ERR", label: "original", httpHint: false },
    ];
    const before = structuredClone(p),
      source = modernApipostFixture();
    source.global.codes = codes;
    assert.throws(() => importIntoProject(p, source));
    assert.deepEqual(p, before);
  }
});
test("equal code definitions keep local options and repeated import does not duplicate them", () => {
  const p = project(),
    source = modernApipostFixture();
  p.settings.statusCodes = [{ code: 409, label: "Conflict", httpHint: true }];
  source.global.codes = [
    { code_number: "409", code_msg: "Conflict" },
    { code_number: "BUSINESS", code_msg: "Business" },
  ];
  importIntoProject(p, source);
  importIntoProject(p, source);
  assert.deepEqual(p.settings.statusCodes, [
    { code: 409, label: "Conflict", httpHint: true },
    { code: "BUSINESS", label: "Business" },
  ]);
});
test("code import rejects accessors without invoking them", async () => {
  const { mergeApipostCodes } = await import("../src/apipost-codes.mjs");
  let calls = 0;
  const row = {
    code_number: "A",
    get code_msg() {
      calls++;
      return "x";
    },
  };
  assert.throws(() => mergeApipostCodes([row], [], "fixture"));
  const rows = [];
  Object.defineProperty(rows, "0", {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  assert.throws(() => mergeApipostCodes(rows, [], "fixture"));
  assert.equal(calls, 0);
});

test("HTTP project import persists code definitions through restart and native export", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(join(tmpdir(), "apipost-codes-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    if (app.server.listening)
      await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (url, method = "GET", body) => {
    const r = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(r.ok, true, await r.clone().text());
    return r.json();
  };
  const p = await call("/api/projects", "POST", { name: "Code import" }),
    source = modernApipostFixture();
  source.global.codes = [
    {
      code_number: "0007",
      code_msg: "业务失败",
      code_id: "seven",
      project_id: "fixture",
    },
  ];
  const imported = await call("/api/projects/" + p.id + "/import", "POST", {
    document: source,
  });
  await new Promise((resolve) => app.server.close(resolve));
  app = await createApp({ root, port: 0 });
  const restored = await call("/api/projects/" + p.id),
    exported = await call("/api/projects/" + p.id + "/export");
  assert.deepEqual(
    restored.settings.statusCodes,
    imported.settings.statusCodes,
  );
  assert.deepEqual(
    exported.settings.statusCodes,
    imported.settings.statusCodes,
  );
  assert.equal(exported.settings.statusCodes[0].code, "0007");
});

test("previously empty dictionary placeholders remain importable", () => {
  for (const value of [undefined, null, "", {}, []]) {
    const p = project(),
      source = modernApipostFixture();
    p.settings.statusCodes = null;
    source.global.codes = value;
    importIntoProject(p, source);
    assert.deepEqual(p.settings.statusCodes, []);
  }
});
