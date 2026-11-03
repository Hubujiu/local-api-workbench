import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { sampleFromSchema } from "../src/schema-sample.mjs";

const schemaFor = (values) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "array",
  minItems: 2,
  maxItems: 2,
  uniqueItems: true,
  items: { enum: values },
});
const alternatives = () => [{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 3 }];

test("unique array samples use JSON object equality rather than key insertion order", () => {
  const schema = schemaFor(alternatives());
  const ajv = new Ajv2020({ strict: false });
  assert.equal(ajv.validateSchema(schema), true);
  const validate = ajv.compile(schema);
  const result = sampleFromSchema(schema);
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.deepEqual(result, [{ a: 1, b: 2 }, { a: 3 }]);
});

test("a structurally duplicate enum cannot satisfy unique array cardinality", () => {
  const schema = schemaFor(alternatives().slice(0, 2));
  assert.equal(new Ajv2020({ strict: false }).validateSchema(schema), true);
  assert.throws(() => sampleFromSchema(schema), /唯一|unique/i);
});

test("ordinary distinct scalar and ordered-array enum choices remain valid", () => {
  for (const values of [
    [0, 1],
    [false, true],
    [null, "null"],
    [
      [1, 2],
      [2, 1],
    ],
  ]) {
    const schema = schemaFor(values);
    const value = sampleFromSchema(schema);
    assert.deepEqual(value, values);
    assert.equal(new Ajv2020({ strict: false }).compile(schema)(value), true);
  }
});

test("owner-saved unique Schema Mock remains valid or explicitly fails across restart without state changes", async () => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "mock-unique-http-"));
  let app;
  const close = async () => {
    if (app) {
      const closing = app;
      app = undefined;
      await new Promise((resolve, reject) =>
        closing.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  };
  const schema = schemaFor(alternatives());
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const observations = [];
  try {
    app = await createApp({ root, port: 0 });
    const project = await app.store.create("Unique Mock contract");
    project.requests = [
      {
        id: "possible",
        name: "Possible",
        method: "GET",
        url: "http://127.0.0.1/never-executed",
        responses: [{ status: 200, schema }],
      },
      {
        id: "impossible",
        name: "Impossible",
        method: "GET",
        url: "http://127.0.0.1/never-executed",
        responses: [
          { status: 200, schema: schemaFor(alternatives().slice(0, 2)) },
        ],
      },
      {
        id: "healthy",
        name: "Healthy",
        method: "GET",
        url: "http://127.0.0.1/never-executed",
        examples: [{ status: 200, body: "healthy" }],
      },
    ];
    const saved = await fetch(app.url + "/api/projects/" + project.id, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(project),
    });
    assert.equal(saved.status, 200, await saved.text());
    const persisted = await app.store.get(project.id);
    for (let generation = 0; generation < 2; generation++) {
      for (const id of ["possible", "impossible", "healthy"]) {
        const response = await fetch(
          app.url + "/mock/" + project.id + "/" + id,
        );
        observations.push({
          generation,
          id,
          status: response.status,
          body: await response.text(),
        });
      }
      assert.deepEqual(await app.store.get(project.id), persisted);
      if (!generation) {
        await close();
        app = await createApp({ root, port: 0 });
      }
    }
    for (const observation of observations) {
      if (observation.id === "possible") {
        assert.equal(observation.status, 200);
        assert.equal(
          validate(JSON.parse(observation.body)),
          true,
          JSON.stringify({ observation, errors: validate.errors }),
        );
      } else if (observation.id === "impossible") {
        assert.equal(observation.status, 400, JSON.stringify(observation));
        assert.match(JSON.parse(observation.body).error, /唯一|unique/i);
      } else {
        assert.equal(observation.status, 200);
        assert.equal(observation.body, "healthy");
      }
    }
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
