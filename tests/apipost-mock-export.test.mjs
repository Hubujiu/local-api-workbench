import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { nativeMockFixture } from "./fixtures/apipost-native-mock.mjs";

async function close(app) {
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
}
function normalized(mock) {
  const copy = structuredClone(mock);
  delete copy.sourceTargetId;
  return copy;
}

test("conditional Mock survives authenticated JSON/directory export, real HTTP, isolated restore and restart without modifying document examples", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mock-export-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await close(app);
    await rm(root, { recursive: true, force: true });
  });
  const { directory, config } = nativeMockFixture();
  const rule = structuredClone(config.ai_expect.list[0]);
  rule.id = "disabled";
  rule.desc = "Disabled first";
  rule.enable = -1;
  rule.conditions = [];
  config.ai_expect.list.unshift(rule);
  const raw = structuredClone(config.ai_expect.list[1]);
  raw.id = "raw";
  raw.desc = "Raw JSON";
  raw.expect_id = "0";
  raw.example = {
    example_id: "raw",
    expect: {
      code: "201",
      content_type: "json",
      name: "raw",
      schema: {},
      sleep: 1,
    },
    headers: [{ key: "x-native-rule", value: "raw", is_checked: 1 }],
    raw: ' {"raw":true} ',
    raw_parameter: [],
  };
  raw.conditions = [
    {
      conditionId: "raw",
      location: "query",
      name: "mode",
      compareType: "eq",
      value: "raw",
    },
  ];
  config.ai_expect.list.unshift(raw);
  const nested = structuredClone(raw);
  nested.id = "nested";
  nested.conditions = [
    {
      conditionId: "header",
      location: "header",
      name: "x-kind",
      compareType: "eq",
      value: "nested",
    },
    {
      conditionId: "body",
      location: "body",
      name: '["名.值"].items[0].ok',
      compareType: "eq",
      value: true,
    },
  ];
  config.ai_expect.list.unshift(nested);
  directory.files.find((f) => f.path === "settings/mock_api.json").text =
    JSON.stringify(config);
  const sourceBytes = JSON.stringify(directory);
  const p = await app.store.create("Conditional export");
  importIntoProject(p, directory);
  await app.store.save(p);
  const before = await app.store.get(p.id);
  const ids = [p.id];
  const check = async (id) => {
    const project = await app.store.get(id);
    const url = `${app.url}/mock/${id}/${project.requests[0].id}`;
    assert.equal(
      project.requests[0].nativeMock.rules.find((r) => r.id === "rule").response
        .sourceStatus,
      404,
    );
    for (const ok of [true, false]) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-kind": "nested" },
        body: JSON.stringify({ "名.值": { items: [{ ok }] } }),
      });
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("x-native-rule"),
        ok ? "raw" : "fallback",
      );
      assert.equal(
        await response.text(),
        ok ? ' {"raw":true} ' : '{"kind":"fallback"}',
      );
    }
    for (const [query, branch, body] of [
      ["?mode=fail", "matched", '{"kind":"matched"}'],
      ["?mode=other", "fallback", '{"kind":"fallback"}'],
      ["?mode=other&mode=fail", "matched", '{"kind":"matched"}'],
      ["?mode=fail&mode=other", "fallback", '{"kind":"fallback"}'],
      ["?mode=raw", "raw", ' {"raw":true} '],
    ]) {
      const r = await fetch(url + query);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-native-rule"), branch);
      assert.equal(await r.text(), body);
    }
  };
  await check(p.id);
  for (const format of ["apipost", "apipost-directory"]) {
    const url = `${app.url}/api/projects/${p.id}/export?format=${format}`;
    assert.equal((await fetch(url)).status, 403);
    const response = await fetch(url, {
      headers: { "x-local-token": app.token },
    });
    assert.equal(response.status, 200);
    const output = await response.json();
    const target = await app.store.create(format);
    target.environments = [];
    importIntoProject(target, output);
    await app.store.save(target);
    ids.push(target.id);
    assert.deepEqual(
      normalized(target.requests[0].nativeMock),
      normalized(before.requests[0].nativeMock),
    );
    assert.deepEqual(target.requests[0].examples, before.requests[0].examples);
    assert.deepEqual(
      target.requests[0].responses,
      before.requests[0].responses,
    );
    await check(target.id);
    const again =
      format === "apipost"
        ? exportApipost(target)
        : exportApipostDirectory(target);
    const third = await app.store.create("Again");
    third.environments = [];
    importIntoProject(third, again);
    await app.store.save(third);
    ids.push(third.id);
    await check(third.id);
  }
  assert.deepEqual(await app.store.get(p.id), before);
  assert.equal(JSON.stringify(directory), sourceBytes);
  const restored = restoreProject(before);
  await app.store.save(restored);
  ids.push(restored.id);
  await check(restored.id);
  const other = await app.store.get(ids[1]);
  other.requests[0].nativeMock.enabled = false;
  await app.store.save(other);
  assert.equal(
    (await fetch(`${app.url}/mock/${other.id}/${other.requests[0].id}`)).status,
    404,
  );
  await check(p.id);
  for (const format of ["apipost", "apipost-directory"]) {
    const response = await fetch(
      `${app.url}/api/projects/${other.id}/export?format=${format}`,
      { headers: { "x-local-token": app.token } },
    );
    assert.equal(response.status, 200);
    const disabled = await app.store.create("Disabled roundtrip");
    disabled.environments = [];
    importIntoProject(disabled, await response.json());
    await app.store.save(disabled);
    assert.equal(disabled.requests[0].nativeMock.enabled, false);
    assert.equal(
      (
        await fetch(
          `${app.url}/mock/${disabled.id}/${disabled.requests[0].id}?mode=fail`,
        )
      ).status,
      404,
    );
  }
  await close(app);
  app = await createApp({ root, port: 0 });
  for (const id of ids.filter((id) => id !== other.id)) await check(id);
});

