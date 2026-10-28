import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  importDocument,
  importIntoProject,
  exportOpenAPI,
  interpolate,
  normalizeRequest,
  toCurl,
} from "../src/core.mjs";
import { openAPIServerURL } from "../src/openapi-server.mjs";
import { syncMCPOpenAPI } from "../src/mcp-openapi-sync.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";

const operation = (extra = {}) => ({
  responses: { 200: { description: "OK" } },
  ...extra,
});
const server = (url, defaults = {}) => ({
  url,
  variables: Object.fromEntries(
    Object.entries(defaults).map(([name, value]) => [name, { default: value }]),
  ),
});
const document = (selected, extra = {}) => ({
  openapi: "3.0.3",
  servers: [selected],
  paths: { "/items": { get: operation() } },
  ...extra,
});

test("server defaults materialize once without touching source, scopes or same-named path parameters", () => {
  const source = document(
    server("{scheme}://{host}:{port}/{version}/{version}", {
      scheme: "https",
      host: "example.test",
      port: "8443",
      version: "v1",
    }),
    {
      paths: {
        "/items/{version}": {
          get: operation({
            parameters: [
              {
                in: "path",
                name: "version",
                required: true,
                schema: { type: "string" },
                example: "path-value",
              },
            ],
          }),
        },
      },
    },
  );
  const before = structuredClone(source);
  const project = {
    requests: [],
    environments: [{ id: "env", variables: { version: "environment" } }],
    globalVariables: { version: "global" },
    settings: {},
  };
  const scopes = structuredClone([
    project.environments,
    project.globalVariables,
    project.settings,
  ]);
  const [request] = importIntoProject(project, source);
  assert.equal(request.url, "https://example.test:8443/v1/v1/items/{version}");
  assert.match(toCurl(request), /\/v1\/v1\/items\/path-value'/);
  assert.doesNotMatch(toCurl(request), /%7Bversion%7D/);
  assert.deepEqual(source, before);
  assert.deepEqual(
    [project.environments, project.globalVariables, project.settings],
    scopes,
  );
});

test("operation then path then root selects only the first server at that level", () => {
  const source = document(server("https://root.test/{v}", { v: "root" }), {
    paths: {
      "/root": { get: operation() },
      "/path": {
        servers: [server("https://path.test/{v}", { v: "path" })],
        get: operation(),
        post: operation({
          servers: [
            server("https://op.test/{v}", { v: "operation" }),
            server("https://ignored.test/{missing}"),
          ],
        }),
      },
      "/empty": { servers: [], get: operation({ servers: [] }) },
    },
  });
  assert.deepEqual(
    importDocument(source).map((r) => r.url),
    [
      "https://root.test/root/root",
      "https://path.test/path/path",
      "https://op.test/operation/path",
      "https://root.test/root/empty",
    ],
  );
  source.servers = [server("https://invalid.test/{missing}")];
  delete source.paths["/root"];
  delete source.paths["/empty"];
  assert.equal(importDocument(source).length, 2);
  assert.equal(
    importDocument({
      openapi: "3.0.3",
      paths: { "/ping": { get: operation() } },
    })[0].url,
    "{{baseUrl}}/ping",
  );
  assert.equal(
    importDocument({
      swagger: "2.0",
      host: "example.test",
      basePath: "/v2",
      schemes: ["http"],
      paths: { "/ping": { get: operation() } },
    })[0].url,
    "http://example.test/v2/ping",
  );
});

test("empty defaults, replacement metacharacters and encoded URL bytes stay literal", () => {
  for (const value of [
    "",
    "$&",
    "$`",
    "$'",
    "%2F",
    "%20",
    "%25",
    "a/b:c",
    "中文",
    "one two",
  ]) {
    const source = document(
      server("https://example.test/prefix{v}", { v: value }),
    );
    const request = importDocument(source)[0];
    assert.equal(request.url, `https://example.test/prefix${value}/items`);
    const exported = exportOpenAPI({ name: "Literal", requests: [request] });
    const restored = importDocument(exported)[0];
    assert.equal(new URL(restored.url).href, new URL(request.url).href);
    assert.equal(toCurl(restored), toCurl(request));
  }
});

test("literal default metacharacters, empty strings, Unicode and spaces preserve their real wire target on roundtrip", async (t) => {
  const received = [];
  const target = http.createServer((req, res) => {
    received.push(req.url);
    res.end("ok");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    target.closeAllConnections();
    await new Promise((resolve) => target.close(resolve));
  });
  const base = `http://127.0.0.1:${target.address().port}`;
  for (const value of ["", "$&", "$`", "$'", "%2F", "%20", "中文", "one two"]) {
    const request = importDocument(
      document(server(base + "/prefix{v}", { v: value })),
    )[0];
    const restored = importDocument(
      exportOpenAPI({ name: "Wire", requests: [request] }),
    )[0];
    assert.equal((await executeRequest(request)).status, 200);
    assert.equal((await executeRequest(restored)).status, 200);
    assert.equal(received.at(-1), received.at(-2));
    assert.equal(received.at(-1), new URL(request.url).pathname);
  }
});

test("server definitions and defaults are own properties, including ordinary prototype-like names", () => {
  const defaults = JSON.parse(
    '{"__proto__":"one","constructor":"two","prototype":"three","toString":"four"}',
  );
  const source = document(
    server(
      "https://example.test/{__proto__}/{constructor}/{prototype}/{toString}",
      defaults,
    ),
  );
  assert.equal(
    importDocument(JSON.stringify(source))[0].url,
    "https://example.test/one/two/three/four/items",
  );
  assert.equal({}.default, undefined);
  assert.throws(
    () =>
      openAPIServerURL([
        { url: "https://example.test/{toString}", variables: {} },
      ]),
    /default/,
  );
  assert.throws(
    () =>
      openAPIServerURL([
        {
          url: "https://example.test/{v}",
          variables: Object.create({ v: { default: "inherited" } }),
        },
      ]),
    /default/,
  );
  assert.throws(
    () =>
      openAPIServerURL([
        {
          url: "https://example.test/{v}",
          variables: { v: Object.create({ default: "inherited" }) },
        },
      ]),
    /default/,
  );
});

test("legacy base placeholders and mixed server defaults retain the same executable target through export", () => {
  for (const base of ["{{baseURL}}", "{{base?opaque}}", "{{ baseURL }}"]) {
    for (const level of ["root", "operation"]) {
      const selected = server(`${base}/{version}`, { version: "v1" });
      const source = document(selected);
      if (level === "operation") {
        delete source.servers;
        source.paths["/items"].get.servers = [selected];
      }
      const request = importDocument(source)[0];
      assert.equal(request.url, `${base}/v1/items`);
      const exported = exportOpenAPI({ name: "Legacy", requests: [request] });
      assert.deepEqual(exported.paths["/v1/items"].get.servers, [
        { url: base },
      ]);
      const restored = importDocument(exported)[0];
      assert.equal(restored.url, request.url);
      assert.equal(
        interpolate(restored.url, {
          baseURL: "https://example.test",
          "base?opaque": "https://example.test",
        }),
        "https://example.test/v1/items",
      );
      assert.equal(
        importDocument(
          exportOpenAPI({ name: "Again", requests: [restored] }),
        )[0].url,
        request.url,
      );
    }
  }
});

test("non-prefix legacy workbench templates still import, but unsupported export fails instead of losing the target", () => {
  for (const selected of [
    server("https://{{host}}/api"),
    server("https://{{host}}/{version}", { version: "v1" }),
    server("{{baseURL}}/{{other}}"),
  ]) {
    const request = importDocument(document(selected))[0];
    assert.equal(
      request.url,
      selected.url.replace("{version}", "v1") + "/items",
    );
    assert.throws(
      () => exportOpenAPI({ name: "Unresolved", requests: [request] }),
      /OpenAPI.*base/,
    );
  }
  const relative = document(server("/existing"), {
    paths: { "/items": { get: operation({ tags: ["service-folder"] }) } },
  });
  assert.equal(importDocument(relative)[0].url, "/existing/items");
  const request = importDocument(document(server("https://{{host}}/api")))[0];
  assert.match(
    toCurl(interpolate(request, { host: "example.test" })),
    /https:\/\/example.test\/api\/items'/,
  );
});

test("invalid or ambiguous server substitutions fail closed before any project mutation", () => {
  const invalid = [
    server("https://example.test/{missing}"),
    { url: "https://example.test/{v}", variables: { v: {} } },
    ...[0, false, null, [], {}, undefined].map((v) =>
      server("https://example.test/{v}", { v }),
    ),
    ...["{other}", "{{runtime}}", "%7Bid%7D", "%7bid%7d"].map((v) =>
      server("https://example.test/{v}", { v, other: "must-not-recurse" }),
    ),
    ...["{}", "{v", "v}", "{{{v}}}", "{{ }}"].map((v) =>
      server(`https://example.test/${v}`, { v: "one" }),
    ),
    server("{{v}}/api", { v: "https://example.test" }),
    server("https://example.test/{v}", { v: "bad\npath" }),
    server("https://example.test/{v}", { v: "bad\\path" }),
    server("https://example.test\\@other.test"),
    server("https://example.test/%7Bid%7D"),
    server("https://example.test/{v}", { v: "?query=one" }),
    server("https://example.test/{v}", { v: "#fragment" }),
    server("https://example.test/{v}", { v: "%zz" }),
    server("https://example.test:{port}", { port: "not-a-port" }),
    { url: "https://example.test/{v}", variables: [] },
    { url: "https://example.test/{v}", variables: null },
    { url: 42 },
    { url: "" },
  ];
  for (const selected of invalid) {
    const source = document(
      server("https://example.test/{v}", { v: "valid" }),
      {
        components: { schemas: { New: { type: "string" } } },
        paths: {
          "/valid-first": { get: operation() },
          "/invalid-second": { get: operation({ servers: [selected] }) },
        },
      },
    );
    const project = {
      requests: [normalizeRequest({ url: "https://existing.test/items" })],
      environments: [{ id: "env", variables: { v: "must-not-fill-default" } }],
      globalVariables: { v: "also-not-a-default" },
      settings: {},
      openapiComponents: { schemas: { Existing: { type: "number" } } },
    };
    const before = structuredClone(project);
    for (const options of [{}, { sync: true }]) {
      assert.throws(
        () => importIntoProject(project, source, options),
        /OpenAPI server/,
        JSON.stringify(selected),
      );
      assert.deepEqual(project, before);
    }
    assert.throws(
      () => syncMCPOpenAPI(project, { document: source }),
      /OpenAPI server/,
    );
    assert.deepEqual(project, before);
  }
});

test("server substitution bounds reject oversized output, definitions and malformed selected lists", () => {
  assert.throws(
    () =>
      openAPIServerURL([
        server("https://example.test/{v}{v}", { v: "a".repeat(33000) }),
      ]),
    /64KiB/,
  );
  assert.throws(
    () =>
      openAPIServerURL([
        server("https://example.test/" + "{v}".repeat(1001), { v: "" }),
      ]),
    /1000/,
  );
  assert.throws(
    () =>
      openAPIServerURL([
        server(
          "https://example.test",
          Object.fromEntries(
            Array.from({ length: 1001 }, (_, n) => [String(n), "value"]),
          ),
        ),
      ]),
    /1000/,
  );
  for (const invalid of [null, {}, "https://example.test"])
    assert.throws(() => openAPIServerURL(invalid), /servers/);
});

test("HTTP import, execution, Store restart, OpenAPI reimport and backup restore keep the actual target", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "openapi-servers-"));
  const received = [];
  const target = http.createServer((req, res) => {
    received.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const close = async () => {
    if (!app.server.listening) return;
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await close();
    target.closeAllConnections();
    await new Promise((resolve) => target.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (url, method = "GET", body, expected = 200) => {
    const response = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  const created = await call(
    "/api/projects",
    "POST",
    { name: "Server defaults" },
    201,
  );
  const base = `/api/projects/${created.id}`;
  // YAML exercises the actual import parser, not a hand-materialized request.
  const yaml = `openapi: 3.0.3\nservers:\n  - url: 'http://{host}:{port}/{version}/{encoded}'\n    variables:\n      host:\n        default: 127.0.0.1\n      port:\n        default: '${target.address().port}'\n      version:\n        default: v1\n      encoded:\n        default: 'one%2Ftwo'\npaths:\n  /items/{id}:\n    get:\n      parameters:\n        - in: path\n          name: id\n          required: true\n          schema:\n            type: string\n          example: '42'\n      responses:\n        '200':\n          description: OK\n`;
  const imported = await call(base + "/import", "POST", { document: yaml });
  assert.deepEqual(imported.environments, created.environments);
  const expectedURL = `http://127.0.0.1:${target.address().port}/v1/one%2Ftwo/items/{id}`;
  assert.equal(imported.requests[0].url, expectedURL);
  const execute = async (projectBase, request) => {
    const result = await call(projectBase + "/execute", "POST", { request });
    assert.equal(result.status, 200);
    assert.equal(result.outcome, "passed");
    assert.equal(JSON.parse(result.body).path, "/v1/one%2Ftwo/items/42");
    assert.doesNotMatch(toCurl(request), /%7B(?:version|host|port|encoded)%7D/);
  };
  await execute(base, imported.requests[0]);
  await close();
  const disk = await new Store(root).get(created.id);
  assert.equal(disk.requests[0].url, expectedURL);
  app = await createApp({ root, port: 0 });
  const reopened = await call(base);
  assert.equal(reopened.requests[0].id, imported.requests[0].id);
  await execute(base, reopened.requests[0]);
  const exported = await call(base + "/export?format=openapi");
  assert.deepEqual(exported.paths["/v1/one%2Ftwo/items/{id}"].get.servers, [
    { url: `http://127.0.0.1:${target.address().port}` },
  ]);
  const second = await call("/api/projects", "POST", { name: "Reimport" }, 201);
  const secondBase = `/api/projects/${second.id}`;
  const reimported = await call(secondBase + "/import", "POST", {
    document: exported,
  });
  assert.equal(reimported.requests[0].url, expectedURL);
  await execute(secondBase, reimported.requests[0]);
  const backup = await call(secondBase + "/export?format=backup");
  const restored = await call(
    "/api/restore",
    "POST",
    { document: backup },
    201,
  );
  assert.notEqual(restored.id, second.id);
  assert.equal(restored.requests[0].url, expectedURL);
  await execute(`/api/projects/${restored.id}`, restored.requests[0]);
  // Relative servers still use an explicitly configured existing folder service.
  const relativeProject = await call(
    "/api/projects",
    "POST",
    { name: "Relative" },
    201,
  );
  relativeProject.servers = [{ id: "service", name: "Loopback" }];
  relativeProject.settings.folderServices = { API: "service" };
  relativeProject.environments[0].serverUrls = {
    service: `http://127.0.0.1:${target.address().port}`,
  };
  const relativeBase = `/api/projects/${relativeProject.id}`;
  await call(relativeBase, "PUT", relativeProject);
  for (const selected of [
    server("/v1/one%2Ftwo"),
    server("/{version}/{encoded}", { version: "v1", encoded: "one%2Ftwo" }),
  ]) {
    const relativeSource = document(selected, {
      paths: {
        "/items/{id}": {
          get: operation({
            tags: ["API"],
            parameters: [
              {
                in: "path",
                name: "id",
                required: true,
                schema: { type: "string" },
                example: "42",
              },
            ],
          }),
        },
      },
    });
    const saved = await call(relativeBase + "/import", "POST", {
      document: relativeSource,
    });
    const request = saved.requests.at(-1);
    assert.equal(request.url, "/v1/one%2Ftwo/items/{id}");
    const result = await call(relativeBase + "/execute", "POST", { request });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).path, "/v1/one%2Ftwo/items/42");
  }
  assert.deepEqual(received, Array(6).fill("/v1/one%2Ftwo/items/42"));
  const before = await call(base);
  const bad = document(
    server("http://127.0.0.1:{port}", { port: String(target.address().port) }),
    {
      paths: {
        "/valid-first": { get: operation() },
        "/invalid-second": {
          get: operation({ servers: [server("http://127.0.0.1/{missing}")] }),
        },
      },
    },
  );
  const rejected = await call(base + "/import", "POST", { document: bad }, 400);
  assert.match(rejected.error, /default/);
  assert.deepEqual(await call(base), before);
  assert.deepEqual(await new Store(root).get(created.id), before);
  assert.equal(received.length, 6);
});
