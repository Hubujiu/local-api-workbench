// Root-composition contracts for CI. Authoring checks must not start the app or VM.
// Raw XML/HTML is opaque fixture text, never parsed or evaluated as a document.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importCurl, importDocument } from "../src/core.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
import { normalizeNativeTaskRequest } from "../src/script-database-tasks.mjs";

const marker = (language = "xml") => ({ version: 1, language });
const originalBody = "<original>中文 + & =</original>\r\n";
function rawItem(url, { body = originalBody, script } = {}) {
  return {
    name: url.split("/").at(-1),
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
      method: "POST",
      url,
      header: [],
      body: { mode: "raw", raw: body, options: { raw: { language: "xml" } } },
    },
  };
}
const collection = (items) => ({
  info: {
    name: "Root raw media composition",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  item: items,
});
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "postman-raw-root-"));
  const seen = [],
    databaseCalls = [];
  // Count real owner database dispatches without replacing their implementation.
  const query = DatabaseSessions.prototype.query;
  t.mock.method(DatabaseSessions.prototype, "query", function (...args) {
    databaseCalls.push(args[0]);
    return Reflect.apply(query, this, args);
  });
  const peer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks),
      contentTypes = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2)
      if (request.rawHeaders[i].toLowerCase() === "content-type")
        contentTypes.push(request.rawHeaders[i + 1]);
    const entry = {
      method: request.method,
      url: request.url,
      body: bytes.toString("utf8"),
      bodyBase64: bytes.toString("base64"),
      contentTypes,
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
      signal: AbortSignal.timeout(10000),
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  }
  async function api(route, data, method = "POST") {
    const res = await response(route, data, method),
      body = await res.text();
    assert.equal(res.ok, true, body);
    return JSON.parse(body);
  }
  const project = await api("/projects", { name: "Root raw media" });
  project.environments = [
    { id: "selected", name: "Selected", variables: { guard: "unchanged" } },
  ];
  project.globalVariables = { globalGuard: "unchanged" };
  const route = "/projects/" + project.id;
  await api(route, project, "PUT");
  return {
    root,
    seen,
    databaseCalls,
    response,
    api,
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
function assertEcho(response, body, media) {
  assert.equal(response.status, 200, response.error);
  const echo = JSON.parse(response.body);
  assert.equal(echo.method, "POST");
  assert.equal(echo.body, body);
  assert.equal(echo.bodyBase64, Buffer.from(body).toString("base64"));
  assert.deepEqual(echo.contentTypes, media === null ? [] : [media]);
}
async function freeze(f, steps, id) {
  const receipt = await f.api(f.route + "/plans", {
    id,
    name: id,
    environmentId: "selected",
    steps,
  });
  const saved = await f.api(f.route, undefined, "GET");
  const definition = saved.plans.find((plan) => plan.id === receipt.id);
  assert.ok(definition);
  assert.equal(Object.hasOwn(definition, "failurePolicy"), false);
  return definition;
}
function assertNoScopeChanges(project, environment = { guard: "unchanged" }) {
  assert.deepEqual(project.environments[0].variables, environment);
  assert.deepEqual(project.globalVariables, { globalGuard: "unchanged" });
}
async function assertExportsRejected(
  f,
  request,
  diagnostic = /Postman|脚本|script|前置/,
) {
  const before = await f.api(f.route, undefined, "GET"),
    disk = await diskSnapshot(f.root);
  const count = f.seen.length,
    queries = f.databaseCalls.length;
  for (const [route, data, method] of [
    [f.route + "/curl", { request, environmentId: "selected" }, "POST"],
    [f.route + "/export?format=openapi", undefined, "GET"],
  ]) {
    const response = await f.response(route, data, method),
      error = await response.text();
    assert.equal(response.status, 400, error);
    assert.match(error, diagnostic);
  }
  assert.deepEqual(await f.api(f.route, undefined, "GET"), before);
  assert.deepEqual(
    await diskSnapshot(f.root),
    disk,
    "refused exports leave every saved byte unchanged",
  );
  assert.equal(
    f.seen.length,
    count,
    "export must not execute any main or script HTTP request",
  );
  assert.equal(
    f.databaseCalls.length,
    queries,
    "export must not enter database execution",
  );
  const backup = await f.api(f.route + "/export", undefined, "GET");
  assert.deepEqual(backup.requests, before.requests);
  assert.deepEqual(backup.settings, before.settings);
}
async function assertStaticXML(f, request) {
  const before = await f.api(f.route, undefined, "GET"),
    disk = await diskSnapshot(f.root);
  const { curl } = await f.api(f.route + "/curl", {
    request,
    environmentId: "selected",
  });
  const openapi = await f.api(
    f.route + "/export?format=openapi",
    undefined,
    "GET",
  );
  for (const restored of [importCurl(curl), ...importDocument(openapi)]) {
    assert.equal(restored.body, originalBody);
    assert.deepEqual(
      restored.headers
        .filter(
          (h) => h.enabled !== false && h.key.toLowerCase() === "content-type",
        )
        .map((h) => h.value),
      ["application/xml"],
    );
  }
  assert.deepEqual(await f.api(f.route, undefined, "GET"), before);
  assert.deepEqual(await diskSnapshot(f.root), disk);
  assert.equal(f.seen.length, 0);
  assert.equal(f.databaseCalls.length, 0);
}

test(
  "root XML-to-form-to-raw transitions clear the old language through owner execution, frozen live edits and backup reopen",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const cases = [
      {
        name: "string",
        body: "string 中文 + & =\r\n",
        update: 'pm.request.body.update("string 中文 + & =\\r\\n");',
      },
      {
        name: "options-less",
        body: "options-less 中文 + & =\r\n",
        update:
          'pm.request.body.update({mode:"raw",raw:"options-less 中文 + & =\\r\\n"});',
      },
    ];
    const project = await f.api(f.route + "/import", {
      document: collection(
        cases.map((entry) =>
          rawItem(f.url + "/transition/" + entry.name, {
            script: [
              'pm.request.body.update({mode:"urlencoded",urlencoded:[{key:"discarded",value:"form 中文"}]});',
              'pm.test("intermediate is form",()=>pm.expect(pm.request.body.mode).to.equal("urlencoded"));',
              entry.update,
              'pm.test("default header is not saved",()=>pm.expect(pm.request.headers.has("Content-Type")).to.equal(false));',
            ].join("\n"),
          }),
        ),
      ),
    });
    const originals = structuredClone(project.requests);
    const plan = await freeze(
      f,
      originals.map((request, index) => ({
        id: "transition-" + index,
        request,
      })),
      "transition-plan",
    );
    assert.equal(f.seen.length, 0);
    for (const [index, request] of originals.entries())
      assertEcho(
        await f.api(f.route + "/execute", {
          request,
          environmentId: "selected",
        }),
        cases[index].body,
        "text/plain",
      );
    const live = await f.api(f.route, undefined, "GET");
    assert.deepEqual(live.requests, originals);
    for (const request of live.requests) {
      request.body = "live body";
      request.url += "/live-must-not-run";
      request.postmanRawBody = marker("html");
      request.beforeScript = 'throw Error("live script must not run");';
    }
    await f.api(f.route, live, "PUT");
    await f.restart();
    assert.equal(f.seen.length, 2);
    const run = await f.api(f.route + "/run", {
      planId: plan.id,
      environmentId: "selected",
    });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(run.recordSaved, true);
    assert.deepEqual(run.snapshot, plan);
    for (const [index, result] of run.results.entries()) {
      assertEcho(result.response, cases[index].body, "text/plain");
      assert.equal(result.request.bodyType, "raw");
      assert.deepEqual(result.request.postmanRawBody, marker("default"));
      assert.deepEqual(result.request.headers, []);
      assert.deepEqual(result.subrequests, []);
      assert.deepEqual(result.databaseQueries ?? [], []);
      assert.deepEqual(plan.steps[index].request.postmanRawBody, marker());
      assert.equal(plan.steps[index].request.body, originalBody);
    }
    assert.equal(f.seen.length, 4);
    const beforeRestore = await f.api(f.route, undefined, "GET");
    assertNoScopeChanges(beforeRestore);
    const backup = await f.api(f.route + "/export", undefined, "GET");
    const restored = await f.api("/restore", { document: backup });
    assert.notEqual(restored.id, project.id);
    await f.restart();
    const reopened = await new Store(f.root).get(restored.id);
    assert.deepEqual(reopened.plans[0], plan);
    assert.deepEqual(
      reopened.runs.find((row) => row.id === run.id).results,
      run.results,
    );
    assert.deepEqual(
      reopened.runs.find((row) => row.id === run.id).snapshot,
      plan,
    );
    assert.equal(
      f.seen.length,
      4,
      "restore and disk reopen never replay requests",
    );
    const replay = await f.api("/projects/" + restored.id + "/run", {
      planId: plan.id,
      environmentId: "selected",
    });
    assert.equal(replay.status, "passed", JSON.stringify(replay));
    assert.deepEqual(replay.snapshot, plan);
    for (const [index, result] of replay.results.entries()) {
      assertEcho(result.response, cases[index].body, "text/plain");
      assert.deepEqual(result.request.postmanRawBody, marker("default"));
    }
    assert.equal(f.seen.length, 6);
    assert.equal(
      f.seen.some((row) => row.url.includes("live-must-not-run")),
      false,
    );
    assert.deepEqual(await f.api(f.route, undefined, "GET"), beforeRestore);
    assertNoScopeChanges(await new Store(f.root).get(restored.id));
    assert.equal(f.databaseCalls.length, 0);
  },
);

