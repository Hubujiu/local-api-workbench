import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { exportApipost, apipostExportId } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import {
  prepareApipostAttributeExport,
  verifyApipostAttributeExport,
} from "../src/apipost-attribute-export.mjs";
import {
  attributeDocument,
  blankAttributeProject,
  attributeSemantics,
  emittedAttributes,
} from "./fixtures/apipost-export-attributes.mjs";
import { nativeSampleExportFixture } from "./fixtures/apipost-sample-export.mjs";
const formats = [
  ["apipost", exportApipost],
  ["apipost-directory", exportApipostDirectory],
];
function fixture() {
  const p = blankAttributeProject("source");
  importIntoProject(p, attributeDocument());
  return p;
}

test("unreferenced and disabled definitions survive alone; equal raw IDs from distinct source projects do not collide", () => {
  const p = blankAttributeProject("combined");
  importIntoProject(p, attributeDocument(undefined, "first-source"));
  importIntoProject(p, attributeDocument(undefined, "second-source"));
  assert.equal(p.settings.attributes.length, 18);
  assert.equal(new Set(p.settings.attributes.map((f) => f.key)).size, 18);
  const before = structuredClone(p);
  for (const [format, encode] of formats) {
    const output = JSON.parse(JSON.stringify(encode(p))),
      next = blankAttributeProject("next");
    importIntoProject(next, output);
    assert.equal(emittedAttributes(output, format).fields.length, 18);
    assert.deepEqual(attributeSemantics(next), attributeSemantics(p));
    const alone = structuredClone(p);
    alone.requests = [];
    assert.equal(emittedAttributes(encode(alone), format).fields.length, 18);
  }
  assert.deepEqual(p, before);
});

test("native identity distinguishes Unicode, case and lone surrogate local keys and remaps each explicit reference", () => {
  const p = fixture(),
    keys = ["\ud800", "\ud801", "界", "A", "a"];
  p.settings.attributes = keys.map((key) => ({
    key,
    label: "Same",
    type: "string",
  }));
  p.requests[0].attributes = Object.fromEntries(
    keys.map((key, i) => [key, String(i)]),
  );
  p.requests[1].attributes = {};
  for (const [format, encode] of formats) {
    const first = encode(p),
      second = encode(p),
      emitted = emittedAttributes(first, format);
    assert.deepEqual(emitted.fields, emittedAttributes(second, format).fields);
    assert.equal(
      new Set(emitted.fields.map((f) => f.attribute_id)).size,
      keys.length,
    );
    const copy = blankAttributeProject("copy");
    importIntoProject(copy, JSON.parse(JSON.stringify(first)));
    assert.deepEqual(
      copy.settings.attributes.map((f) => copy.requests[0].attributes[f.key]),
      keys.map((_, i) => String(i)),
    );
  }
});

test("unsupported definitions, invalid provenance, dangling and non-JSON values reject without mutation", () => {
  for (const change of [
    (p) => (p.settings.attributes[0].type = "boolean"),
    (p) => (p.settings.attributes[0].required = false),
    (p) => (p.settings.attributes[0].default = ""),
    (p) => (p.settings.attributes[0].unknown = undefined),
    (p) => (p.settings.attributes[0].open_api_field = ""),
    (p) => (p.settings.attributes[0].options = ["stale option"]),
    (p) => (p.settings.attributes[0].apipostSource.sort = 1.2),
    (p) => (p.settings.attributes[0].apipostSource.unknown = true),
    (p) => (p.settings.attributes[0].apipostSource.projectId = null),
    (p) => (p.settings.attributes[3].options[0].unknown = false),
    (p) =>
      p.settings.attributes.push(structuredClone(p.settings.attributes[0])),
    (p) => (p.requests[0].attributes.unknown = null),
    (p) => (p.requests[0].attributes.unknown = ""),
    (p) => (p.requests[0].attributes[p.settings.attributes[0].key] = undefined),
    (p) => (p.requests[0].attributes[p.settings.attributes[1].key] = -0),
    (p) => (p.requests[0].attributes[p.settings.attributes[1].key] = Infinity),
    (p) =>
      (p.requests[0].attributes[p.settings.attributes[4].key] =
        "2026-11-03T00:00:00Z"),
    (p) =>
      (p.requests[0].attributes[p.settings.attributes[3].key] = ["a", "a"]),
  ]) {
    const p = fixture();
    change(p);
    const before = structuredClone(p);
    for (const [, encode] of formats) assert.throws(() => encode(p));
    assert.deepEqual(p, before);
  }
});

