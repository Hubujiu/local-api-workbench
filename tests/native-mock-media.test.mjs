import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../src/server.mjs";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { normalizeNativeMock } from "../src/native-mock.mjs";
import { nativeMockResponse } from "../src/native-mock-runtime.mjs";
import { nativeMockFixture } from "./fixtures/apipost-native-mock.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";

const xml = '<root label="中&amp;文">{{unresolved}} &lt;script&gt; 😺</root>\n';
function sourceFor(schema, { body = "ignored", contentType = "json" } = {}) {
  const { doc, config } = nativeMockFixture();
  const [fallback, matched] = doc.apis[1].response.example;
  fallback.expect.schema = {};
  fallback.expect.content_type = "xml";
  fallback.raw = xml;
  matched.expect.schema = schema;
  matched.expect.content_type = contentType;
  matched.raw = body;
  const directory = nativeDirectoryFixture(doc);
  directory.files.push({
    path: "settings/mock_api.json",
    text: JSON.stringify(config),
  });
  return directory;
}
const blankProject = () => ({ requests: [], environments: [], settings: {} });
const imported = (source) => {
  const p = blankProject();
  importIntoProject(p, source);
  return p.requests[0].nativeMock;
};

test("native scalar/array/raw XML responses survive real HTTP, matching, restore, restart and concurrent project isolation", async (t) => {
  let outbound = 0;
  const sink = http.createServer((req, res) => {
    outbound++;
    res.end("unexpected API execution");
  });
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mock-media-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    sink.closeAllConnections();
    await new Promise((resolve) => sink.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const cases = [
    [{ type: "boolean" }, "false", "scalar-text", "text/plain"],
    [
      { type: "integer", minimum: 0, maximum: 0 },
      "0",
      "scalar-text",
      "text/plain",
    ],
    [{ type: "number", const: 1.5 }, "1.5", "scalar-text", "text/plain"],
    [{ type: "string", maxLength: 0 }, "", "scalar-text", "text/plain"],
    [
      { type: "string", const: '中"\\\n😺' },
      '中"\\\n😺',
      "scalar-text",
      "text/plain",
    ],
    [{ type: "null" }, "", "scalar-text", "text/plain"],
    [
      { type: "array", maxItems: 0, items: { type: "string" } },
      "[]",
      undefined,
      "application/json;charset=utf-8",
    ],
    [
      { type: "array", const: [[0, false], ["中", null], []] },
      '[[0,false],["中",null],[]]',
      undefined,
      "application/json;charset=utf-8",
    ],
    [
      {},
      xml,
      "raw-xml",
      "application/xml;charset=utf-8",
      { body: xml, contentType: "xml" },
    ],
  ];
  const checks = [];
  const check = async (p, suffix, body, mime, rule) => {
    const response = await fetch(
      app.url + "/mock/" + p.id + "/" + p.requests[0].id + suffix,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), mime);
    assert.equal(response.headers.get("x-native-rule"), rule);
    assert.match(response.headers.get("content-security-policy"), /sandbox/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), body);
  };
  for (const [schema, body, serialization, mime, options] of cases) {
    const source = sourceFor(schema, options),
      before = structuredClone(source);
    const p = await app.store.create("Mock media " + schema.type);
    importIntoProject(p, source);
    p.requests[0].url = `http://127.0.0.1:${sink.address().port}/must-not-run`;
    p.requests[0].beforeScript =
      'throw Error("Mock must not execute API before script")';
    p.requests[0].afterScript =
      'throw Error("Mock must not execute API after script")';
    await app.store.save(p);
    assert.deepEqual(source, before);
    const saved = await app.store.get(p.id);
    const response = saved.requests[0].nativeMock.rules[0].response;
    assert.equal(response.serialization, serialization);
    if (serialization === undefined)
      assert(!Object.hasOwn(response, "serialization"));
    assert.equal(response.sourceStatus, 404);
    assert.equal(
      saved.requests[0].nativeMock.fallback.serialization,
      "raw-xml",
    );
    const restored = restoreProject(JSON.stringify(saved));
    assert.deepEqual(
      restored.requests[0].nativeMock,
      saved.requests[0].nativeMock,
    );
    restored.requests[0].nativeMock.fallback.body += "<!-- restored -->";
    // Direct canonical edits may use mixed header casing; do not add a second
    // default Content-Type, and do not change the explicitly selected MIME.
    restored.requests[0].nativeMock.rules[0].response.headers["CoNtEnT-TyPe"] =
      "application/x-explicit-fixture";
    await app.store.save(restored);
    checks.push(
      () => check(saved, "?mode=fail", body, mime, "matched"),
      () =>
        check(
          saved,
          "?mode=other",
          xml,
          "application/xml;charset=utf-8",
          "fallback",
        ),
      () =>
        check(
          restored,
          "?mode=fail",
          body,
          "application/x-explicit-fixture",
          "matched",
        ),
      () =>
        check(
          restored,
          "",
          xml + "<!-- restored -->",
          "application/xml;charset=utf-8",
          "fallback",
        ),
    );
  }
  await Promise.all(checks.map((check) => check()));
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  app = await createApp({ root, port: 0 });
  await Promise.all(checks.map((check) => check()));
  const broken = await app.store.create("Generation failure isolation");
  importIntoProject(broken, sourceFor({ type: "string", const: "healthy" }));
  const healthy = structuredClone(broken.requests[0].nativeMock);
  // A generator-derived wrong type must not become "[object Object]" or JSON
  // under the scalar policy. Fail this request without falling back or poisoning
  // another project's response, and recover after an explicit correction.
  broken.requests[0].nativeMock.rules[0].response.schema = {
    type: "string",
    properties: { bad: { const: 1 } },
  };
  await app.store.save(broken);
  const failure = await fetch(
    app.url + "/mock/" + broken.id + "/" + broken.requests[0].id + "?mode=fail",
  );
  assert.equal(failure.status, 400);
  assert.match((await failure.json()).error, /根类型/);
  await checks[0]();
  broken.requests[0].nativeMock = healthy;
  await app.store.save(broken);
  await check(broken, "?mode=fail", "healthy", "text/plain", "matched");
  assert.equal(outbound, 0);
});