test(
  "root IF and repeat resolve marked raw emptiness after environment, extraction and before-script variables without freezing generated media",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    let project = await f.api(f.route + "/import", {
      document: collection([
        rawItem(f.url + "/late/runtime-empty", { body: "{{payload}}" }),
        rawItem(f.url + "/late/script-empty", {
          body: "{{payload}}",
          script:
            'pm.test("persistent seed is unchanged",()=>pm.expect(pm.environment.get("payload")).to.equal("persistent payload"));pm.variables.set("payload", "");',
        }),
        rawItem(f.url + "/late/whitespace", { body: "{{whitespace}}" }),
        rawItem(f.url + "/late/nonempty", { body: "{{nonempty}}" }),
      ]),
    });
    project.environments[0].variables = {
      guard: "unchanged",
      payload: "",
      whitespace: " \t\r\n",
      nonempty: "<late>中文</late>\r\n",
    };
    await f.api(f.route, project, "PUT");
    assertEcho(
      await f.api(f.route + "/execute", {
        request: project.requests[0],
        environmentId: "selected",
      }),
      "",
      null,
    );
    project = await f.api(f.route, undefined, "GET");
    project.environments[0].variables.payload = "persistent payload";
    await f.api(f.route, project, "PUT");
    assertEcho(
      await f.api(f.route + "/execute", {
        request: project.requests[1],
        environmentId: "selected",
      }),
      "",
      null,
    );
    const environment = structuredClone(project.environments[0].variables);
    const originals = structuredClone(project.requests);
    const plan = await freeze(
      f,
      [
        {
          id: "seed",
          request: {
            name: "Runtime empty seed",
            method: "POST",
            url: f.url + "/late/seed",
            bodyType: "raw",
            body: "",
            extract: [
              { name: "payload", source: "json", path: "$.body" },
              { name: "seedMethod", source: "json", path: "$.method" },
            ],
          },
        },
        {
          id: "empty-gate",
          type: "if",
          condition: {
            left: { scope: "runtime", name: "seedMethod" },
            op: "eq",
            right: { literal: "POST" },
          },
          steps: [
            {
              id: "twice",
              type: "repeat",
              count: 2,
              steps: originals.map((request, index) => ({
                id: "raw-" + index,
                request,
              })),
            },
          ],
        },
      ],
      "late-empty-plan",
    );
    const run = await f.api(f.route + "/run", {
      planId: plan.id,
      environmentId: "selected",
    });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(run.recordSaved, true);
    assert.equal(run.stopReason, undefined);
    assert.equal(run.failureStop, undefined);
    assert.deepEqual(run.snapshot, plan);
    assert.equal(run.results.length, 9);
    assert.equal(run.conditionResults.length, 1);
    assert.equal(run.conditionResults[0].groupId, "empty-gate");
    assert.equal(run.conditionResults[0].matched, true);
    assert.equal(run.variables.payload, "");
    assert.equal(run.variables.seedMethod, "POST");
    const expected = [
      ["", null],
      ["", null],
      [environment.whitespace, "application/xml"],
      [environment.nonempty, "application/xml"],
    ];
    for (const [index, result] of run.results.slice(1).entries()) {
      assertEcho(result.response, ...expected[index % 4]);
      assert.equal(result.stepId, "raw-" + (index % 4));
      assert.equal(result.repeat.iteration, Math.floor(index / 4));
      assert.deepEqual(result.request.postmanRawBody, marker());
      assert.deepEqual(result.request.headers, []);
      assert.deepEqual(result.subrequests, []);
    }
    assert.equal(f.seen.length, 11);
    assert.deepEqual(
      f.seen.map((row) => row.url),
      [
        "/late/runtime-empty",
        "/late/script-empty",
        "/late/seed",
        ...Array.from({ length: 2 }, () => [
          "/late/runtime-empty",
          "/late/script-empty",
          "/late/whitespace",
          "/late/nonempty",
        ]).flat(),
      ],
    );
    const saved = await f.api(f.route, undefined, "GET");
    assertNoScopeChanges(saved, environment);
    assert.deepEqual(saved.requests, originals);
    assert.deepEqual(saved.plans[0], plan);
    for (const step of plan.steps[1].steps[0].steps) {
      assert.deepEqual(step.request.postmanRawBody, marker());
      assert.match(step.request.body, /^\{\{.+\}\}$/);
      assert.deepEqual(step.request.headers, []);
    }
    await f.restart();
    const reopened = await new Store(f.root).get(project.id);
    assert.deepEqual(reopened.plans[0], plan);
    assert.deepEqual(
      reopened.runs.find((row) => row.id === run.id).results,
      run.results,
    );
    assert.deepEqual(
      reopened.runs.find((row) => row.id === run.id).conditionResults,
      run.conditionResults,
    );
    assertNoScopeChanges(reopened, environment);
    assert.equal(f.seen.length, 11);
    assert.equal(f.databaseCalls.length, 0);
  },
);

