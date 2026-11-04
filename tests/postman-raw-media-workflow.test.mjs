import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { importCurl, importDocument } from "../src/core.mjs";

// XML/HTML/JavaScript here is opaque fixture text, never parsed or evaluated.
// These loopback workflows are intended for CI; authoring checks do not run them.
const token = "raw-media-fixture-bearer";
const mediaCases = [
  {
    language: "xml",
    media: "application/xml",
    body: '<?xml version="1.0"?>\r\n<!DOCTYPE x [<!ENTITY e SYSTEM "file:///never-read/raw-media-secret">]>\r\n<x>中文 &e; + & =</x>\r\n',
  },
  {
    language: "html",
    media: "text/html",
    body: '<!doctype html>\r\n<p data-x="a&b">中文 + & =</p>\n',
  },
  {
    language: "javascript",
    media: "application/javascript",
    body: 'throw new Error("inert raw body, never execute");\n// 中文 + & =\n',
  },
  { language: "text", media: "text/plain", body: "raw 中文 + & =\r\n" },
  {
    language: null,
    markerLanguage: "default",
    media: "text/plain",
    body: "omitted language\n",
  },
  {
    language: "",
    markerLanguage: "default",
    media: "text/plain",
    body: "empty language\n",
  },
  {
    language: "unrecognized-editor-language",
    markerLanguage: "text",
    media: "text/plain",
    body: "fallback language\n",
  },
];
const marker = (language = "xml") => ({ version: 1, language });
function rawItem(
  url,
  {
    language = "xml",
    body = "<original>中文</original>",
    headers = [],
    script,
    method = "POST",
    disabled,
  } = {},
) {
  return {
    name: "Raw " + url.split("/").at(-1),
    ...(script === undefined
      ? {}
      : {
          event: [
            {
              listen: "prerequest",
              script: { type: "text/javascript", exec: [script] },
            },
          ],
        }),
    request: {
      method,
      url,
      header: headers,
      body: {
        mode: "raw",
        raw: body,
        ...(language === null ? {} : { options: { raw: { language } } }),
        ...(disabled === undefined ? {} : { disabled }),
      },
    },
  };
}
function collection(items, auth) {
  return {
    info: {
      name: "Opaque Postman raw media",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    ...(auth ? { auth } : {}),
    item: items,
  };
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "postman-raw-media-"));
  const seen = [];
  const peer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const contentTypes = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2)
      if (request.rawHeaders[i].toLowerCase() === "content-type")
        contentTypes.push(request.rawHeaders[i + 1]);
    const entry = {
      method: request.method,
      url: request.url,
      contentType: request.headers["content-type"] ?? null,
      contentTypes,
      authorization: request.headers.authorization ?? null,
      body: bytes.toString("utf8"),
      bodyBase64: bytes.toString("base64"),
    };
    seen.push(entry);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(entry));
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await Promise.all([close(app.server), close(peer)]);
    await rm(root, { recursive: true, force: true });
  });
  async function response(route, data, method = "POST") {
    return fetch(app.url + "/api" + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  }
  async function api(route, data, method = "POST") {
    const res = await response(route, data, method);
    const body = await res.text();
    assert.equal(res.ok, true, body);
    return JSON.parse(body);
  }
  const project = await api("/projects", { name: "Raw media owner workflow" });
  project.environments = [
    { id: "selected", name: "Selected", variables: { guard: "unchanged" } },
  ];
  project.globalVariables = { globalGuard: "unchanged" };
  const route = "/projects/" + project.id;
  await api(route, project, "PUT");
  return {
    root,
    seen,
    api,
    response,
    project,
    route,
    url: "http://127.0.0.1:" + peer.address().port,
    async restart() {
      await close(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}
async function diskSnapshot(directory) {
  const files = {};
  async function walk(current, prefix = "") {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const relative = prefix + entry.name;
      if (entry.isDirectory())
        await walk(path.join(current, entry.name), relative + "/");
      else {
        assert.equal(entry.isFile(), true);
        files[relative] = (
          await readFile(path.join(current, entry.name))
        ).toString("base64");
      }
    }
  }
  await walk(directory);
  return files;
}
function assertEcho(response, body, contentType, authorization = null) {
  assert.equal(response.status, 200, response.error);
  const echo = JSON.parse(response.body);
  assert.equal(echo.method, "POST");
  assert.equal(echo.body, body);
  assert.equal(echo.bodyBase64, Buffer.from(body, "utf8").toString("base64"));
  assert.equal(echo.contentType, contentType);
  assert.deepEqual(
    echo.contentTypes,
    contentType === null ? [] : [contentType],
  );
  assert.equal(echo.authorization, authorization);
}
async function freeze(f, requests, id = "raw-plan") {
  const receipt = await f.api(f.route + "/plans", {
    id,
    name: "Frozen raw media",
    environmentId: "selected",
    steps: requests.map((request) => ({ request })),
  });
  // Creation adds save-receipt fields, which are not part of the frozen plan.
  const {
    projectRevision,
    projectConfigRevision,
    projectFingerprint,
    ...definition
  } = receipt;
  assert.deepEqual(
    (await f.api(f.route, undefined, "GET")).plans.find(
      (plan) => plan.id === id,
    ),
    definition,
  );
  return definition;
}
function assertGuards(project) {
  assert.deepEqual(project.environments[0].variables, { guard: "unchanged" });
  assert.deepEqual(project.globalVariables, { globalGuard: "unchanged" });
}

test("opaque raw language media survives owner import, exact freeze, live edits, restart, saved results and isolated restore", async (t) => {
  const f = await fixture(t);
  const unrelated = await f.api("/projects", { name: "Unrelated project" });
  const unrelatedBefore = await f.api(
    "/projects/" + unrelated.id,
    undefined,
    "GET",
  );
  let project = await f.api(f.route + "/import", {
    document: collection(
      mediaCases.map((entry, index) => rawItem(f.url + "/raw/" + index, entry)),
      {
        type: "bearer",
        bearer: [{ key: "token", value: token, type: "string" }],
      },
    ),
  });
  const originals = structuredClone(project.requests);
  for (const [index, request] of originals.entries()) {
    assert.equal(request.bodyType, "raw");
    assert.equal(request.body, mediaCases[index].body);
    assert.deepEqual(
      request.postmanRawBody,
      marker(mediaCases[index].markerLanguage ?? mediaCases[index].language),
    );
    assert.deepEqual(
      request.headers,
      [],
      "generated media is execution data, not a saved explicit header",
    );
    assert.deepEqual(request.auth, { type: "bearer", token });
  }
  const definition = await freeze(f, originals);
  assert.equal(
    f.seen.length,
    0,
    "import and freeze must not execute fixture text or send traffic",
  );
  for (const [index, request] of originals.entries())
    assertEcho(
      await f.api(f.route + "/execute", { request, environmentId: "selected" }),
      mediaCases[index].body,
      mediaCases[index].media,
      "Bearer " + token,
    );
  project = await f.api(f.route, undefined, "GET");
  assert.deepEqual(
    project.requests,
    originals,
    "execution must not persist generated headers or alter auth",
  );
  project.requests.forEach((request) => {
    request.body = "live changed";
    request.url += "/live-changed";
    request.auth.token = "live-changed-token";
    request.postmanRawBody = marker("text");
  });
  await f.api(f.route, project, "PUT");
  await f.restart();
  const run = await f.api(f.route + "/run", {
    planId: definition.id,
    environmentId: "selected",
  });
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.deepEqual(run.snapshot, definition);
  for (const [index, result] of run.results.entries()) {
    assertEcho(
      result.response,
      mediaCases[index].body,
      mediaCases[index].media,
      "Bearer " + token,
    );
    assert.deepEqual(
      result.request.postmanRawBody,
      originals[index].postmanRawBody,
    );
    assert.deepEqual(result.request.auth, originals[index].auth);
  }
  const beforeRestore = await f.api(f.route, undefined, "GET");
  assert.deepEqual(beforeRestore.plans[0], definition);
  assertGuards(beforeRestore);
  const count = f.seen.length;
  assert.equal(count, originals.length * 2);
  const backup = await f.api(f.route + "/export", undefined, "GET");
  const restored = await f.api("/restore", { document: backup });
  assert.notEqual(restored.id, project.id);
  await f.restart();
  const restoredRoute = "/projects/" + restored.id;
  const reopened = await f.api(restoredRoute, undefined, "GET");
  assert.equal(
    f.seen.length,
    count,
    "backup/restore/restart must not replay traffic",
  );
  assert.deepEqual(reopened.plans[0], definition);
  assert.deepEqual(
    reopened.runs.find((entry) => entry.id === run.id).results,
    run.results,
  );
  assert.deepEqual(
    reopened.runs.find((entry) => entry.id === run.id).snapshot,
    definition,
  );
  const rerun = await f.api(restoredRoute + "/run", {
    planId: definition.id,
    environmentId: "selected",
  });
  assert.equal(rerun.status, "passed", JSON.stringify(rerun));
  assert.deepEqual(rerun.snapshot, definition);
  rerun.results.forEach((result, index) =>
    assertEcho(
      result.response,
      mediaCases[index].body,
      mediaCases[index].media,
      "Bearer " + token,
    ),
  );
  assert.equal(f.seen.length, count + originals.length);
  assert.equal(
    f.seen.some(
      (entry) =>
        entry.url.includes("live-changed") || entry.body === "live changed",
    ),
    false,
  );
  assert.deepEqual(
    await f.api(f.route, undefined, "GET"),
    beforeRestore,
    "restored execution must not alter the original project",
  );
  assert.deepEqual(
    await f.api("/projects/" + unrelated.id, undefined, "GET"),
    unrelatedBefore,
  );
  assertGuards(await f.api(restoredRoute, undefined, "GET"));
});

test("explicit and disabled Content-Type rows, empty/whitespace bodies and legacy raw retain distinct wire behavior", async (t) => {
  const f = await fixture(t);
  const cases = [
    {
      headers: [
        { key: "cOnTeNt-TyPe", value: "application/custom", disabled: false },
      ],
      body: "<explicit/>",
      media: "application/custom",
    },
    {
      headers: [{ key: "Content-Type", value: "", disabled: false }],
      body: "<empty-header/>",
      media: "",
    },
    {
      headers: [
        { key: "CONTENT-TYPE", value: "application/disabled", disabled: true },
      ],
      body: "<disabled-header/>",
      media: "application/xml",
    },
    {
      headers: [
        { key: "Content-Type", value: "application/custom" },
        { key: "content-type", value: "application/disabled", disabled: true },
      ],
      body: "<mixed-header/>",
      media: "application/custom",
    },
    { body: "", media: null },
    { body: " \t\r\n", media: "application/xml" },
    { body: "not sent", disabled: true, media: null },
    {
      body: "not sent",
      disabled: true,
      headers: [
        { key: "Content-Type", value: "application/explicit-disabled-body" },
      ],
      media: "application/explicit-disabled-body",
    },
  ];
  const project = await f.api(f.route + "/import", {
    document: collection(
      cases.map((entry, index) => rawItem(f.url + "/headers/" + index, entry)),
    ),
  });
  const saved = structuredClone(project.requests);
  for (const [index, request] of project.requests.entries()) {
    const entry = cases[index];
    assertEcho(
      await f.api(f.route + "/execute", { request, environmentId: "selected" }),
      entry.disabled ? "" : entry.body,
      entry.media,
    );
    if (entry.disabled) {
      assert.equal(request.bodyType, "none");
      assert.equal(Object.hasOwn(request, "postmanRawBody"), false);
    }
  }
  assert.deepEqual((await f.api(f.route, undefined, "GET")).requests, saved);
  assertEcho(
    await f.api(f.route + "/execute", {
      request: {
        name: "Legacy unmarked raw",
        method: "POST",
        url: f.url + "/legacy",
        bodyType: "raw",
        body: "legacy raw",
      },
      environmentId: "selected",
    }),
    "legacy raw",
    null,
  );
  const duplicate = structuredClone(project.requests[0]);
  duplicate.headers.push({
    key: "CONTENT-TYPE",
    value: "application/second",
    enabled: true,
  });
  const count = f.seen.length;
  const blocked = await f.api(f.route + "/execute", {
    request: duplicate,
    environmentId: "selected",
  });
  assert.notEqual(blocked.outcome, "passed");
  assert.match(blocked.error, /重复|单值/);
  assert.equal(
    f.seen.length,
    count,
    "generated defaults must not weaken singleton header rejection",
  );
});

test("raw media is selected after imported before-script updates without mutating frozen definitions", async (t) => {
  const f = await fixture(t);
  const cases = [
    {
      script:
        'pm.test("default is not yet materialized",()=>pm.expect(pm.request.headers.has("Content-Type")).to.equal(false));',
      body: "<original>中文</original>",
      media: "application/xml",
      language: "xml",
    },
    {
      script: 'pm.request.body.update("string 中文\\r\\n");',
      body: "string 中文\r\n",
      media: "text/plain",
      language: "default",
    },
    {
      script:
        'pm.request.body.update({mode:"raw",raw:"<h1>changed</h1>",options:{raw:{language:"html"}}});',
      body: "<h1>changed</h1>",
      media: "text/html",
      language: "html",
    },
    {
      script: 'pm.request.body.update({mode:"raw",raw:"options-less raw"});',
      body: "options-less raw",
      media: "text/plain",
      language: "default",
    },
    {
      script:
        'pm.request.headers.upsert({key:"cOnTeNt-TyPe",value:"application/from-script"});',
      body: "<original>中文</original>",
      media: "application/from-script",
      language: "xml",
    },
    {
      script: 'pm.request.headers.upsert({key:"Content-Type",value:""});',
      body: "<original>中文</original>",
      media: "",
      language: "xml",
    },
    {
      script: 'pm.request.headers.remove("Content-Type");',
      headers: [{ key: "Content-Type", value: "application/remove-me" }],
      body: "<original>中文</original>",
      media: "application/xml",
      language: "xml",
    },
    {
      script: 'pm.request.body.update("");',
      body: "",
      media: null,
      language: "default",
    },
    {
      script:
        'pm.request.body.update({mode:"raw",raw:"{\\"ok\\":true}",options:{raw:{language:"json"}}});',
      body: '{"ok":true}',
      media: "application/json",
      language: "json",
    },
    {
      script:
        'pm.request.body.update({mode:"raw",raw:"{\\"ok\\":true}",options:{raw:{language:"json"}}});pm.request.body.update("back to text");',
      body: "back to text",
      media: "text/plain",
      language: "default",
    },
    {
      script:
        'pm.request.body.update({mode:"urlencoded",urlencoded:[{key:"a",value:"中文 + & ="}]});',
      body: "a=%E4%B8%AD%E6%96%87+%2B+%26+%3D",
      media: "application/x-www-form-urlencoded",
      language: "xml",
    },
    {
      script:
        'pm.test("final-body read",()=>pm.expect(pm.getFinalRequestRawBody()).to.equal("<original>中文</original>"));',
      body: "<original>中文</original>",
      media: "application/xml",
      language: "xml",
    },
  ];
  const project = await f.api(f.route + "/import", {
    document: collection(
      cases.map((entry, index) =>
        rawItem(f.url + "/scripts/" + index, {
          script: entry.script,
          headers: entry.headers,
        }),
      ),
    ),
  });
  const originals = structuredClone(project.requests);
  const definition = await freeze(f, project.requests, "script-plan");
  await f.restart();
  const run = await f.api(f.route + "/run", {
    planId: definition.id,
    environmentId: "selected",
  });
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.deepEqual(run.snapshot, definition);
  for (const [index, result] of run.results.entries()) {
    const expected = cases[index];
    assertEcho(result.response, expected.body, expected.media);
    assert.deepEqual(result.request.postmanRawBody, marker(expected.language));
  }
  const saved = await f.api(f.route, undefined, "GET");
  assert.deepEqual(saved.requests, originals);
  assert.deepEqual(saved.plans[0], definition);
  assert.deepEqual(saved.runs[0].results, run.results);
  assertGuards(saved);
  assert.equal(f.seen.length, cases.length);
});

test("nonempty source-marked GET/HEAD fail before wire while empty GET remains bodyless", async (t) => {
  const f = await fixture(t);
  const project = await f.api(f.route + "/import", {
    document: collection(
      ["GET", "HEAD"].map((method) =>
        rawItem(f.url + "/pruned/" + method, { method }),
      ),
    ),
  });
  for (const request of project.requests) {
    const result = await f.api(f.route + "/execute", {
      request,
      environmentId: "selected",
    });
    assert.notEqual(result.outcome, "passed");
    assert.equal(typeof result.error, "string");
    assert.match(result.error, /Postman|正文|body|GET|HEAD/);
  }
  const definition = await freeze(f, project.requests, "pruned-plan");
  const run = await f.api(f.route + "/run", {
    planId: definition.id,
    environmentId: "selected",
  });
  assert.notEqual(run.status, "passed");
  assert.deepEqual(run.snapshot, definition);
  assert.equal(
    f.seen.length,
    0,
    "unsupported Postman method pruning is explicit, never an accidental send",
  );
  const request = { ...project.requests[0], body: "" };
  const empty = await f.api(f.route + "/execute", {
    request,
    environmentId: "selected",
  });
  assert.equal(empty.status, 200);
  const echo = JSON.parse(empty.body);
  assert.equal(echo.method, "GET");
  assert.equal(echo.body, "");
  assert.equal(echo.contentType, null);
  assert.equal(f.seen.length, 1);
});

test("default language plus any Content-Type and invalid script JSON are explicit zero-wire boundaries", async (t) => {
  const f = await fixture(t);
  const cases = [
    rawItem(f.url + "/json-boundary/active", {
      language: null,
      body: '// not transformed\n{"ok":true}',
      headers: [{ key: "Content-Type", value: "application/json" }],
    }),
    rawItem(f.url + "/json-boundary/disabled", {
      language: "",
      body: '{"ok":true}',
      headers: [
        { key: "CONTENT-TYPE", value: "application/json", disabled: true },
      ],
    }),
    rawItem(f.url + "/json-boundary/non-json-disabled", {
      language: null,
      body: "default raw",
      headers: [
        { key: "Content-Type", value: "text/plain", disabled: true },
        { key: "content-type", value: "text/plain", disabled: true },
      ],
    }),
    rawItem(f.url + "/json-boundary/non-json-active", {
      language: null,
      body: "default raw",
      headers: [{ key: "Content-Type", value: "application/custom" }],
    }),
    rawItem(f.url + "/json-boundary/script", {
      script:
        'pm.request.body.update({mode:"raw",raw:"// comment\\n{\\"ok\\":true}",options:{raw:{language:"json"}}});',
    }),
    rawItem(f.url + "/json-boundary/interpolation", {
      script:
        'pm.variables.set("broken", "\\\"");pm.request.body.update({mode:"raw",raw:"{\\"value\\":\\"{{broken}}\\"}",options:{raw:{language:"json"}}});',
    }),
    rawItem(f.url + "/json-boundary/empty", {
      script:
        'pm.request.body.update({mode:"raw",raw:"",options:{raw:{language:"json"}}});',
    }),
  ];
  const project = await f.api(f.route + "/import", {
    document: collection(cases),
  });
  for (const request of project.requests) {
    const result = await f.api(f.route + "/execute", {
      request,
      environmentId: "selected",
    });
    assert.notEqual(result.outcome, "passed");
    assert.equal(typeof result.error, "string");
    assert.notEqual(result.error.length, 0);
  }
  assert.equal(
    f.seen.length,
    0,
    "default-header ambiguity, JSONC and invalid/empty raw JSON must fail before wire",
  );
  const oldJSON = await f.api(f.route + "/import", {
    document: collection([
      rawItem(f.url + "/unmarked-json", {
        language: "json",
        body: '{"legacy":true}',
      }),
    ]),
  });
  const oldJSONRequest = oldJSON.requests.at(-1);
  assert.equal(Object.hasOwn(oldJSONRequest, "postmanRawBody"), false);
  assertEcho(
    await f.api(f.route + "/execute", {
      request: oldJSONRequest,
      environmentId: "selected",
    }),
    '{"legacy":true}',
    "application/json",
  );
  const explicitText = await f.api(f.route + "/import", {
    document: collection([
      rawItem(f.url + "/json-boundary/explicit-text", {
        language: "text",
        body: '// retained literally\n{"ok":true}',
        headers: [{ key: "Content-Type", value: "application/json" }],
      }),
    ]),
  });
  assertEcho(
    await f.api(f.route + "/execute", {
      request: explicitText.requests.at(-1),
      environmentId: "selected",
    }),
    '// retained literally\n{"ok":true}',
    "application/json",
  );
});

test("mixed invalid raw/file/profile imports are atomic, zero-wire and do not disclose source secrets", async (t) => {
  const f = await fixture(t);
  await f.api(f.route + "/import", {
    document: collection([rawItem(f.url + "/existing")]),
  });
  const before = await f.api(f.route, undefined, "GET");
  const disk = await diskSnapshot(f.root);
  const secret = "RAW_MEDIA_PRIVATE_FIXTURE_7319";
  const invalids = [
    (item) => {
      item.request.body.raw = { secret };
    },
    (item) => {
      item.request.body.mode = "file";
      item.request.body.file = { src: "/never-read/" + secret };
    },
    (item) => {
      item.protocolProfileBehavior = {
        disabledSystemHeaders: { "content-type": true },
        secret,
      };
    },
    (item) => {
      item.request.protocolProfileBehavior = {
        disableBodyPruning: true,
        secret,
      };
    },
  ];
  for (const change of invalids) {
    const invalid = rawItem(f.url + "/invalid");
    change(invalid);
    const response = await f.response(f.route + "/import", {
      document: collection([rawItem(f.url + "/would-be-valid"), invalid], {
        type: "bearer",
        bearer: [{ key: "token", value: secret }],
      }),
    });
    const error = await response.text();
    assert.equal(response.status, 400, error);
    assert.equal(
      error.includes(secret),
      false,
      "validation diagnostics must not echo raw payload/auth/profile values",
    );
    assert.deepEqual(await f.api(f.route, undefined, "GET"), before);
    assert.deepEqual(await diskSnapshot(f.root), disk);
    assert.equal(f.seen.length, 0);
  }
  for (const inherited of ["collection", "folder"]) {
    const raw = rawItem(f.url + "/inherited-profile");
    const document = collection(
      inherited === "folder"
        ? [{ name: "Folder", protocolProfileBehavior: { secret }, item: [raw] }]
        : [rawItem(f.url + "/valid-first"), raw],
    );
    if (inherited === "collection")
      document.protocolProfileBehavior = { secret };
    const response = await f.response(f.route + "/import", { document });
    const error = await response.text();
    assert.equal(response.status, 400, error);
    assert.equal(error.includes(secret), false);
    assert.deepEqual(await f.api(f.route, undefined, "GET"), before);
    assert.deepEqual(await diskSnapshot(f.root), disk);
    assert.equal(f.seen.length, 0);
  }
});

test("static cURL/OpenAPI exports materialize effective media and bytes without persisting generated headers", async (t) => {
  const f = await fixture(t);
  const cases = mediaCases.slice(0, 4);
  const project = await f.api(f.route + "/import", {
    document: collection(
      cases.map((entry, index) => rawItem(f.url + "/export/" + index, entry)),
    ),
  });
  const before = await f.api(f.route, undefined, "GET");
  const openapi = await f.api(
    f.route + "/export?format=openapi",
    undefined,
    "GET",
  );
  const fromOpenAPI = importDocument(openapi);
  for (const [index, original] of project.requests.entries()) {
    const entry = cases[index];
    const { curl } = await f.api(f.route + "/curl", {
      request: original,
      environmentId: "selected",
    });
    const importedCurl = importCurl(curl);
    const importedOpenAPI = fromOpenAPI.find(
      (request) => new URL(request.url).pathname === "/export/" + index,
    );
    assert.ok(importedOpenAPI);
    for (const request of [importedCurl, importedOpenAPI]) {
      assert.equal(request.body, entry.body);
      assert.equal(
        Object.hasOwn(request, "postmanRawBody"),
        false,
        "generic HTTP exports carry headers, not source provenance",
      );
      assertEcho(
        await f.api(f.route + "/execute", {
          request,
          environmentId: "selected",
        }),
        entry.body,
        entry.media,
      );
    }
  }
  const saved = await f.api(f.route, undefined, "GET");
  assert.deepEqual(saved.requests, before.requests);
  assertGuards(saved);
  assert.equal(f.seen.length, cases.length * 2);
});

test("before-script-dependent raw media exports reject rather than claiming equivalent static requests", async (t) => {
  const f = await fixture(t);
  const project = await f.api(f.route + "/import", {
    document: collection([
      rawItem(f.url + "/dynamic-export", {
        script:
          'pm.request.body.update({mode:"raw",raw:"<h1>later</h1>",options:{raw:{language:"html"}}});',
      }),
    ]),
  });
  const before = await f.api(f.route, undefined, "GET");
  const disk = await diskSnapshot(f.root);
  for (const [route, data, method] of [
    [
      f.route + "/curl",
      { request: project.requests[0], environmentId: "selected" },
      "POST",
    ],
    [f.route + "/export?format=openapi", undefined, "GET"],
  ]) {
    const response = await f.response(route, data, method);
    const error = await response.text();
    assert.equal(response.status, 400, error);
    assert.match(error, /脚本|script|Postman/);
  }
  assert.deepEqual(await f.api(f.route, undefined, "GET"), before);
  assert.deepEqual(await diskSnapshot(f.root), disk);
  assert.equal(
    f.seen.length,
    0,
    "export must not run a script to guess its outgoing media",
  );
  const backup = await f.api(f.route + "/export", undefined, "GET");
  assert.deepEqual(
    backup.requests,
    before.requests,
    "project backup remains a lossless definition export",
  );
});

test("cURL preserves empty raw and explicit-empty media while OpenAPI refuses their ambiguous representation", async (t) => {
  const f = await fixture(t);
  const cases = [
    { body: "", media: null, headers: [] },
    {
      body: "<empty-header/>",
      media: "",
      headers: [{ key: "Content-Type", value: "" }],
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const project = await f.api(f.route + "/import", {
      document: collection([rawItem(f.url + "/empty-export/" + index, entry)]),
    });
    const request = project.requests.at(-1);
    project.requests = [request];
    await f.api(f.route, project, "PUT");
    const { curl } = await f.api(f.route + "/curl", {
      request,
      environmentId: "selected",
    });
    const imported = importCurl(curl);
    assertEcho(
      await f.api(f.route + "/execute", {
        request: imported,
        environmentId: "selected",
      }),
      entry.body,
      entry.media,
    );
    const response = await f.response(
      f.route + "/export?format=openapi",
      undefined,
      "GET",
    );
    const error = await response.text();
    assert.equal(response.status, 400, error);
    assert.match(error, /OpenAPI|空|raw/);
  }
  assert.equal(
    f.seen.length,
    cases.length,
    "export refusal never sends requests",
  );
});
