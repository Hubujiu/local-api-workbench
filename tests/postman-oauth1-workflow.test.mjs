// Workbench collection interchange/runtime acceptance, not a Postman runtime oracle.
// Peer verifier uses Node crypto and does not import production signing helpers.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { createApp } from "../src/server.mjs";
import { importDocument, exportOpenAPI, toCurl } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";
import { verifyOAuth1Policy } from "./fixtures/oauth1-policy-oracle.mjs";

const schema =
  "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
const sourceAuth = (token, flags = {}) => ({
  type: "oauth1",
  oauth1: Object.entries({
    consumerKey: "fixture-key",
    consumerSecret: "fictional-consumer-secret",
    token,
    tokenSecret: "fictional-token-secret",
    signatureMethod: "HMAC-SHA1",
    nonce: "fixture-nonce",
    timestamp: "1700000000",
    version: "1.0",
    ...flags,
  }).map(([key, value]) => ({ key, value, type: typeof value })),
});
// Explicit expected canonical semantics, deliberately not derived from imported auth.
const expectedAuth = (accessToken, policy = {}, extra = {}) => ({
  type: "oauth1",
  consumerKey: "fixture-key",
  consumerSecret: "fictional-consumer-secret",
  accessToken,
  tokenSecret: "fictional-token-secret",
  signatureMethod: "HMAC-SHA1",
  nonce: "fixture-nonce",
  timestamp: "1700000000",
  version: "1.0",
  parameterPolicy: {
    placement: "auto",
    includeBodyHash: false,
    includeEmptyParams: false,
    headerEncoding: "percent",
    ...policy,
  },
  ...extra,
});
const postscript = {
  listen: "test",
  script: {
    type: "text/javascript",
    exec: [
      'pm.test("independent signature accepted", () => pm.expect(pm.response.code).to.equal(200));',
      'pm.test("peer verified exact bytes", () => pm.expect(pm.response.json().verified).to.equal(true));',
    ],
  },
};
function collection(url) {
  const item = (name, method, auth, body) => ({
    name,
    request: {
      method,
      url: `${url}/${name}?dup=one&dup=two&text=a%2Bb`,
      ...(auth ? { auth } : {}),
      ...(body ? { body } : {}),
    },
  });
  const raw = {
    mode: "raw",
    raw: '{"text":"雪+a","number":1}',
    options: { raw: { language: "json" } },
  };
  const falseFlags = {
    addParamsToHeader: false,
    includeBodyHash: false,
    addEmptyParamsToSign: false,
    disableHeaderEncoding: false,
  };
  return {
    info: { name: "Imported OAuth1 policy workflow", schema },
    auth: sourceAuth("collection-token"),
    event: [postscript],
    item: [
      item("collection-get", "GET"),
      {
        name: "Folder credentials",
        auth: sourceAuth("folder-token", falseFlags),
        item: [
          item("folder-form", "POST", undefined, {
            mode: "urlencoded",
            urlencoded: [
              { key: "x", value: "first" },
              { key: "x", value: "雪+second" },
              { key: "empty", value: "" },
            ],
          }),
          item(
            "request-json-auto",
            "POST",
            sourceAuth("request-auto-token", {
              ...falseFlags,
              includeBodyHash: true,
            }),
            raw,
          ),
          item(
            "request-json-header",
            "POST",
            sourceAuth("request/header+token", {
              ...falseFlags,
              addParamsToHeader: true,
              includeBodyHash: true,
            }),
            raw,
          ),
        ],
      },
      item(
        "empty-query",
        "GET",
        sourceAuth("", {
          addParamsToHeader: false,
          includeBodyHash: false,
          addEmptyParamsToSign: true,
          disableHeaderEncoding: true,
          version: "",
        }),
      ),
      item(
        "raw-header-token",
        "GET",
        sourceAuth("literal/token+percent%", {
          addParamsToHeader: true,
          includeBodyHash: false,
          addEmptyParamsToSign: false,
          disableHeaderEncoding: true,
        }),
      ),
    ],
  };
}
const specs = new Map([
  [
    "/collection-get",
    { method: "GET", bodyType: "none", auth: expectedAuth("collection-token") },
  ],
  [
    "/folder-form",
    {
      method: "POST",
      bodyType: "urlencoded",
      auth: expectedAuth("folder-token"),
    },
  ],
  [
    "/request-json-auto",
    {
      method: "POST",
      bodyType: "json",
      auth: expectedAuth("request-auto-token", { includeBodyHash: true }),
    },
  ],
  [
    "/request-json-header",
    {
      method: "POST",
      bodyType: "json",
      auth: expectedAuth("request/header+token", {
        placement: "header",
        includeBodyHash: true,
      }),
    },
  ],
  [
    "/empty-query",
    {
      method: "GET",
      bodyType: "none",
      auth: expectedAuth(
        "",
        {
          placement: "auto",
          includeEmptyParams: true,
          headerEncoding: "raw",
        },
        { version: "" },
      ),
    },
  ],
  [
    "/raw-header-token",
    {
      method: "GET",
      bodyType: "none",
      auth: expectedAuth("literal/token+percent%", {
        placement: "header",
        headerEncoding: "raw",
      }),
    },
  ],
]);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "postman-oauth1-workflow-"));
  let app = await createApp({ root, port: 0 });
  const seen = [],
    errors = [];
  const peer = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks),
        url = new URL(req.url, `http://127.0.0.1:${peer.address().port}`);
      const spec = specs.get(url.pathname);
      assert.ok(spec, "only fixture paths may receive credentials");
      assert.equal(req.method, spec.method);
      const checked = verifyOAuth1Policy({
        url: url.href,
        method: req.method,
        headers: req.headers,
        body,
        auth: spec.auth,
        bodyType: spec.bodyType,
      });
      assert.deepEqual(checked.ordinaryQuery, [
        ["dup", "one"],
        ["dup", "two"],
        ["text", "a+b"],
      ]);
      if (spec.bodyType === "urlencoded")
        assert.deepEqual(checked.ordinaryForm, [
          ["x", "first"],
          ["x", "雪+second"],
          ["empty", ""],
        ]);
      else
        assert.equal(
          body.toString(),
          spec.bodyType === "json" ? '{"text":"雪+a","number":1}' : "",
        );
      seen.push({ path: url.pathname, placement: checked.placement });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"verified":true}');
    } catch (error) {
      errors.push(error.message);
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"verified":false}');
    }
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await stop();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    seen,
    errors,
    url: `http://127.0.0.1:${peer.address().port}`,
    async call(route, body, method = "POST", status = 200) {
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
      assert.equal(response.status, status, JSON.stringify(value));
      return value;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
  };
}
function checkRun(run, f) {
  assert.equal(run.status, "passed", JSON.stringify({ run, errors: f.errors }));
  assert.equal(run.recordSaved, true, JSON.stringify(run.persistenceError));
  assert.equal(run.recordId, run.id);
  assert.equal(run.results.length, specs.size);
  for (const row of run.results) {
    assert.equal(row.status, "passed");
    assert.equal(row.response.status, 200);
    const tests = row.assertions.filter((entry) => entry.phase === "after");
    assert.equal(tests.length, 2);
    assert.ok(
      tests.every((entry) => entry.passed),
      JSON.stringify(tests),
    );
  }
  assert.deepEqual(f.errors, []);
}

