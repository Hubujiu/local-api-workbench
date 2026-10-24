import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
test("modern description-only library imports without inventing parameter types or values", () => {
  const source = modernApipostFixture();
  source.global.describe_library = [
    {
      id: "description-id",
      project_id: "fixture",
      key: "account_id",
      description: "账户标识",
    },
  ];
  const p = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
  importIntoProject(p, source);
  assert.deepEqual(p.settings.parameterDescriptions, [
    {
      key: "account_id",
      description: "账户标识",
      apipostSource: { projectId: "fixture", id: "description-id" },
    },
  ]);
  assert.equal(p.parameterDictionary, undefined);
});

test("description import conflicts and unsupported metadata are atomic", () => {
  for (const rows of [
    [{ key: "id", description: "changed" }],
    [{ key: "x", description: "a", extra: 1 }],
    [{ key: "x", description: "a", project_id: "foreign" }],
    [
      { key: "x", description: "a" },
      { key: "x", description: "b" },
    ],
  ]) {
    const p = {
      requests: [],
      folders: [],
      environments: [],
      servers: [],
      globalVariables: {},
      settings: {
        statuses: [],
        parameterDescriptions: [{ key: "id", description: "original" }],
      },
    };
    const before = structuredClone(p),
      source = modernApipostFixture();
    source.global.describe_library = rows;
    assert.throws(() => importIntoProject(p, source));
    assert.deepEqual(p, before);
  }
});
test("description rows and rendered choices are bounded inert data", async () => {
  const {
    validateParameterDescriptions,
    parameterDescriptionsPanel,
    parameterDescriptionChoices,
  } = await import("../public/parameter-descriptions.js");
  const { mergeApipostDescriptions } = await import(
    "../src/apipost-descriptions.mjs"
  );
  for (const rows of [
    Array(2),
    [{ key: "x", description: "a".repeat(8001) }],
    Array.from({ length: 2001 }, (_, i) => ({
      key: String(i),
      description: "",
    })),
    Array.from({ length: 150 }, (_, i) => ({
      key: String(i),
      description: "a".repeat(8000),
    })),
  ])
    assert.throws(() => validateParameterDescriptions(rows));
  let calls = 0;
  const rows = [];
  Object.defineProperty(rows, "0", {
    enumerable: true,
    get() {
      calls++;
      return { key: "x", description: "" };
    },
  });
  assert.throws(() => mergeApipostDescriptions(rows, [], "fixture"));
  assert.equal(calls, 0);
  const malicious = [
    { key: "<x>", description: "</option><script>bad()</script>" },
  ];
  assert.ok(
    !parameterDescriptionsPanel({
      settings: { parameterDescriptions: malicious },
    }).includes("<script>"),
  );
  assert.ok(!parameterDescriptionChoices(malicious, "x").includes("<script>"));
  assert.match(parameterDescriptionChoices(malicious, "x"), /&lt;script&gt;/);
});

test("HTTP import and local backup restore retain description-only library", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(join(tmpdir(), "parameter-descriptions-"));
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
  const p = await call("/api/projects", "POST", { name: "Descriptions" }),
    source = modernApipostFixture();
  source.global.describe_library = [
    { key: "account_id", description: "Account" },
    { key: "empty" },
  ];
  const imported = await call("/api/projects/" + p.id + "/import", "POST", {
    document: source,
  });
  await new Promise((resolve) => app.server.close(resolve));
  app = await createApp({ root, port: 0 });
  const backup = await call("/api/projects/" + p.id + "/export"),
    copy = await call("/api/restore", "POST", { document: backup });
  assert.notEqual(copy.id, p.id);
  assert.deepEqual(
    copy.settings.parameterDescriptions,
    imported.settings.parameterDescriptions,
  );
  assert.equal(copy.settings.parameterDescriptions[1].description, "");
  assert.deepEqual(
    (await call("/api/projects/" + p.id)).settings.parameterDescriptions,
    imported.settings.parameterDescriptions,
  );
});
