// Root-only conversion/owner intersections. Independent wire oracle, no vendor
// runtime or provider. Definition exports must not obtain tokens or send traffic.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import {
  importDocument,
  normalizeRequest,
  exportOpenAPI,
} from "../src/core.mjs";
import { verifyOAuth1Policy } from "./fixtures/oauth1-policy-oracle.mjs";

const identity = {
  consumerKey: "fixture-consumer",
  consumerSecret: "FICTIONAL_CONSUMER_SECRET",
  accessToken: "literal-token",
  tokenSecret: "FICTIONAL_TOKEN_SECRET",
  signatureMethod: "HMAC-SHA1",
  privateKey: "",
  privateKeyPassphrase: "",
  nonce: "nonce",
  timestamp: "1700000000",
  realm: "",
  version: "1.0",
  callback: "",
  verifier: "",
};
const canonical = (header = false) => ({
  type: "oauth1",
  ...identity,
  parameterPolicy: {
    placement: header ? "header" : "auto",
    includeBodyHash: false,
    includeEmptyParams: false,
    headerEncoding: "percent",
  },
});
const sourceAuth = (header = false) => ({
  type: "oauth1",
  oauth1: Object.entries({
    ...Object.fromEntries(
      Object.entries(identity).map(([key, value]) => [
        key === "accessToken" ? "token" : key,
        value,
      ]),
    ),
    ...(header ? { addParamsToHeader: true } : {}),
  }).map(([key, value]) => ({ key, value, type: typeof value })),
});
const document = (origin) => ({
  info: {
    name: "Postman OAuth1 native export",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  auth: sourceAuth(),
  item: [
    {
      name: "query",
      request: {
        method: "GET",
        url: origin + "/query?ordinary=one&ordinary=two",
      },
    },
    {
      name: "header",
      request: {
        method: "GET",
        url: origin + "/header",
        auth: sourceAuth(true),
      },
    },
    {
      name: "none",
      request: {
        method: "GET",
        url: origin + "/none",
        auth: { type: "noauth" },
      },
    },
  ],
});
async function bytes(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await bytes(file)
      : (await readFile(file)).toString("base64");
  }
  return result;
}
async function fixture(t) {
  const root = await mkdtemp(
    path.join(tmpdir(), "postman-oauth1-native-root-"),
  );
  let app, peer;
  const seen = [],
    errors = [];
  const close = async () => {
    if (!app) return;
    const current = app;
    app = undefined;
    const ended = new Promise((resolve, reject) =>
      current.server.close((error) => (error ? reject(error) : resolve())),
    );
    current.server.closeAllConnections();
    await ended;
  };
  t.after(async () => {
    await close();
    if (peer) {
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  app = await createApp({ root, port: 0 });
  peer = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks),
        url = new URL(req.url, `http://127.0.0.1:${peer.address().port}`);
      assert.equal(req.method, "GET");
      if (url.pathname === "/none") {
        assert.equal(req.headers.authorization, undefined);
        assert.equal(
          [...url.searchParams.keys()].some((key) => key.startsWith("oauth_")),
          false,
        );
        assert.equal(body.length, 0);
      } else {
        assert(["/query", "/header"].includes(url.pathname));
        const verified = verifyOAuth1Policy({
          url: url.href,
          method: req.method,
          headers: req.headers,
          body,
          auth: canonical(url.pathname === "/header"),
          bodyType: "none",
        });
        assert.equal(
          verified.placement,
          url.pathname === "/header" ? "header" : "query",
        );
        assert.deepEqual(
          verified.ordinaryQuery,
          url.pathname === "/query"
            ? [
                ["ordinary", "one"],
                ["ordinary", "two"],
              ]
            : [],
        );
      }
      seen.push(url.pathname);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"verified":true}');
    } catch (error) {
      errors.push(error.message);
      res.writeHead(401);
      res.end("verification failed");
    }
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  return {
    root,
    seen,
    errors,
    get app() {
      return app;
    },
    origin: `http://127.0.0.1:${peer.address().port}`,
    async call(route, body, method = "POST", expected = 200) {
      const response = await fetch(app.url + "/api/" + route, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
      const value = await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      return value;
    },
    async restart() {
      await close();
      app = await createApp({ root, port: 0 });
    },
  };
}
const auths = (project) =>
  Object.fromEntries(project.requests.map((r) => [r.name, r.auth]));

for (const format of ["apipost", "apipost-directory"])
  test(
    `Postman import through ${format} preserves token policy/noauth, real signed wire and reopened frozen results`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      const source = await f.app.store.create("Postman source"),
        other = await f.app.store.create("Untouched");
      const original = document(f.origin),
        beforeDocument = structuredClone(original);
      const imported = await f.call(`projects/${source.id}/import`, {
        document: original,
      });
      assert.deepEqual(original, beforeDocument);
      assert.deepEqual(auths(imported), {
        query: canonical(),
        header: canonical(true),
        none: { type: "none" },
      });
      assert.equal(
        imported.requests.find((r) => r.name === "none").inheritAuth,
        false,
      );
      const sourceBefore = await f.app.store.get(source.id),
        sourceBytes = await bytes(f.app.store.directory(source.id));
      const otherBefore = await f.app.store.get(other.id),
        otherBytes = await bytes(f.app.store.directory(other.id));
      const exported = await f.call(
        `projects/${source.id}/export?format=${format}`,
        undefined,
        "GET",
      );
      assert.equal(f.seen.length, 0);
      assert.deepEqual(await f.app.store.get(source.id), sourceBefore);
      assert.deepEqual(
        await bytes(f.app.store.directory(source.id)),
        sourceBytes,
      );
      const target = await f.app.store.create("Native roundtrip");
      const roundtrip = await f.call(`projects/${target.id}/import`, {
        document: exported,
      });
      assert.deepEqual(auths(roundtrip), auths(imported));
      assert.equal(
        roundtrip.requests.find((r) => r.name === "none").inheritAuth,
        false,
      );
      // Shared credentials are introduced only after native export: the native
      // exporter still refuses unsupported Workbench shared-auth settings.
      const ready = await f.app.store.get(target.id);
      ready.settings.globalAuth = {
        type: "bearer",
        token: "MUST_NOT_LEAK_GLOBAL",
      };
      await f.app.store.save(ready);
      const plan = await f.call(`projects/${target.id}/plans`, {
        name: "Frozen native import",
        steps: ready.requests.map((request) => ({ request })),
      });
      const frozen = structuredClone(plan);
      const receiptKeys = [
        "projectRevision",
        "projectConfigRevision",
        "projectFingerprint",
      ];
      for (const key of receiptKeys) {
        assert.equal(Object.hasOwn(plan, key), true);
        delete frozen[key];
      }
      const storedPlan = (await f.app.store.get(target.id)).plans.find(
        (row) => row.id === plan.id,
      );
      assert.deepEqual(storedPlan, frozen);
      for (const key of receiptKeys)
        assert.equal(Object.hasOwn(storedPlan, key), false);
      const live = await f.app.store.get(target.id);
      for (const request of live.requests)
        if (request.auth.type === "oauth1")
          request.auth.accessToken = "edited-live-token";
      live.settings.globalAuth.token = "CHANGED_GLOBAL";
      await f.app.store.save(live);
      const run = await f.call(`projects/${target.id}/run`, {
        planId: plan.id,
      });
      assert.equal(run.status, "passed");
      assert.equal(run.recordSaved, true);
      assert.deepEqual(run.snapshot, frozen);
      assert.deepEqual(f.errors, []);
      assert.deepEqual([...f.seen].sort(), ["/header", "/none", "/query"]);
      assert.equal(run.results.length, 3);
      for (const row of run.results) {
        assert.equal(row.status, "passed");
        assert.equal(JSON.parse(row.response.body).verified, true);
      }
      const saved = await f.app.store.get(target.id);
      assert.deepEqual(
        saved.runs.find((row) => row.id === run.id).results,
        run.results,
      );
      const backup = await f.call(
        `projects/${target.id}/export`,
        undefined,
        "GET",
      );
      const restored = await f.call(
        "restore",
        { document: backup },
        "POST",
        201,
      );
      assert.notEqual(restored.id, target.id);
      await f.restart();
      assert.deepEqual((await new Store(f.root).get(restored.id)).plans, [
        frozen,
      ]);
      assert.deepEqual(
        (await new Store(f.root).get(restored.id)).runs.find(
          (row) => row.id === run.id,
        ).results,
        run.results,
      );
      assert.equal(
        f.seen.length,
        3,
        "restore/restart must not replay signed requests",
      );
      assert.deepEqual(await f.app.store.get(source.id), sourceBefore);
      assert.deepEqual(await f.app.store.get(other.id), otherBefore);
      assert.deepEqual(
        await bytes(f.app.store.directory(other.id)),
        otherBytes,
      );
    },
  );

