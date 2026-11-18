import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import {
  normalizeRequest,
  snapshotPlan,
  importIntoProject,
} from "../src/core.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";

function document(url, auth) {
  const request = normalizeRequest({
    id: "request",
    name: "Frozen",
    url,
    method: "GET",
    inheritSharedScripts: false,
    auth: { type: "basic", username: "old", password: "old-synthetic" },
  });
  const project = {
    id: "source",
    name: "Synthetic",
    settings: {},
    environments: [{ id: "env", name: "Local", variables: {} }],
    requests: [{ ...request, url: url + "/live" }],
    plans: [
      snapshotPlan({
        id: "plan",
        name: "Frozen",
        environmentId: "env",
        statusPolicy: "strict200",
        steps: [
          { id: "first", request },
          {
            id: "second",
            request: {
              ...request,
              auth: { type: "none" },
            },
          },
        ],
      }),
    ],
  };
  const result = exportApipostDirectory(project);
  const file = result.files.find((f) => /executions\/flows\/flow/.test(f.path));
  const flow = JSON.parse(file.text);
  flow.steps[0].input.auth = auth;
  file.text = JSON.stringify(flow);
  return result;
}
const variants = [
  {
    type: "kv",
    kv: { in: "header", key: "x-fixture", value: "synthetic a+b" },
  },
  { type: "kv", kv: { in: "query", key: "fixture", value: "synthetic a+b" } },
  {
    type: "oauth1",
    oauth1: {
      consumerKey: "synthetic",
      consumerSecret: "not-a-secret",
      token: "token",
      tokenSecret: "not-a-secret",
      signatureMethod: "HMAC-SHA1",
      version: "1.0",
      nonce: "stable-fixture",
      timestamp: "1234567890",
      addEmptyParamsToSign: false,
      includeBodyHash: false,
      addParamsToHeader: true,
      disableHeaderEncoding: false,
    },
  },
  {
    type: "digest",
    digest: {
      username: "synthetic",
      password: "not-a-secret",
      realm: "",
      nonce: "",
      qop: "",
      nc: "",
      cnonce: "",
      algorithm: "MD5",
      disableRetryRequest: true,
    },
  },
];

test("native frozen auth overrides survive directory round trips, restore and restart without granting or sending on import", async (t) => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    seen.push({
      url: req.url,
      auth: req.headers.authorization || "",
      key: req.headers["x-fixture"] || "",
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-auth-roundtrip-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const url = "http://127.0.0.1:" + server.address().port + "/frozen";
  const unrelated = await app.store.create("Unrelated");
  const unrelatedBefore = await app.store.get(unrelated.id);
  for (const auth of variants.slice(0, 3)) {
    const source = document(url, auth),
      before = structuredClone(source);
    const p = await app.store.create("Imported");
    const sentBefore = seen.length;
    importIntoProject(p, source);
    assert.deepEqual(source, before);
    assert.equal(seen.length, sentBefore);
    const frozen = structuredClone(p.plans[0].steps[0].request.auth);
    assert.notEqual(frozen.type, "basic");
    assert.equal(p.requests[0].auth.type, "basic");
    await app.store.save(p);
    const output = exportApipostDirectory(p);
    const q = await app.store.create("Round trip");
    importIntoProject(q, output);
    assert.deepEqual(q.plans[0].steps[0].request.auth, frozen);
    await app.store.save(q);
    const restored = await app.store.restore(q);
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    app = await createApp({ root, port: 0 });
    for (const current of [p, q, restored]) {
      const loaded = await app.store.get(current.id);
      assert.deepEqual(loaded.plans[0].steps[0].request.auth, frozen);
      const response = await fetch(
        app.url + "/api/projects/" + current.id + "/run",
        {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ planId: loaded.plans[0].id }),
        },
      );
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.status, "passed", JSON.stringify(result));
    }
    const wire = seen.slice(sentBefore);
    assert.equal(wire.length, 6);
    assert.deepEqual(wire[1], { url: "/frozen", auth: "", key: "" });
    assert.deepEqual(wire[3], wire[1]);
    assert.deepEqual(wire[5], wire[1]);
    assert.deepEqual(wire[2], wire[0]);
    assert.deepEqual(wire[4], wire[0]);
    if (auth.type === "kv" && auth.kv.in === "header")
      assert.deepEqual(wire[0], {
        url: "/frozen",
        auth: "",
        key: auth.kv.value,
      });
    else if (auth.type === "kv") {
      assert.equal(wire[0].url, "/frozen?fixture=synthetic%20a+b");
      assert.equal(wire[0].auth, "");
    } else
      assert.match(
        wire[0].auth,
        auth.type === "oauth1" ? /^OAuth / : /^Digest /,
      );
  }
  assert.deepEqual(await app.store.get(unrelated.id), unrelatedBefore);
});

test("malformed native auth overrides reject atomically instead of falling back to saved credentials", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-auth-invalid-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("Unchanged");
  for (const auth of [
    { type: "kv", kv: { in: "cookie", key: "x", value: "synthetic" } },
    { type: "kv", kv: { in: "header", key: "x\r\ny", value: "synthetic" } },
    {
      type: "kv",
      kv: { in: "query", key: "x", value: "synthetic", unknown: 1 },
    },
    { type: "oauth1", oauth1: { ...variants[2].oauth1, addParamsToHeader: 1 } },
    {
      type: "digest",
      digest: { ...variants[3].digest, disableRetryRequest: "true" },
    },
    { type: "kv", kv: { in: "query", key: "x", value: "x".repeat(65536) } },
    { type: "oauth2", oauth2: { clientSecret: "synthetic" } },
  ]) {
    const before = structuredClone(p);
    assert.throws(() =>
      importIntoProject(p, document("http://127.0.0.1:1/frozen", auth)),
    );
    assert.deepEqual(p, before);
  }
});

test("Digest bootstrap overrides preserve retry policy without importing cached challenges", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-digest-input-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  for (const retry of [true, false]) {
    const p = await app.store.create("Digest bootstrap");
    const auth = structuredClone(variants[3]);
    auth.digest.disableRetryRequest = !retry;
    importIntoProject(p, document("http://127.0.0.1:1/frozen", auth));
    assert.deepEqual(p.plans[0].steps[0].request.auth, {
      type: "digest",
      username: "synthetic",
      password: "not-a-secret",
      challengePolicy: { algorithm: "MD5", retry },
    });
    const q = await app.store.create("Digest round trip");
    importIntoProject(q, exportApipostDirectory(p));
    assert.deepEqual(
      q.plans[0].steps[0].request.auth,
      p.plans[0].steps[0].request.auth,
    );
    const before = structuredClone(q);
    auth.digest.nonce = "cached-nonce";
    assert.throws(() =>
      importIntoProject(q, document("http://127.0.0.1:1/frozen", auth)),
    );
    assert.deepEqual(q, before);
  }
});