test("all attribute accessors and proxy traps are rejected before normalizing, encoding or cloning", () => {
  for (const position of [
    "settings",
    "array",
    "field",
    "origin",
    "option",
    "request",
    "value",
    "selection",
    "sample",
    "plan",
  ])
    for (const [, encode] of formats) {
      const p = fixture();
      let calls = 0;
      const getter = {
        enumerable: true,
        get() {
          calls++;
          throw Error("must not invoke");
        },
      };
      const fields = p.settings.attributes;
      if (position === "settings")
        Object.defineProperty(p.settings, "attributes", getter);
      if (position === "array") Object.defineProperty(fields, "0", getter);
      if (position === "field")
        Object.defineProperty(fields[0], "label", getter);
      if (position === "origin")
        Object.defineProperty(fields[0].apipostSource, "projectId", getter);
      if (position === "option")
        Object.defineProperty(fields[3].options[0], "value", getter);
      if (position === "request")
        Object.defineProperty(p.requests[0], "attributes", getter);
      if (position === "value")
        Object.defineProperty(p.requests[0].attributes, fields[0].key, getter);
      if (position === "selection")
        Object.defineProperty(
          p.requests[0].attributes[fields[3].key],
          "0",
          getter,
        );
      if (position === "sample") {
        p.cases = [{ request: {} }];
        Object.defineProperty(p.cases[0].request, "attributes", getter);
      }
      if (position === "plan") {
        p.plans = [{ steps: [{ request: {} }] }];
        Object.defineProperty(
          p.plans[0].steps[0].request,
          "attributes",
          getter,
        );
      }
      assert.throws(() => encode(p));
      assert.equal(calls, 0, position);
    }
  for (const place of ["array", "field", "origin", "values", "selection"]) {
    const p = fixture();
    let calls = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          calls++;
        },
        ownKeys() {
          calls++;
          return [];
        },
        getPrototypeOf() {
          calls++;
          return Object.prototype;
        },
      },
    );
    if (place === "array") p.settings.attributes = proxy;
    if (place === "field") p.settings.attributes[0] = proxy;
    if (place === "origin") p.settings.attributes[0].apipostSource = proxy;
    if (place === "values") p.requests[0].attributes = proxy;
    if (place === "selection")
      p.requests[0].attributes[p.settings.attributes[3].key] = proxy;
    for (const [, encode] of formats) assert.throws(() => encode(p));
    assert.equal(calls, 0, place);
  }
});

test("samples without attribute values retain existing behavior but populated unsupported snapshot classes refuse", () => {
  const sample = blankAttributeProject("samples");
  importIntoProject(sample, nativeSampleExportFixture());
  for (const [, encode] of formats) assert.doesNotThrow(() => encode(sample));
  sample.cases[0].request.attributes = { unknown: null };
  for (const [, encode] of formats) assert.throws(() => encode(sample), /属性/);
  for (const kind of ["documents", "protocols", "plan"]) {
    const p = fixture(),
      values = { [p.settings.attributes[0].key]: "cannot silently drop" };
    if (kind === "plan")
      p.plans = [{ steps: [{ request: { attributes: values } }] }];
    else p[kind] = [{ attributes: values }];
    for (const [, encode] of formats) assert.throws(() => encode(p), /属性/);
  }
});

test("exact existing limits and finite non-integer numbers survive; oversize and four-MiB output reject", () => {
  const p = fixture();
  p.settings.attributes = Array.from({ length: 100 }, (_, i) => ({
    key: i === 0 ? "k".repeat(200) : "k" + i,
    label: "L".repeat(200),
    type: "string",
    description: "d".repeat(2000),
  }));
  p.requests[0].attributes = Object.fromEntries(
    p.settings.attributes.map((f) => [f.key, "v".repeat(4000)]),
  );
  p.requests[1].attributes = {};
  for (const [, encode] of formats) assert.doesNotThrow(() => encode(p));
  const before = structuredClone(p);
  p.settings.attributes.push({ key: "overflow", label: "x", type: "string" });
  for (const [, encode] of formats) assert.throws(() => encode(p));
  Object.assign(p, structuredClone(before));
  p.settings.attributes[0].key += "x";
  for (const [, encode] of formats) assert.throws(() => encode(p));
  const large = structuredClone(before);
  large.requests = Array.from({ length: 12 }, (_, i) => ({
    ...structuredClone(before.requests[0]),
    id: "r" + i,
  }));
  for (const [, encode] of formats) assert.throws(() => encode(large), /4MiB/);
  const number = fixture();
  number.requests[0].attributes[number.settings.attributes[1].key] =
    Number.MAX_VALUE;
  for (const [, encode] of formats) assert.doesNotThrow(() => encode(number));
  number.requests[0].attributes[number.settings.attributes[1].key] = 0.25;
  for (const [, encode] of formats) assert.doesNotThrow(() => encode(number));
});

