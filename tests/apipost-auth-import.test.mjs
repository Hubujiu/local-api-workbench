import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  importIntoProject,
  restoreProject,
  interpolate,
  toCurl,
  importCurl,
} from "../src/core.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import {
  environmentVariables,
  resolveServiceRequest,
} from "../src/environments.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import { importExtendedApipostAuth } from "../src/apipost-auth-import.mjs";
import { hawkAuthorization } from "../src/hawk-auth.mjs";
import { edgegridAuthorization } from "../src/edgegrid-auth.mjs";
import { awsSignatureHeaders } from "../src/aws-signature.mjs";

const native = [
  {
    type: "kv",
    kv: { in: "header", key: "X-Fixture-Key", value: "{{shared}}" },
  },
  { type: "kv", kv: { in: "query", key: "fixture_key", value: "{{shared}}" } },
  {
    type: "awsv4",
    awsv4: {
      accessKey: "synthetic-access",
      secretKey: "synthetic-secret",
      sessionToken: "synthetic-session",
      region: "us-east-1",
      service: "execute-api",
      addAuthDataToQuery: false,
    },
  },
  {
    type: "hawk",
    hawk: {
      authId: "synthetic-id",
      authKey: "synthetic-key",
      algorithm: "sha256",
      includePayloadHash: true,
      nonce: "fixednonce",
      timestamp: "1700000000",
      extraData: "test-ext",
      app: "test-app",
      delegation: "test-dlg",
      user: "",
    },
  },
  {
    type: "edgegrid",
    edgegrid: {
      clientToken: "synthetic-client",
      clientSecret: "synthetic-secret",
      accessToken: "synthetic-access",
      baseURi: "",
      headersToSign: "X-Test",
      nonce: "fixed-nonce",
      timestamp: "20231025T12:00:00+0000",
    },
  },
];

test("native auth import saves, restores and sends actual header/query signatures with scope and source isolation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-auth-map-"));
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    seen.push({ url: req.url, headers: req.headers, body });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = new Store(root),
    untouched = await store.create("untouched");
  const before = await store.get(untouched.id);
  for (const [index, auth] of native.entries()) {
    const doc = modernApipostFixture();
    doc.global.envs[0].server_list[0].uri = base;
    // Exercise project, folder and request origin without changing precedence.
    [doc.global.global_param, doc.apis[0].request, doc.apis[1].request][
      index % 3
    ].auth = structuredClone(auth);
    const sourceBefore = structuredClone(doc);
    const project = await store.create("auth " + index);
    importIntoProject(project, doc);
    assert.equal(seen.length, index * 2);
    assert.deepEqual(doc, sourceBefore);
    await store.save(project);
    const saved = await store.get(project.id),
      restored = restoreProject(saved);
    assert.deepEqual(restored.requests[0].auth, saved.requests[0].auth);
    for (const p of [saved, restored]) {
      const env = p.environments.find((e) => e.name === "Imported");
      const request = interpolate(
        resolveServiceRequest(p, p.requests[0], env.id),
        environmentVariables(p, env.id),
      );
      assert.equal((await executeRequest(request)).status, 200);
      const wire = seen.at(-1),
        url = base + wire.url;
      if (index === 0) assert.equal(wire.headers["x-fixture-key"], "current");
      if (index === 1)
        assert.equal(new URL(url).searchParams.get("fixture_key"), "current");
      if (index === 2) {
        assert.equal(wire.headers["x-amz-security-token"], "synthetic-session");
        const stamp = wire.headers["x-amz-date"];
        const signingDate = stamp.replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
          "$1-$2-$3T$4:$5:$6Z",
        );
        const expected = await awsSignatureHeaders(
          url,
          "GET",
          { "x-test": "current" },
          undefined,
          {
            type: "aws",
            accessKey: "synthetic-access",
            secretKey: "synthetic-secret",
            sessionToken: "synthetic-session",
            region: "us-east-1",
            service: "execute-api",
            signingDate,
          },
        );
        assert.equal(wire.headers.authorization, expected.authorization);
      }
      if (index === 3)
        assert.equal(
          wire.headers.authorization,
          hawkAuthorization(url, "GET", { "x-test": "current" }, undefined, {
            id: "synthetic-id",
            key: "synthetic-key",
            algorithm: "sha256",
            payloadHash: "enabled",
            nonce: "fixednonce",
            timestamp: "1700000000",
            ext: "test-ext",
            app: "test-app",
            dlg: "test-dlg",
          }).header,
        );
      if (index === 4)
        assert.equal(
          wire.headers.authorization,
          edgegridAuthorization(
            url,
            "GET",
            { "x-test": "current" },
            undefined,
            {
              clientToken: "synthetic-client",
              clientSecret: "synthetic-secret",
              accessToken: "synthetic-access",
              headersToSign: "X-Test",
              nonce: "fixed-nonce",
              timestamp: "20231025T12:00:00+0000",
            },
          ),
        );
      assert.ok(
        !String(wire.headers.authorization).includes("synthetic-secret"),
      );
    }
  }
  assert.deepEqual(await store.get(untouched.id), before);
});