test(
  "Postman OAuth1 collection/folder/request policies survive owner import freeze execution backup and restart with independent signatures",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      document = collection(f.url),
      original = structuredClone(document);
    const imported = importDocument(document);
    assert.deepEqual(document, original);
    assert.equal(imported.length, specs.size);
    for (const request of imported) {
      const expected = specs.get(new URL(request.url).pathname).auth;
      assert.equal(request.auth.accessToken, expected.accessToken);
      assert.deepEqual(request.auth.parameterPolicy, expected.parameterPolicy);
      assert.equal(Object.hasOwn(request.auth, "token"), false);
    }
    const project = await f.call(
      "projects",
      { name: "OAuth1 source import" },
      "POST",
      201,
    );
    const other = await f.call("projects", { name: "unrelated" }, "POST", 201);
    const otherBefore = await f.call(`projects/${other.id}`, undefined, "GET");
    await f.call(`projects/${project.id}/import`, { document });
    const saved = await f.call(`projects/${project.id}`, undefined, "GET");
    assert.equal(saved.requests.length, specs.size);
    const exportError = await f.call(
      `projects/${project.id}/export?format=openapi`,
      undefined,
      "GET",
      400,
    );
    assert.match(JSON.stringify(exportError), /OAuth1/);
    assert.equal(
      JSON.stringify(exportError).includes("fictional-consumer-secret"),
      false,
    );
    const plan = await f.call(`projects/${project.id}/plans`, {
      name: "Frozen imported OAuth1",
      statusPolicy: "strict200",
      environmentId: saved.environments[0].id,
      steps: saved.requests.map((request) => ({ request })),
    });
    const frozen = structuredClone(plan);
    const live = await f.call(`projects/${project.id}`, undefined, "GET");
    for (const request of live.requests) {
      request.auth.accessToken = "edited-live-token";
      request.auth.parameterPolicy.includeBodyHash =
        !request.auth.parameterPolicy.includeBodyHash;
    }
    await f.call(`projects/${project.id}`, live, "PUT");
    const first = await f.call(`projects/${project.id}/run`, {
      planId: plan.id,
    });
    checkRun(first, f);
    assert.deepEqual(first.snapshot, frozen);
    assert.deepEqual(
      f.seen.map((row) => row.placement),
      ["query", "form", "query", "header", "query", "header"],
    );
    const disk = await new Store(f.root).get(project.id);
    assert.deepEqual(disk.plans[0], frozen);
    assert.deepEqual(
      disk.runs.find((run) => run.id === first.id).results,
      first.results,
    );
    const backup = await f.call(
      `projects/${project.id}/export`,
      undefined,
      "GET",
    );
    const restored = await f.call("restore", { document: backup }, "POST", 201);
    assert.notEqual(restored.id, project.id);
    await f.restart();
    const second = await f.call(`projects/${restored.id}/run`, {
      planId: plan.id,
    });
    checkRun(second, f);
    assert.deepEqual(second.snapshot, frozen);
    assert.equal(second.planHash, first.planHash);
    assert.equal(f.seen.length, specs.size * 2);
    const reopened = await new Store(f.root).get(restored.id);
    assert.deepEqual(reopened.plans[0], frozen);
    assert.deepEqual(
      reopened.runs.find((run) => run.id === first.id).results,
      first.results,
    );
    assert.deepEqual(
      reopened.runs.find((run) => run.id === second.id).results,
      second.results,
    );
    assert.deepEqual(
      await f.call(`projects/${other.id}`, undefined, "GET"),
      otherBefore,
    );
  },
);