test(
  "Postman passphrase compatibility remains a native export refusal, with unchanged private backup and no network",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      source = await f.app.store.create("Nonrepresentable passphrase");
    const doc = document(f.origin);
    doc.item = doc.item.slice(0, 1);
    const secret = "PRIVATE_PASSPHRASE_MUST_NOT_APPEAR_IN_ERRORS";
    doc.auth.oauth1.find((row) => row.key === "privateKeyPassphrase").value =
      secret;
    await f.call(`projects/${source.id}/import`, { document: doc });
    const before = await f.app.store.get(source.id),
      disk = await bytes(f.app.store.directory(source.id));
    for (const format of ["apipost", "apipost-directory"]) {
      const result = await f.call(
        `projects/${source.id}/export?format=${format}`,
        undefined,
        "GET",
        400,
      );
      assert.match(result.error, /privateKeyPassphrase.*无法安全规范映射/);
      assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(Object.hasOwn(result, "apis"), false);
      assert.deepEqual(await f.app.store.get(source.id), before);
      assert.deepEqual(await bytes(f.app.store.directory(source.id)), disk);
    }
    const backup = await f.call(
      `projects/${source.id}/export`,
      undefined,
      "GET",
    );
    assert.equal(
      JSON.stringify(backup).includes(secret),
      true,
      "private project backup retains the explicit credential",
    );
    assert.deepEqual(f.seen, []);
  },
);