test("complete readback rejects missing definitions, swapped equal-label identities and changed explicit values", () => {
  const p = fixture(),
    output = exportApipost(p),
    prepared = prepareApipostAttributeExport(p, output.project_id);
  for (const mutate of [
    (c) => c.settings.attributes.pop(),
    (c) =>
      ([
        c.settings.attributes[0].apipostSource.attributeId,
        c.settings.attributes[1].apipostSource.attributeId,
      ] = [
        c.settings.attributes[1].apipostSource.attributeId,
        c.settings.attributes[0].apipostSource.attributeId,
      ]),
    (c) => delete c.requests[1].attributes[c.settings.attributes[0].key],
    (c) => (c.requests[1].attributes[c.settings.attributes[1].key] = ""),
    (c) => (c.requests[0].sourceOperationId = "unmatched"),
  ]) {
    const check = blankAttributeProject("readback");
    importIntoProject(check, JSON.parse(JSON.stringify(output)));
    mutate(check);
    assert.throws(
      () =>
        verifyApipostAttributeExport(p, check, prepared, (id) =>
          apipostExportId("a", id),
        ),
      /属性/,
    );
  }
});

test("inherited accessors and non-string destination identity cannot bypass the own-data preflight", () => {
  for (const position of [
    "project",
    "settings",
    "request",
    "sample",
    "plan",
    "document",
    "protocol",
  ])
    for (const [, encode] of formats) {
      const p = fixture();
      let calls = 0;
      const prototype = {
        get attributes() {
          calls++;
          return {};
        },
      };
      if (position === "project") Object.setPrototypeOf(p, prototype);
      if (position === "settings") Object.setPrototypeOf(p.settings, prototype);
      if (position === "request") {
        delete p.requests[0].attributes;
        Object.setPrototypeOf(p.requests[0], prototype);
      }
      if (position === "sample")
        p.cases = [{ request: Object.create(prototype) }];
      if (position === "plan")
        p.plans = [{ steps: [{ request: Object.create(prototype) }] }];
      if (position === "document") p.documents = [Object.create(prototype)];
      if (position === "protocol") p.protocols = [Object.create(prototype)];
      assert.throws(() => encode(p));
      assert.equal(calls, 0, position);
    }
  let calls = 0;
  const destination = {
    toJSON() {
      calls++;
      return "project";
    },
  };
  assert.throws(() => prepareApipostAttributeExport(fixture(), destination));
  assert.equal(calls, 0);
  const p = fixture();
  p.settings.attributes = null;
  for (const [, encode] of formats) assert.throws(() => encode(p));
});

test("field text, option and value bounds are exact and neither defaults nor selection identities are invented", () => {
  const p = fixture();
  const options = Array.from({ length: 200 }, (_, i) => ({
    value: "v" + i + "x".repeat(196 - String(i).length),
    label: "L".repeat(200),
  }));
  p.settings.attributes[2].options = structuredClone(options);
  p.settings.attributes[3].options = structuredClone(options);
  p.requests[0].attributes[p.settings.attributes[2].key] = options[199].value;
  p.requests[0].attributes[p.settings.attributes[3].key] = options
    .map((o) => o.value)
    .reverse();
  for (const [, encode] of formats) assert.doesNotThrow(() => encode(p));
  for (const change of [
    (q) => (q.settings.attributes[0].label = "x".repeat(201)),
    (q) => (q.settings.attributes[0].description = "x".repeat(2001)),
    (q) =>
      q.settings.attributes[2].options.push({ value: "extra", label: "extra" }),
    (q) => (q.settings.attributes[2].options[0].value = "x".repeat(201)),
    (q) => (q.settings.attributes[2].options[0].label = "x".repeat(201)),
    (q) =>
      (q.requests[0].attributes[q.settings.attributes[0].key] = "x".repeat(
        4001,
      )),
    (q) => (q.settings.attributes[2].options[0].default = true),
  ]) {
    const changed = structuredClone(p);
    change(changed);
    for (const [, encode] of formats) assert.throws(() => encode(changed));
  }
  const shorthand = fixture();
  shorthand.settings.attributes[2].options = ["a", "b"];
  for (const [, encode] of formats)
    assert.doesNotThrow(() => encode(shorthand));
});

test("valid directory HTTP snapshots remain supported only when their explicit attribute maps are empty", () => {
  const p = fixture(),
    request = { ...structuredClone(p.requests[0]), attributes: {} };
  p.plans = [
    snapshotPlan({
      id: "plan",
      name: "Frozen",
      statusPolicy: "strict200",
      environmentId: p.environments[0].id,
      steps: [{ id: "step", name: request.name, request }],
    }),
  ];
  const before = structuredClone(p),
    output = exportApipostDirectory(p);
  assert.ok(
    output.files.some(
      (f) =>
        f.path.startsWith("executions/flows/") &&
        f.path !== "executions/flows/index.json",
    ),
  );
  assert.deepEqual(p, before);
  p.plans[0].steps[0].request.attributes[p.settings.attributes[0].key] =
    "snapshot cannot be represented";
  assert.throws(() => exportApipostDirectory(p), /计划/);
});