test("extended native auth refuses lossy or malformed conversion before changing destination", () => {
  for (const auth of [
    { type: "awsv4", awsv4: { ...native[2].awsv4, addAuthDataToQuery: true } },
    { type: "awsv4", awsv4: { ...native[2].awsv4, secretKey: {} } },
    { type: "hawk", hawk: { ...native[3].hawk, user: "unsupported-user" } },
    { type: "hawk", hawk: { ...native[3].hawk, includePayloadHash: "false" } },
    { type: "hawk", hawk: { ...native[3].hawk, algorithm: "md5" } },
    {
      type: "edgegrid",
      edgegrid: { ...native[4].edgegrid, unrecognized: true },
    },
    {
      type: "edgegrid",
      edgegrid: { ...native[4].edgegrid, clientSecret: "x".repeat(65536) },
    },
    { type: "kv", kv: { in: "cookie", key: "a", value: "b" } },
    { type: "kv", kv: { in: "header", key: "bad\nname", value: "b" } },
  ]) {
    const doc = modernApipostFixture();
    doc.apis[1].request.auth = auth;
    const project = {
      requests: [],
      folders: [],
      environments: [],
      settings: {},
    };
    const before = structuredClone(project);
    assert.throws(() => importIntoProject(project, doc));
    assert.deepEqual(project, before);
  }
  assert.equal(importExtendedApipostAuth({ type: "oauth2" }), undefined);
  assert.equal(
    importExtendedApipostAuth({
      type: "hawk",
      hawk: { ...native[3].hawk, includePayloadHash: false },
    }).payloadHash,
    "disabled",
  );
});

test("native Query API-key preserves the observed original plus/space wire spelling", async (t) => {
  let seen;
  const server = http.createServer((req, res) => {
    seen = req.url;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const auth = importExtendedApipostAuth({
    type: "kv",
    kv: { in: "query", key: "fixture_key", value: "synthetic+kv value" },
  });
  await executeRequest({
    url: `http://127.0.0.1:${server.address().port}/echo?fixture=original`,
    auth,
  });
  assert.equal(seen, "/echo?fixture=original&fixture_key=synthetic+kv%20value");
});

test("native Query replacement and cURL roundtrip preserve raw fields while generic encoding is unchanged", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}/echo?keep=a%20b&fixture=old&fixture=second&flag`;
  const auth = importExtendedApipostAuth({
    type: "kv",
    kv: { in: "query", key: "fixture", value: "synthetic+kv value" },
  });
  const request = { url, auth };
  await executeRequest(request);
  await executeRequest(importCurl(toCurl(request)));
  assert.deepEqual(
    seen,
    Array(2).fill("/echo?keep=a%20b&fixture=synthetic+kv%20value&flag"),
  );
  const generic = structuredClone(auth);
  delete generic.queryEncoding;
  await executeRequest({ url, auth: generic });
  assert.equal(seen[2], "/echo?keep=a%20b&fixture=synthetic%2Bkv+value&flag");
  for (const patch of [
    { value: "bad&injected=true" },
    { value: "bad#fragment" },
    { value: "bad\r\nvalue" },
    { key: "bad=name" },
    { key: "bad+name" },
    { queryEncoding: "unknown" },
    { in: "header" },
  ]) {
    await assert.rejects(executeRequest({ url, auth: { ...auth, ...patch } }));
    assert.throws(() => toCurl({ url, auth: { ...auth, ...patch } }));
  }
  assert.equal(seen.length, 3);
});