test(
  "root raw static exporters respect actual project, exact-folder and recursive-folder before scripts and frozen opt-outs",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const imported = await f.api(f.route + "/import", {
      document: collection([rawItem(f.url + "/shared")]),
    });
    const base = { ...imported.requests[0], folder: "Orders/Child" };
    const code = [
      'pm.environment.set("guard", "must-not-change");',
      'pm.globals.set("globalGuard", "must-not-change");',
      'pm.request.body.update({mode:"raw",raw:"<h1>shared</h1>",options:{raw:{language:"html"}}});',
      "pm.sendRequest({url:" +
        JSON.stringify(f.url + "/shared-side-effect") +
        ',method:"POST"},()=>{});',
    ].join("\n");
    const frozenEmpty = freezeServiceBinding(imported, base);
    assert.equal(frozenEmpty.sharedScriptsSnapshot, true);
    assert.deepEqual(frozenEmpty.sharedBeforeScripts, []);
    for (const [name, settings] of [
      ["project", { globalScripts: { beforeScript: code } }],
      ["exact", { folderScripts: { "Orders/Child": { beforeScript: code } } }],
      [
        "recursive",
        {
          recursiveFolderScopes: true,
          folderScripts: { Orders: { beforeScript: code } },
        },
      ],
    ]) {
      let current = await f.api(f.route, undefined, "GET");
      current.settings = { ...imported.settings, ...settings };
      current.requests = [structuredClone(base)];
      current = await f.api(f.route, current, "PUT");
      assert.equal(current.requests[0].sharedScriptsSnapshot, false, name);
      await assertExportsRejected(f, current.requests[0]);
      const frozenActive = freezeServiceBinding(current, current.requests[0]);
      assert.equal(frozenActive.sharedBeforeScripts.length, 1, name);
      for (const request of [
        { ...base, inheritSharedScripts: false },
        frozenEmpty,
      ]) {
        current.requests = [request];
        current = await f.api(f.route, current, "PUT");
        await assertStaticXML(f, current.requests[0]);
      }
      // A frozen active script remains authoritative after live settings are cleared.
      current.settings = structuredClone(imported.settings);
      current.requests = [frozenActive];
      current = await f.api(f.route, current, "PUT");
      await assertExportsRejected(f, current.requests[0]);
      assertNoScopeChanges(await new Store(f.root).get(current.id));
    }
    for (const settings of [
      { globalScripts: { enabled: false, beforeScript: code } },
      { folderScripts: { Orders: { beforeScript: code } } },
      {
        recursiveFolderScopes: true,
        folderScripts: { Unrelated: { beforeScript: code } },
      },
    ]) {
      const current = await f.api(f.route, undefined, "GET");
      current.settings = { ...imported.settings, ...settings };
      current.requests = [structuredClone(base)];
      const saved = await f.api(f.route, current, "PUT");
      await assertStaticXML(f, saved.requests[0]);
    }
    await f.restart();
    assertNoScopeChanges(await new Store(f.root).get(imported.id));
    assert.equal(f.seen.length, 0);
    assert.equal(f.databaseCalls.length, 0);
  },
);