test("Postman unrelated bearer and explicit noauth source overrides remain independent of OAuth1 mapping", () => {
  const document = {
    info: { name: "Source-only auth controls", schema },
    auth: sourceAuth("collection-token"),
    item: [
      {
        name: "bearer",
        request: {
          method: "GET",
          url: "http://127.0.0.1:1/not-executed",
          auth: {
            type: "bearer",
            bearer: [{ key: "token", value: "fictional-bearer" }],
          },
        },
      },
      {
        name: "noauth",
        request: {
          method: "GET",
          url: "http://127.0.0.1:1/not-executed",
          auth: { type: "noauth" },
        },
      },
    ],
  };
  const imported = importDocument(document);
  assert.equal(imported[0].auth.type, "bearer");
  assert.equal(imported[0].auth.token, "fictional-bearer");
  assert.equal(imported[1].auth.type, "none");
  assert.equal(Object.hasOwn(imported[1].auth, "parameterPolicy"), false);
  assert.equal(Object.hasOwn(imported[1].auth, "accessToken"), false);
});

test(
  "invalid OAuth1 in a mixed import leaves project and other project unchanged",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const project = await f.call(
      "projects",
      { name: "atomic import" },
      "POST",
      201,
    );
    const other = await f.call("projects", { name: "unrelated" }, "POST", 201);
    const before = await f.call(`projects/${project.id}`, undefined, "GET");
    const otherBefore = await f.call(`projects/${other.id}`, undefined, "GET");
    const document = collection(f.url);
    document.item.push({
      name: "invalid late item",
      request: {
        method: "GET",
        url: `${f.url}/never`,
        auth: sourceAuth("DO-NOT-LEAK", { addParamsToHeader: "false" }),
      },
    });
    const failed = await f.call(
      `projects/${project.id}/import`,
      { document },
      "POST",
      400,
    );
    assert.equal(JSON.stringify(failed).includes("DO-NOT-LEAK"), false);
    assert.deepEqual(
      await f.call(`projects/${project.id}`, undefined, "GET"),
      before,
    );
    await f.restart();
    assert.deepEqual(
      await f.call(`projects/${project.id}`, undefined, "GET"),
      before,
    );
    assert.deepEqual(
      await f.call(`projects/${other.id}`, undefined, "GET"),
      otherBefore,
    );
    assert.deepEqual(f.seen, []);
  },
);

