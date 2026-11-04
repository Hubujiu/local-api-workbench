// Synthetic cross-feature contracts; no original-GUI compatibility claim.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  importIntoProject,
  restoreProject,
  snapshotPlan,
  runPlan,
} from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { sampleFromSchema } from "../src/schema-sample.mjs";
import { blankAttributeProject } from "./fixtures/apipost-export-attributes.mjs";
import {
  combinedDocument,
  catalogueSemantics,
} from "./fixtures/apipost-attribute-catalogues.mjs";

function fixture() {
  const p = blankAttributeProject("three-catalogue-mock");
  importIntoProject(p, combinedDocument("http://127.0.0.1:1/no-outbound"));
  return p;
}
const schema = (possible = true) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "array",
  minItems: 2,
  maxItems: 2,
  uniqueItems: true,
  items: {
    enum: [
      { a: 1, nested: [1, 2] },
      { nested: [1, 2], a: 1 },
      ...(possible ? [{ a: 2 }] : []),
    ],
  },
});

test("three catalogues retain repeat structural diagnostics before payload access or execution", async () => {
  const p = fixture(),
    before = structuredClone(p);
  for (const fault of [
    "missing",
    "hole",
    "unknown-first",
    "children-getter",
    "type-proxy",
  ]) {
    let hooks = 0,
      executions = 0;
    const first = { id: "first", request: structuredClone(p.requests[0]) };
    const group = {
      id: "group",
      type: "repeat",
      enabled: false,
      count: 1,
      steps: [{ id: "leaf", request: structuredClone(p.requests[0]) }],
    };
    if (fault === "missing") delete group.steps;
    if (fault === "hole") delete group.steps[0];
    if (fault === "unknown-first") first.type = "unknown";
    if (fault === "children-getter")
      Object.defineProperty(group, "steps", {
        enumerable: true,
        get() {
          hooks++;
          throw Error("children read");
        },
      });
    if (fault === "type-proxy")
      group.steps[0] = new Proxy(group.steps[0], {
        getOwnPropertyDescriptor() {
          hooks++;
          throw Error("trap");
        },
      });
    const plan = { id: "p", steps: [first, group] };
    assert.throws(() => snapshotPlan(plan), /循环.*步骤类型/);
    assert.throws(
      () => restoreProject({ ...p, plans: [plan] }),
      /循环.*步骤类型/,
    );
    await assert.rejects(
      runPlan(plan, {}, async () => {
        executions++;
      }),
      /循环.*步骤类型/,
    );
    assert.equal(hooks, 0);
    assert.equal(executions, 0);
    assert.deepEqual(p, before);
  }
});

for (const [format, encode] of [
  ["json", exportApipost],
  ["directory", exportApipostDirectory],
]) {
  test(`${format} three catalogues and unique Schema survive two native generations and typed plan backup`, async () => {
    let p = fixture();
    const expected = catalogueSemantics(p);
    p.requests[0].schema = schema();
    p.requests[1].schema = schema(false);
    for (let generation = 0; generation < 2; generation++) {
      const before = structuredClone(p);
      const next = blankAttributeProject(`unique-${format}-${generation}`);
      importIntoProject(next, JSON.parse(JSON.stringify(encode(p))));
      assert.deepEqual(p, before);
      assert.deepEqual(catalogueSemantics(next), expected);
      assert.deepEqual(
        next.requests.map((r) => r.schema),
        [schema(), schema(false)],
      );
      const validate = new Ajv2020({ strict: false }).compile(
        next.requests[0].schema,
      );
      assert.equal(validate(sampleFromSchema(next.requests[0].schema)), true);
      assert.throws(
        () => sampleFromSchema(next.requests[1].schema),
        /唯一|unique/i,
      );
      p = next;
    }
    const plan = snapshotPlan({
      id: "frozen",
      steps: [
        {
          id: "group",
          type: "repeat",
          count: 2,
          steps: [{ id: "leaf", type: "http", request: p.requests[0] }],
        },
      ],
    });
    const restored = restoreProject(
      JSON.parse(JSON.stringify({ ...p, plans: [plan] })),
    );
    assert.deepEqual(catalogueSemantics(restored), expected);
    let calls = 0;
    const result = await runPlan(restored.plans[0], {}, async (request) => {
      calls++;
      assert.deepEqual(request.attributes, restored.requests[0].attributes);
      const value = sampleFromSchema(request.schema);
      assert.equal(
        new Ajv2020({ strict: false }).compile(schema())(value),
        true,
      );
      return { status: 200, headers: {}, body: JSON.stringify(value) };
    });
    assert.equal(result.status, "passed");
    assert.equal(calls, 2);
  });
}

test("owner three-catalogue backup preserves valid and impossible unique Mock responses after restart", async () => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(join(tmpdir(), "attribute-unique-owner-"));
  let app;
  const close = async () => {
    if (!app) return;
    const current = app;
    app = undefined;
    await new Promise((resolve, reject) =>
      current.server.close((e) => (e ? reject(e) : resolve())),
    );
  };
  try {
    app = await createApp({ root, port: 0 });
    const call = async (route, method = "GET", body, status = 200) => {
      const response = await fetch(app.url + route, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    };
    const created = await call(
      "/api/projects",
      "POST",
      { name: "Three catalogues" },
      201,
    );
    const other = await call(
      "/api/projects",
      "POST",
      { name: "Unrelated" },
      201,
    );
    let p = await call(`/api/projects/${created.id}/import`, "POST", {
      document: combinedDocument("http://127.0.0.1:1/no-outbound"),
    });
    const expected = catalogueSemantics(p);
    for (const [i, request] of p.requests.entries())
      request.responses = [{ status: 200, schema: schema(i === 0) }];
    p = await call(`/api/projects/${p.id}`, "PUT", p);
    const backup = await call(`/api/projects/${p.id}/export`);
    const restored = await call(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    const persisted = await app.store.get(restored.id);
    const otherBefore = await app.store.get(other.id);
    for (let generation = 0; generation < 2; generation++) {
      assert.deepEqual(
        catalogueSemantics(await call(`/api/projects/${restored.id}`)),
        expected,
      );
      const grants = await call("/api/mcp/config");
      for (const [i, request] of restored.requests.entries()) {
        const response = await fetch(
          `${app.url}/mock/${restored.id}/${request.id}`,
        );
        const value = await response.json();
        assert.equal(response.status, i === 0 ? 200 : 400);
        if (i === 0)
          assert.equal(
            new Ajv2020({ strict: false }).compile(schema())(value),
            true,
          );
        else assert.match(value.error, /唯一|unique/i);
      }
      assert.deepEqual(await app.store.get(restored.id), persisted);
      assert.deepEqual(await app.store.get(other.id), otherBefore);
      assert.deepEqual(await call("/api/mcp/config"), grants);
      if (!generation) {
        await close();
        app = await createApp({ root, port: 0 });
      }
    }
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