test("conditional Mock export rejects unsupported semantics atomically and never evaluates patterns or source scripts", () => {
  const p = {
    id: "p",
    name: "p",
    requests: [],
    environments: [],
    settings: {},
  };
  importIntoProject(p, nativeMockFixture().directory);
  const variations = [
    (p) =>
      (p.requests[0].nativeMock.fallback.schema = {
        $ref: "#/components/schemas/X",
        type: "object",
      }),
    (p) =>
      (p.requests[0].nativeMock.fallback = {
        status: 200,
        sourceStatus: 200,
        headers: {},
        delayMs: 0,
        serialization: "raw-xml",
        body: "<x/>",
      }),
    (p) =>
      (p.requests[0].nativeMock.fallback = {
        status: 200,
        sourceStatus: 200,
        headers: {},
        delayMs: 0,
        serialization: "scalar-text",
        schema: { type: "string", const: "x" },
      }),
    (p) =>
      (p.requests[0].nativeMock.fallback = {
        status: 200,
        sourceStatus: 200,
        body: "plain",
      }),
    (p) => (p.settings.mockFieldRules = [{ name: "dependency" }]),
    (p) =>
      (p.settings.apipostDirectoryArtifacts = [
        {
          sourceProjectId: "fixture",
          files: [{ path: "settings/mock_inner_rules.json", text: "[]" }],
        },
      ]),
    (p) => (p.requests[0].mockRules = [{ id: "mixed" }]),
  ];
  for (const mutate of variations) {
    const changed = structuredClone(p);
    mutate(changed);
    const before = structuredClone(changed);
    for (const exporter of [exportApipost, exportApipostDirectory])
      assert.throws(() => exporter(changed));
    assert.deepEqual(changed, before);
  }
  p.requests[0].nativeMock.rules[0].conditions = [
    { path: "$.query['名.值']", op: "regularmatch", value: "/[bad/" },
  ];
  // Invalid execution syntax remains inert during format conversion.
  assert.doesNotThrow(() => exportApipost(p));
});