for (const scope of ["global", "folder"])
  test(`OpenAPI original security cannot bypass effective imported OAuth1 ${scope} policy`, () => {
    const [signed] = importDocument({
      ...document("http://127.0.0.1:1"),
      item: document("http://127.0.0.1:1").item.slice(0, 1),
    });
    const settings =
      scope === "global"
        ? { globalAuth: signed.auth }
        : { folderAuth: { Folder: signed.auth } };
    const request = normalizeRequest({
      url: "http://127.0.0.1:1/never",
      folder: "Folder",
      method: "GET",
      auth: { type: "none" },
      openapiOperation: { security: [] },
    });
    const project = { name: "mixed definition", settings, requests: [request] },
      before = structuredClone(project);
    assert.throws(() => exportOpenAPI(project), /OAuth1签名参数策略/);
    for (const override of [{ inheritAuth: false }, { authSnapshot: true }]) {
      const output = exportOpenAPI({
        ...project,
        requests: [{ ...request, ...override }],
      });
      assert.deepEqual(output.paths["/never"].get.security, []);
    }
    const bearer = exportOpenAPI({
      ...project,
      requests: [{ ...request, auth: { type: "bearer", token: "explicit" } }],
    });
    assert.equal(
      Object.values(bearer.components.securitySchemes).some(
        (scheme) => scheme.scheme === "bearer",
      ),
      true,
    );
    assert.equal(
      JSON.stringify(bearer).includes("FICTIONAL_CONSUMER_SECRET"),
      false,
    );
    assert.deepEqual(project, before);
  });