test("null and absent auth inherit while folder noauth cuts source inheritance", () => {
  const leaf = (name, auth) => ({
    name,
    request: {
      method: "GET",
      url: "http://127.0.0.1:1/never",
      ...(auth === undefined ? {} : { auth }),
    },
  });
  const requests = importDocument({
    info: { name: "inheritance", schema },
    auth: sourceAuth("root-token"),
    item: [
      leaf("absent"),
      leaf("null", null),
      {
        name: "cut",
        auth: { type: "noauth" },
        item: [leaf("none"), leaf("null-none", null)],
      },
    ],
  });
  assert.deepEqual(
    requests.map((r) => r.auth.type),
    ["oauth1", "oauth1", "none", "none"],
  );
  assert.deepEqual(
    requests.slice(0, 2).map((r) => r.auth.accessToken),
    ["root-token", "root-token"],
  );
});

test("imported OAuth1 policy cannot silently disappear through definition exports", () => {
  const [request] = importDocument({
    info: { name: "export guard", schema },
    auth: sourceAuth("fictional-token"),
    item: [
      {
        name: "signed",
        request: { method: "GET", url: "http://127.0.0.1:1/never" },
      },
    ],
  });
  assert.throws(
    () => exportOpenAPI({ name: "guard", requests: [request] }),
    /OAuth1/,
  );
  assert.throws(() => toCurl(request), /OAuth1/);
});

test(
  "OpenAPI refuses effective shared OAuth1 policy but preserves explicit auth overrides",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const project = await f.call(
      "projects",
      { name: "shared export" },
      "POST",
      201,
    );
    const [request] = importDocument({
      info: { name: "shared", schema },
      item: [
        { name: "plain", request: { method: "GET", url: `${f.url}/never` } },
      ],
    });
    const policy = expectedAuth("shared-token");
    for (const settings of [
      { globalAuth: policy },
      { folderAuth: { Folder: policy } },
    ]) {
      const before = await f.call(`projects/${project.id}`, undefined, "GET");
      const next = {
        ...before,
        settings: { ...before.settings, ...settings },
        requests: [{ ...request, folder: "Folder", auth: { type: "none" } }],
      };
      await f.call(`projects/${project.id}`, next, "PUT");
      await f.call(
        `projects/${project.id}/export?format=openapi`,
        undefined,
        "GET",
        400,
      );
      for (const override of [
        { auth: { type: "bearer", token: "fictional" } },
        { auth: { type: "none" }, inheritAuth: false },
      ]) {
        assert.doesNotThrow(() =>
          exportOpenAPI({
            ...next,
            requests: [{ ...next.requests[0], ...override }],
          }),
        );
      }
    }
    assert.deepEqual(f.seen, []);
  },
);