test(
  "root native before tasks cannot silently export marked XML as static while no-active-before and unmarked definitions retain compatibility",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const imported = await f.api(f.route + "/import", {
      document: collection([rawItem(f.url + "/native")]),
    });
    const task = {
      id: "change-media",
      type: "customScript",
      enabled: 1,
      data: 'pm.environment.set("guard","must-not-change");pm.request.body.update({mode:"raw",raw:"<h1>native</h1>",options:{raw:{language:"html"}}});',
    };
    const native = (before, after = []) => {
      const request = {
        ...imported.requests[0],
        inheritSharedScripts: false,
        nativeTasks: { version: 1, before, after },
      };
      request.nativeTasks = normalizeNativeTaskRequest(request);
      return request;
    };
    let current = await f.api(f.route, undefined, "GET");
    current.requests = [native([task])];
    current = await f.api(f.route, current, "PUT");
    assert.deepEqual(current.requests[0].nativeTasks.before, [task]);
    await assertExportsRejected(f, current.requests[0]);
    for (const request of [
      native([]),
      native([{ ...task, enabled: 0 }]),
      native([{ ...task, enabled: -1 }]),
      native([], [task]),
    ]) {
      current.requests = [request];
      current = await f.api(f.route, current, "PUT");
      await assertStaticXML(f, current.requests[0]);
    }
    const legacy = native([]);
    delete legacy.postmanRawBody;
    current.requests = [legacy];
    current = await f.api(f.route, current, "PUT");
    const baselineCurl = await f.api(f.route + "/curl", {
      request: current.requests[0],
      environmentId: "selected",
    });
    const baselineOpenAPI = await f.api(
      f.route + "/export?format=openapi",
      undefined,
      "GET",
    );
    current.requests[0].nativeTasks.before = [task];
    current = await f.api(f.route, current, "PUT");
    const before = structuredClone(current),
      disk = await diskSnapshot(f.root);
    assert.deepEqual(
      await f.api(f.route + "/curl", {
        request: current.requests[0],
        environmentId: "selected",
      }),
      baselineCurl,
    );
    assert.deepEqual(
      await f.api(f.route + "/export?format=openapi", undefined, "GET"),
      baselineOpenAPI,
    );
    assert.deepEqual(await f.api(f.route, undefined, "GET"), before);
    assert.deepEqual(await diskSnapshot(f.root), disk);
    await f.restart();
    const reopened = await new Store(f.root).get(imported.id);
    assert.deepEqual(reopened.requests, before.requests);
    assertNoScopeChanges(reopened);
    assert.equal(f.seen.length, 0);
    assert.equal(f.databaseCalls.length, 0);
  },
);

