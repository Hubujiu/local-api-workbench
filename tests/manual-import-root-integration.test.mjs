// Cross-composition of the two-step importer with current raw/OAuth/history
// owners. All inputs and credentials are fictional; only owned loopback runs.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { verifyOAuth1Policy } from "./fixtures/oauth1-policy-oracle.mjs";

const xml = '<source value="quote">雪 + &amp; =</source>\r\n';
const updatedXML = '<updated value="quote">雪 + &amp; =</updated>\r\n';
const marker = { version: 1, language: "xml" };
const beforeScript = `pm.request.body.update(${JSON.stringify(updatedXML)});`;
const savedToken = "fictional-manual-import-saved-token";
// Independent expected signing policy, not derived from converted output.
const expectedAuth = {
  type: "oauth1",
  consumerKey: "manual-import-consumer",
  consumerSecret: "fictional-manual-import-consumer-secret",
  accessToken: "manual/import+token%",
  tokenSecret: "fictional-manual-import-token-secret",
  signatureMethod: "HMAC-SHA1",
  nonce: "manual-import-fixed-nonce",
  timestamp: "1700000000",
  version: "1.0",
  parameterPolicy: {
    placement: "header",
    includeBodyHash: true,
    includeEmptyParams: true,
    headerEncoding: "percent",
  },
};
const rows = (values) =>
  Object.entries(values).map(([key, value]) => ({
    key,
    value,
    type: typeof value,
  }));
