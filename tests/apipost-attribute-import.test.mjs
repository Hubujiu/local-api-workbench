import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import {
  attributeFields,
  attributeChooser,
  attributeHTML,
} from "../public/attribute-view.js";
const project = () => ({
  requests: [],
  folders: [],
  environments: [],
  servers: [],
  globalVariables: {},
  settings: { statuses: [] },
});
const definition = (attribute_id, field_type, extra = []) => ({
  attribute_id,
  project_id: "fixture",
  field_name: attribute_id,
  field_type,
  enable: 1,
  tooltip: "填写 " + attribute_id,
  sort: 1,
  extra,
  open_api_field: "",
});

test("modern attribute definitions and values retain types, options, disabled data and escaped help", () => {
  const source = modernApipostFixture();
  source.global.attributes = [
    definition("text", 1),
    definition("number", 2),
    definition("single", 3, [{ key: "a", value: "甲" }]),
    definition("multi", 4, [
      { key: "a", value: "甲" },
      { key: "b", value: "乙" },
    ]),
    definition("date", 5),
    definition("url", 6),
    definition("email", 7),
    { ...definition("hidden", 1), enable: -1 },
  ];
  source.apis[1].attribute_info = {
    text: "<text>",
    number: 0,
    single: "a",
    multi: ["b", "a"],
    date: "2026-10-23",
    url: "https://example.test",
    email: "user@example.test",
    hidden: "hidden value",
  };
  const snapshot = structuredClone(source),
    p = project();
  importIntoProject(p, source);
  assert.deepEqual(source, snapshot);
  const fields = p.settings.attributes,
    values = p.requests[0].attributes;
  for (const field of fields)
    assert.deepEqual(
      values[field.key],
      source.apis[1].attribute_info[field.label],
    );
  assert.deepEqual(
    fields.map((x) => x.type),
    [
      "string",
      "number",
      "select",
      "multiselect",
      "date",
      "url",
      "email",
      "string",
    ],
  );
  const hidden = fields.find((x) => x.label === "hidden");
  assert.equal(hidden.enabled, false);
  assert.equal(attributeFields(fields, values).includes("hidden value"), false);
  assert.match(attributeFields(fields, values), /&lt;text&gt;/);
  assert.match(attributeFields(fields, values), /填写 text/);
  assert.equal(attributeChooser(p).includes(hidden.key), false);
  assert.equal(attributeHTML(p, p.requests[0], [hidden.key]), "");
});

test("attribute import rejects unresolved, lossy and conflicting metadata atomically", () => {
  for (const change of [
    (d) => {
      d.global.attributes[0].enable = null;
    },
    (d) => {
      d.global.attributes[0].field_type = null;
    },
    (d) => {
      d.apis[1].attribute_info = { missing: "x" };
    },
    (d) => {
      d.global.attributes[0].open_api_field = "x-custom";
    },
    (d) => {
      d.global.attributes[0].field_type = "1";
    },
    (d) => {
      d.global.attributes[0].enable = 2;
    },
    (d) => {
      d.global.attributes[0].extra = [{ key: "a", value: "a" }];
    },
    (d) => {
      d.global.attributes[0].unknown = true;
    },
    (d) => {
      d.global.attributes.push({ ...d.global.attributes[0] });
    },
    (d) => {
      d.global.attributes[0].field_type = 5;
      d.apis[1].attribute_info = { text: "2026-10-23T00:00:00Z" };
    },
    (d) => {
      d.apis[0].attribute_info = { text: "folder value" };
    },
  ]) {
    const source = modernApipostFixture(),
      p = project();
    source.global.attributes = [definition("text", 1)];
    change(source);
    const before = structuredClone(p);
    assert.throws(() => importIntoProject(p, source));
    assert.deepEqual(p, before);
  }
  const source = modernApipostFixture(),
    p = project();
  source.global.attributes = [definition("text", 1)];
  importIntoProject(p, source);
  const before = structuredClone(p);
  source.global.attributes[0].field_name = "Changed";
  assert.throws(() => importIntoProject(p, source), /冲突/);
  assert.deepEqual(p, before);
});

test("disabled attribute settings remain validated and help is safely escaped", async () => {
  const { validateAttributeDefinitions } = await import(
    "../public/attribute-model.js"
  );
  for (const field of [
    { key: "a", label: "A", type: "string", enabled: 1 },
    { key: "a", label: "A", type: "string", description: {} },
  ])
    assert.throws(() => validateAttributeDefinitions([field]));
  const field = {
    key: "a",
    label: "A",
    type: "string",
    description: '" onmouseover="bad <x>',
  };
  const html = attributeFields([field], { a: "value" });
  assert.match(html, /&quot; onmouseover=&quot;bad &lt;x&gt;/);
  assert.ok(!html.includes(' onmouseover="'));
});

test("HTTP import and restart preserve attribute definitions and disabled values", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(join(tmpdir(), "apipost-attributes-"));
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
  const p = await call("/api/projects", "POST", { name: "Attribute import" }),
    source = modernApipostFixture();
  source.global.attributes = [{ ...definition("hidden", 2), enable: 0 }];
  source.apis[1].attribute_info = { hidden: 0 };
  const imported = await call("/api/projects/" + p.id + "/import", "POST", {
    document: source,
  });
  await new Promise((resolve) => app.server.close(resolve));
  app = await createApp({ root, port: 0 });
  const exported = await call("/api/projects/" + p.id + "/export");
  assert.deepEqual(exported.settings.attributes, imported.settings.attributes);
  assert.deepEqual(
    exported.requests[0].attributes,
    imported.requests[0].attributes,
  );
  assert.equal(
    exported.requests[0].attributes[exported.settings.attributes[0].key],
    0,
  );
});