test(
  "root shared Content-Type templates refuse static raw export before an unrelated dynamic provider can execute",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    let project = await f.api(f.route + "/import", {
      document: collection([rawItem(f.url + "/shared-media-template")]),
    });
    project.environments[0].variables.mediaType = "text/html";
    project.settings.globalParameters = {
      headers: [{ key: "Content-Type", value: "{{mediaType}}", enabled: true }],
    };
    project.settings.functions = [
      {
        name: "mustNotEvaluate",
        kind: "transform",
        body: 'throw Error("RAW_MEDIA_PROVIDER_MUST_NOT_RUN");',
      },
    ];
    project.requests[0].query = [
      {
        key: "provider",
        value: "",
        enabled: true,
        dynamic: {
          source: "fixed",
          value: "fixture",
          functions: ["mustNotEvaluate"],
        },
      },
    ];
    project = await f.api(f.route, project, "PUT");
    await assertExportsRejected(f, project.requests[0], /Postman raw/);
    project.requests[0].query = [];
    project.requests[0].inheritGlobalParameters = false;
    project = await f.api(f.route, project, "PUT");
    await assertStaticXML(f, project.requests[0]);
    project.requests[0].inheritGlobalParameters = true;
    project.settings.globalParameters.headers[0].enabled = false;
    project = await f.api(f.route, project, "PUT");
    await assertStaticXML(f, project.requests[0]);
    const before = await f.api(f.route, undefined, "GET");
    await f.restart();
    const reopened = await new Store(f.root).get(project.id);
    assert.deepEqual(reopened.requests, before.requests);
    assert.deepEqual(reopened.settings, before.settings);
    assertNoScopeChanges(reopened, {
      guard: "unchanged",
      mediaType: "text/html",
    });
    assert.equal(f.seen.length, 0);
    assert.equal(f.databaseCalls.length, 0);
  },
);