test("unsupported native response roots and XML generation reject imports atomically", () => {
  for (const [schema, options] of [
    [{ type: ["string", "null"] }],
    [{ $ref: "#/components/schemas/Missing" }],
    [{ type: "string", const: {} }],
    [{ type: "boolean", example: 0 }],
    [{ type: "integer", default: 1.5 }],
    [{ type: "number", enum: ["0"] }],
    [{ type: "null", const: false }],
    [{ type: "unknown" }],
    [{ type: "object" }, { body: xml, contentType: "xml" }],
    [{}, { body: xml, contentType: "html" }],
  ]) {
    const source = sourceFor(schema, options),
      before = structuredClone(source);
    const p = blankProject(),
      initial = structuredClone(p);
    assert.throws(() => importIntoProject(p, source));
    assert.deepEqual(p, initial);
    assert.deepEqual(source, before);
  }
});

test("persisted media policy cannot bypass response, header or scalar type guards", async () => {
  const mock = imported(sourceFor({ type: "string", const: "ok" }));
  for (const change of [
    (r) => {
      r.serialization = "execute";
    },
    (r) => {
      r.serialization = "raw-xml";
    },
    (r) => {
      delete r.serialization;
    },
    (r) => {
      r.body = "ambiguous";
    },
    (r) => {
      r.schema.type = ["string", "null"];
    },
    (r) => {
      r.schema.const = [];
    },
    (r) => {
      r.schema = { type: "number", const: Infinity };
    },
    (r) => {
      r.schema.const = "\ud800";
    },
    (r) => {
      r.headers = {
        "Content-Type": "text/plain",
        "content-type": "text/plain",
      };
    },
    (r) => {
      r.headers = { "SET-COOKIE": "not-allowed" };
    },
    (r) => {
      r.headers = { "Content-Length": "1" };
    },
    (r) => {
      r.headers = { "X-Injected": "a\r\nb" };
    },
    (r) => {
      r.delayMs = 5001;
    },
  ]) {
    const next = structuredClone(mock);
    change(next.rules[0].response);
    assert.throws(() => normalizeNativeMock(next));
  }
  const oversized = structuredClone(mock);
  oversized.fallback.body = "x".repeat(1048576);
  assert.throws(() => normalizeNativeMock(oversized), /1MiB/);
  const generated = structuredClone(mock);
  generated.rules[0].response.schema = {
    type: "string",
    properties: { bad: { const: 1 } },
  };
  await assert.rejects(
    nativeMockResponse(
      { settings: {} },
      { nativeMock: generated },
      { query: { mode: "fail" } },
    ),
    /根类型/,
  );
  assert.equal(
    (
      await nativeMockResponse(
        { settings: {} },
        { nativeMock: mock },
        { query: { mode: "fail" } },
      )
    ).body,
    "ok",
  );
});