const savedOAuth2 = (origin) => ({
  accessToken: savedToken,
  addTokenTo: "header",
  headerPrefix: "Bearer",
  authUrl: origin + "/must-not-authorize",
  accessTokenUrl: origin + "/must-not-acquire-token",
  clientId: "fictional-manual-client",
  clientSecret: "fictional-manual-client-secret",
  requestAccessTokenLocally: "1.0",
});
function postman(origin) {
  return {
    info: {
      name: "Manual import raw OAuth composition",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: "Signed XML",
        event: [
          {
            listen: "prerequest",
            script: { type: "text/javascript", exec: [beforeScript] },
          },
        ],
        request: {
          method: "POST",
          url: origin + "/signed?dup=one&dup=two&text=a%2Bb",
          header: [],
          body: {
            mode: "raw",
            raw: xml,
            options: { raw: { language: "xml" } },
          },
          auth: {
            type: "oauth1",
            oauth1: rows({
              consumerKey: expectedAuth.consumerKey,
              consumerSecret: expectedAuth.consumerSecret,
              token: expectedAuth.accessToken,
              tokenSecret: expectedAuth.tokenSecret,
              signatureMethod: "HMAC-SHA1",
              nonce: expectedAuth.nonce,
              timestamp: expectedAuth.timestamp,
              version: "1.0",
              addParamsToHeader: true,
              includeBodyHash: true,
              addEmptyParamsToSign: true,
              disableHeaderEncoding: false,
            }),
          },
        },
      },
      {
        name: "Saved OAuth2",
        request: {
          method: "GET",
          url: origin + "/saved-token",
          auth: { type: "oauth2", oauth2: rows(savedOAuth2(origin)) },
        },
      },
    ],
  };
}
const inputFor = (document, extra = {}) => ({
  format: "auto",
  document,
  selection: { mode: "all" },
  ...extra,
});
async function diskBytes(directory) {
  const out = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const filename = path.join(directory, entry.name);
    out[entry.name] = entry.isDirectory()
      ? await diskBytes(filename)
      : (await readFile(filename)).toString("base64");
  }
  return out;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "manual-import-root-"));
  const seen = [],
    errors = [];
  let origin;
  const peer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks),
      target = new URL(request.url, origin),
      contentTypes = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2)
      if (request.rawHeaders[i].toLowerCase() === "content-type")
        contentTypes.push(request.rawHeaders[i + 1]);
    const observed = {
      path: target.pathname,
      method: request.method,
      body: bytes.toString(),
      bytes: bytes.toString("base64"),
      contentTypes,
      authorization: request.headers.authorization,
    };
    seen.push(observed);
    try {
      if (target.pathname === "/signed") {
        assert.equal(request.method, "POST");
        assert.equal(observed.body, updatedXML);
        assert.equal(
          observed.bytes,
          Buffer.from(updatedXML).toString("base64"),
        );
        // body.update(string) resets the runtime language; the frozen XML
        // definition must retain its original marker separately.
        assert.deepEqual(contentTypes, ["text/plain"]);
        const verified = verifyOAuth1Policy({
          url: target.href,
          method: request.method,
          headers: request.headers,
          body: bytes,
          auth: expectedAuth,
          bodyType: "raw",
        });
        assert.equal(verified.placement, "header");
        assert.deepEqual(verified.ordinaryQuery, [
          ["dup", "one"],
          ["dup", "two"],
          ["text", "a+b"],
        ]);
      } else if (target.pathname === "/saved-token") {
        assert.equal(request.method, "GET");
        assert.equal(request.headers.authorization, "Bearer " + savedToken);
        assert.equal(bytes.length, 0);
      } else if (target.pathname === "/native-saved-token") {
        assert.equal(request.method, "GET");
        assert.equal(request.headers.authorization, "Native " + savedToken);
        assert.equal(bytes.length, 0);
      } else
        assert.fail("unexpected request, including token or refresh endpoint");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ verified: true, ...observed }));
    } catch (error) {
      errors.push(error.message);
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ verified: false }));
    }
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + peer.address().port;
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await Promise.all([close(app.server), close(peer)]);
    await rm(root, { recursive: true, force: true });
  });
  async function api(
    route,
    body,
    method = body === undefined ? "GET" : "POST",
    status = 200,
  ) {
    const response = await fetch(app.url + "/api" + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  const project = await api(
    "/projects",
    { name: "Manual root composition" },
    "POST",
    201,
  );
  const untouched = await api(
    "/projects",
    { name: "Untouched peer" },
    "POST",
    201,
  );
  return {
    root,
    origin,
    seen,
    errors,
    api,
    project,
    untouched,
    route: "/projects/" + project.id,
    read: (id = project.id) => new Store(root).get(id),
    get app() {
      return app;
    },
    async restart() {
      await close(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}
function assertPrivateMetadata(value) {
  const text = JSON.stringify(value);
  for (const privateValue of [
    "<source value=",
    "<updated value=",
    "pm.request.body.update",
    beforeScript,
    xml,
    updatedXML,
    expectedAuth.consumerSecret,
    expectedAuth.tokenSecret,
    savedToken,
    "fictional-manual-client-secret",
  ])
    assert.equal(
      text.includes(JSON.stringify(privateValue).slice(1, -1)),
      false,
      "summary leaked definition",
    );
}
test("private summary assertion detects escaped script and raw-body strings", () => {
  for (const privateValue of [xml, updatedXML, beforeScript])
    assert.throws(
      () => assertPrivateMetadata({ nested: { value: privateValue } }),
      /summary leaked definition/,
    );
});

async function apply(f, input) {
  const before = await diskBytes(f.root),
    count = f.seen.length;
  const preview = await f.api(f.route + "/import-preview", input);
  assert.deepEqual(preview.blockers, []);
  assert.equal(typeof preview.token, "string");
  assertPrivateMetadata(preview);
  assert.deepEqual(await diskBytes(f.root), before, "preview is byte-inert");
  assert.equal(f.seen.length, count, "preview cannot execute source requests");
  const applied = await f.api(f.route + "/import-apply", {
    input,
    token: preview.token,
  });
  assert.deepEqual(Object.keys(applied).sort(), [
    "configRevision",
    "counts",
    "noOp",
    "revision",
  ]);
  assertPrivateMetadata(applied);
  assert.equal(
    f.seen.length,
    count,
    "apply cannot execute source or acquire tokens",
  );
  return { preview, applied, project: await f.read() };
}
function assertSigned(request) {
  assert.equal(request.bodyType, "raw");
  assert.equal(request.body, xml);
  assert.deepEqual(request.postmanRawBody, marker);
  assert.deepEqual(request.auth, expectedAuth);
  assert.equal(request.beforeScript, beforeScript);
  assert.deepEqual(request.headers, []);
}
async function assertRun(f, route, plan, environmentId) {
  const run = await f.api(route + "/run", { planId: plan.id, environmentId });
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.deepEqual(run.snapshot, plan);
  assert.equal(run.results.length, 2);
  for (const result of run.results) {
    assert.equal(result.response.status, 200);
    assert.equal(JSON.parse(result.response.body).verified, true);
  }
  assert.equal(run.results[0].request.body, updatedXML);
  assert.deepEqual(run.results[0].request.postmanRawBody, {
    version: 1,
    language: "default",
  });
  assert.deepEqual(
    run.results[0].request.auth.parameterPolicy,
    expectedAuth.parameterPolicy,
  );
  assert.deepEqual(f.errors, []);
  return run;
}

test(
  "manual Postman preview/apply composes raw signing, frozen cases/plans, overwrite history and fresh-identity backup without replay",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const untouched = await f.read(f.untouched.id),
      untouchedBytes = await diskBytes(f.app.store.directory(f.untouched.id));
    const first = await apply(f, inputFor(postman(f.origin)));
    assert.equal(first.project.requests.length, 2);
    const original = first.project.requests.find(
        (r) => r.name === "Signed XML",
      ),
      oauth2 = first.project.requests.find((r) => r.name === "Saved OAuth2");
    assertSigned(original);
    assert.deepEqual(oauth2.auth, {
      type: "oauth2",
      postmanOAuth2: { version: 1, ...savedOAuth2(f.origin) },
    });
    assert.deepEqual(first.project.history, []);
    const environmentId = first.project.environments[0].id;
    const savedCase = (
      await f.api(f.route + "/cases", {
        name: "Frozen signed XML",
        sourceRequestId: original.id,
        request: original,
      })
    ).item;
    assertSigned(savedCase.request);
    const planReceipt = await f.api(f.route + "/plans", {
      name: "Frozen imported raw and OAuth2",
      environmentId,
      steps: [original, oauth2].map((request, index) => ({
        id: "step-" + index,
        request,
      })),
    });
    const plan = (await f.read()).plans.find((p) => p.id === planReceipt.id);
    assertSigned(plan.steps[0].request);
    assert.deepEqual(plan.steps[1].request.auth, oauth2.auth);
    assert.equal(f.seen.length, 0);

    const changed = postman(f.origin);
    changed.item = [changed.item[0]];
    changed.item[0].request.body.raw = "live replacement must not execute";
    changed.item[0].request.body.options.raw.language = "text";
    changed.item[0].event[0].script.exec = [
      'throw Error("live replacement must not execute");',
    ];
    const overwritten = await apply(
      f,
      inputFor(changed, { policies: { api: "url" } }),
    );
    const live = overwritten.project.requests.find((r) => r.id === original.id);
    assert.equal(live.body, "live replacement must not execute");
    assert.deepEqual(live.postmanRawBody, { version: 1, language: "text" });
    assert.deepEqual(overwritten.project.cases[0], savedCase);
    assert.deepEqual(overwritten.project.plans[0], plan);
    const historyRoute = f.route + "/definition-history";
    const list = await f.api(
      historyRoute + "?requestId=" + encodeURIComponent(original.id),
    );
    assert.equal(list.total, 1);
    assertPrivateMetadata(list);
    const entry = overwritten.project.requestDefinitionHistory.entries.find(
      (e) => e.requestId === original.id,
    );
    assert.equal(entry.versions.length, 1);
    assert.deepEqual(entry.versions[0].definition, original);
    assert.equal(f.seen.length, 0, "overwrite and history reads remain inert");
    await f.restart();
    const run = await assertRun(f, f.route, plan, environmentId);
    assert.equal(f.seen.length, 2);
    const current = await f.read();
    const restored = await f.api(historyRoute, {
      kind: "restore",
      requestId: original.id,
      lineageId: list.lineageId,
      historyId: list.versions[0].id,
      configRevision: current.configRevision,
    });
    assertPrivateMetadata(restored);
    const restoredProject = await f.read();
    assert.deepEqual(
      restoredProject.requests.find((r) => r.id === original.id),
      original,
    );
    assert.deepEqual(restoredProject.plans[0], plan);
    assert.deepEqual(restoredProject.cases[0], savedCase);
    assert.equal(
      f.seen.length,
      2,
      "history restore never executes a before-script",
    );
    const backup = await f.api(f.route + "/export");
    const copyReceipt = await f.api(
      "/restore",
      { document: backup },
      "POST",
      201,
    );
    assert.notEqual(copyReceipt.id, f.project.id);
    await f.restart();
    const copy = await f.read(copyReceipt.id);
    assert.deepEqual(copy.requests, backup.requests);
    assert.deepEqual(copy.cases, backup.cases);
    assert.deepEqual(copy.plans, backup.plans);
    assert.deepEqual(copy.runs, backup.runs);
    assert.deepEqual(copy.requestDefinitionHistory, {
      ...backup.requestDefinitionHistory,
      projectId: copy.id,
    });
    assertSigned(copy.cases[0].request);
    assertSigned(copy.plans[0].steps[0].request);
    assert.deepEqual(copy.runs.find((r) => r.id === run.id).snapshot, plan);
    assert.equal(
      f.seen.length,
      2,
      "backup restore and reopen never replay execution",
    );
    const copyHistoryRoute = "/projects/" + copy.id + "/definition-history";
    const copyHistory = await f.api(
      copyHistoryRoute + "?requestId=" + encodeURIComponent(original.id),
    );
    assert.equal(copyHistory.lineageId, list.lineageId);
    assert.ok(copyHistory.versions.some((v) => v.id === list.versions[0].id));
    const copyRestored = await f.api(copyHistoryRoute, {
      kind: "restore",
      requestId: original.id,
      lineageId: copyHistory.lineageId,
      historyId: list.versions[0].id,
      configRevision: copyHistory.configRevision,
    });
    assertPrivateMetadata(copyHistory);
    assertPrivateMetadata(copyRestored);
    assertSigned(
      (await f.read(copy.id)).requests.find((r) => r.id === original.id),
    );
    assert.equal(
      f.seen.length,
      2,
      "fresh-identity history restore stays inert",
    );
    await assertRun(f, "/projects/" + copy.id, plan, environmentId);
    assert.equal(f.seen.length, 4);
    assert.deepEqual(
      f.seen.map((r) => r.path),
      ["/signed", "/saved-token", "/signed", "/saved-token"],
    );
    assert.deepEqual(await f.read(f.untouched.id), untouched);
    assert.deepEqual(
      await diskBytes(f.app.store.directory(f.untouched.id)),
      untouchedBytes,
    );
  },
);

test(
  "manual canonical native OAuth2 acquisition/refresh metadata survives import, freeze and restore without token traffic",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const definition = {
      addTokenTo: "header",
      headerPrefix: "Native",
      access_token: savedToken,
      grant_type: "client_credentials",
      authUrl: f.origin + "/must-not-authorize",
      accessTokenUrl: f.origin + "/must-not-acquire-token",
      refreshTokenUrl: f.origin + "/must-not-refresh-token",
      clientId: "fictional-native-client",
      clientSecret: "fictional-native-secret",
      client_authentication: "body",
      authRequestParams: [],
      tokenRequestParams: [],
      refreshRequestParams: [],
    };
    const imported = await apply(
      f,
      inputFor({
        requests: [
          {
            id: "native-source",
            name: "Native saved OAuth2",
            method: "GET",
            url: f.origin + "/native-saved-token",
            auth: { type: "oauth2", nativeOAuth2: definition },
          },
        ],
      }),
    );
    const request = imported.project.requests[0];
    assert.deepEqual(request.auth, {
      type: "oauth2",
      nativeOAuth2: definition,
    });
    const receipt = await f.api(f.route + "/plans", {
      name: "Frozen native saved token",
      environmentId: imported.project.environments[0].id,
      steps: [{ id: "native-step", request }],
    });
    const original = await f.read();
    assert.deepEqual(original.plans[0].steps[0].request.auth, request.auth);
    const backup = await f.api(f.route + "/export");
    const restored = await f.api("/restore", { document: backup }, "POST", 201);
    assert.notEqual(restored.id, f.project.id);
    const copy = await f.read(restored.id);
    assert.deepEqual(copy.requests, original.requests);
    assert.deepEqual(copy.plans, original.plans);
    assert.equal(
      f.seen.length,
      0,
      "all URLs, including acquisition and refresh, remain inert",
    );
    const run = await f.api("/projects/" + copy.id + "/run", {
      planId: receipt.id,
      environmentId: copy.environments[0].id,
    });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(run.results[0].response.status, 200);
    assert.deepEqual(
      f.seen.map((r) => r.path),
      ["/native-saved-token"],
    );
    assert.deepEqual(f.errors, []);
  },
);

test(
  "manual imported raw definitions remain explicit live and frozen native export refusals",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const imported = await apply(
      f,
      inputFor({
        requests: [
          {
            id: "raw-source",
            name: "Native export raw boundary",
            method: "POST",
            url: f.origin + "/inert-export",
            bodyType: "raw",
            body: xml,
            headers: [
              { key: "Content-Type", value: "application/xml", enabled: true },
            ],
            postmanRawBody: marker,
            scriptDialect: "apipost8",
            inheritSharedScripts: false,
          },
        ],
      }),
    );
    const before = await diskBytes(f.root);
    for (const format of ["apipost", "apipost-directory"]) {
      const rejected = await f.api(
        f.route + "/export?format=" + format,
        undefined,
        "GET",
        400,
      );
      assert.match(rejected.error, /Postman raw/);
    }
    assert.deepEqual(await diskBytes(f.root), before);
    const request = imported.project.requests[0];
    await f.api(f.route + "/plans", {
      name: "Frozen raw export boundary",
      environmentId: imported.project.environments[0].id,
      steps: [{ id: "raw-step", request }],
    });
    const unmarked = structuredClone(request);
    delete unmarked.postmanRawBody;
    const overwritten = await apply(
      f,
      inputFor({ requests: [unmarked] }, { policies: { api: "url" } }),
    );
    assert.equal(overwritten.project.requests[0].postmanRawBody, undefined);
    assert.deepEqual(
      overwritten.project.plans[0].steps[0].request.postmanRawBody,
      marker,
    );
    const frozenBytes = await diskBytes(f.root);
    const rejected = await f.api(
      f.route + "/export?format=apipost-directory",
      undefined,
      "GET",
      400,
    );
    assert.match(rejected.error, /冻结步骤Postman raw/);
    assert.deepEqual(await diskBytes(f.root), frozenBytes);
    const backup = await f.api(f.route + "/export");
    assert.deepEqual(backup.plans, overwritten.project.plans);
    assert.equal(f.seen.length, 0);
  },
);

test(
  "manual import rejects malformed canonical/raw Postman metadata before any persistence, even when the invalid row is unselected",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const before = await diskBytes(f.root),
      initial = await f.read();
    const valid = {
      id: "valid",
      name: "Valid XML",
      method: "POST",
      url: f.origin + "/inert-valid",
      bodyType: "raw",
      body: xml,
      postmanRawBody: marker,
    };
    const secret = "fictional-invalid-raw-secret";
    const invalidDocuments = [
      ...[
        null,
        {},
        { version: 2, language: "xml" },
        { version: 1, language: "unknown" },
        { version: 1, language: "xml", secret },
      ].map((postmanRawBody) => ({
        requests: [
          valid,
          { ...valid, id: "bad", name: "Invalid", postmanRawBody },
        ],
      })),
      ...[
        (item) => {
          item.request.body.options.raw.language = { secret };
        },
        (item) => {
          item.request.body.options.raw.secret = secret;
        },
        (item) => {
          item.request.body.raw = { secret };
        },
      ].map((mutate) => {
        const document = postman(f.origin);
        mutate(document.item[0]);
        return document;
      }),
    ];
    const validInput = inputFor({ requests: [valid] });
    const authorizedPreview = await f.api(
      f.route + "/import-preview",
      validInput,
    );
    for (const document of invalidDocuments) {
      for (const selection of [
        { mode: "all" },
        { mode: "explicit", keys: [] },
      ]) {
        const input = inputFor(document, { selection });
        const rejected = await f.api(
          f.route + "/import-preview",
          input,
          "POST",
          400,
        );
        assert.match(rejected.error, /手动导入/);
        assert.equal(JSON.stringify(rejected).includes(secret), false);
        const refusedApply = await f.api(
          f.route + "/import-apply",
          { token: authorizedPreview.token, input },
          "POST",
          400,
        );
        assert.equal(JSON.stringify(refusedApply).includes(secret), false);
        assert.deepEqual(await diskBytes(f.root), before);
        assert.deepEqual(await f.read(), initial);
        assert.equal(f.seen.length, 0);
      }
    }
  },
);
