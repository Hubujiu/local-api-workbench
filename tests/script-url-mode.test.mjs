import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  normalizeRequest,
  snapshotPlan,
  toCurl,
  exportOpenAPI,
} from "../src/core.mjs";
import { runScript } from "../src/scripts.mjs";
import {
  normalizeScriptURLMode,
  scriptURLModeOptions,
} from "../public/script-url-mode.js";
import {
  requestDocumentationHTML,
  exportDocumentation,
} from "../public/document-export.js";
import {
  initializeQueryRuntime,
  validateQueryRuntime,
} from "../src/script-url-runtime.mjs";

test("URL object mode is explicit and survives request/plan JSON snapshots without changing legacy defaults", async () => {
  assert.equal(normalizeScriptURLMode(), "string");
  assert.throws(() => normalizeScriptURLMode("unknown"));
  assert.match(scriptURLModeOptions("sdk"), /value="sdk" selected/);
  const request = normalizeRequest({
    url: "https://example.test/{id}",
    scriptURLMode: "sdk",
    query: [{ key: "x", value: "+" }],
    path: [{ key: "id", value: "42" }],
  });
  const snapshot = snapshotPlan({ steps: [{ request }] });
  const restored = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(
    normalizeRequest(restored.steps[0].request),
    snapshot.steps[0].request,
  );
  assert.equal(restored.steps[0].id, snapshot.steps[0].id);
  assert.equal(restored.steps[0].request.scriptURLMode, "sdk");
  assert.deepEqual(restored.steps[0].request.query, request.query);
  assert.deepEqual(restored.steps[0].request.path, request.path);
  assert.equal(normalizeRequest({ url: request.url }).scriptURLMode, undefined);
  const legacy = await runScript("apt.setVar('type',typeof pm.request.url)", {
    request: { url: request.url },
  });
  assert.equal(legacy.variables.type, "string");
  const object = await runScript("apt.setVar('type',typeof pm.request.url)", {
    request,
  });
  assert.equal(object.variables.type, "object");
  assert.throws(
    () =>
      normalizeRequest({
        url: request.url,
        scriptURLRuntime: initializeQueryRuntime(request),
      }),
    /仅可用于SDK/,
  );
});

test("SDK Path definitions export placeholders while cURL renders concrete examples", () => {
  const request = {
    url: "https://example.test/{id}",
    scriptURLMode: "sdk",
    path: [{ key: "id", value: "42" }],
  };
  assert.ok(toCurl(request).includes("https://example.test/42"));
  const exported = exportOpenAPI({
    name: "Fixture",
    requests: [
      {
        ...request,
        method: "GET",
        query: [],
        headers: [],
        cookies: [],
        responses: [],
        examples: [],
      },
    ],
  });
  assert.equal(
    exported.paths["/{id}"].get.parameters.find((p) => p.in === "path").example,
    "42",
  );
  assert.match(requestDocumentationHTML(request), /SDK URL对象模式/);
  assert.match(
    exportDocumentation({ name: "Fixture", requests: [request] }),
    /不是执行后的请求/,
  );
});

test("URL facade runtime assets have a closed exact-byte dependency manifest", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../src/vendor/url-sdk-facade-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const bytes = await readFile(
    new URL("../src/vendor/url-sdk-facade.js", import.meta.url),
  );
  assert.equal(bytes.length, manifest.bytes);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    manifest.sha256,
  );
  const expected = [
    "src/script-url-facade.mjs",
    "src/script-url-runtime.mjs",
    "src/script-url-state.mjs",
    "src/vendor/url-sdk-host.js",
  ].sort();
  assert.deepEqual(Object.keys(manifest.sourceHashes).sort(), expected);
  for (const [path, digest] of Object.entries(manifest.sourceHashes))
    assert.equal(
      createHash("sha256")
        .update(await readFile(new URL("../" + path, import.meta.url)))
        .digest("hex"),
      digest,
    );
});

test("URL origin envelopes reject inherited/accessor fields and forged encodings without executing getters", () => {
  const valid = initializeQueryRuntime({ url: "https://example.test/?x=1" });
  let calls = 0;
  const getter = {
    get state() {
      calls++;
      return valid.state;
    },
    origins: valid.origins,
  };
  assert.throws(() => validateQueryRuntime(getter));
  assert.equal(calls, 0);
  assert.throws(() => validateQueryRuntime(Object.create(valid)));
  for (const mutate of [
    (value) => (value.origins[0].encoding = "unknown"),
    (value) => (value.origins[0].dynamic = { source: "fixed", value: "no" }),
    (value) => value.variableOrigins.push({ encoding: "raw" }),
    (value) => (value.url = () => 1),
  ]) {
    const value = structuredClone(valid);
    mutate(value);
    assert.throws(() => validateQueryRuntime(value));
  }
});

test("explicit malformed runtime state never silently resets the SDK URL", () => {
  for (const state of [null, false, 0, "", []]) {
    const request = {
      url: "https://example.test",
      scriptURLMode: "sdk",
      scriptURLRuntime: state,
    };
    assert.throws(() => normalizeRequest(request));
    assert.throws(() => runScript("", { request }));
  }
});

test("SDK initialization preflights raw input and table sizes before constructing collections", () => {
  for (const url of ["x".repeat(65537), "中".repeat(22000), "\ud800", {}])
    assert.throws(() => initializeQueryRuntime({ url }), /SDK URL/);
  assert.throws(
    () =>
      initializeQueryRuntime({
        url: "https://example.test",
        query: Array(1001).fill({ key: "x", value: "y" }),
      }),
    /最多1000/,
  );
  assert.throws(
    () => initializeQueryRuntime({ url: "https://example.test", path: {} }),
    /最多1000/,
  );
});

test("SDK initialization rejects array metadata before lossy conversion without reading it", () => {
  for (const group of ["query", "path"]) {
    let reads = 0;
    const row = { key: "q", value: '["a","b"]' };
    Object.defineProperty(row, "querySerialization", {
      enumerable: true,
      get() {
        reads++;
        throw Error("must not read");
      },
    });
    assert.throws(
      () =>
        initializeQueryRuntime({ url: "https://example.test", [group]: [row] }),
      /尚不支持与SDK URL模式/,
    );
    assert.equal(reads, 0);
  }
});
