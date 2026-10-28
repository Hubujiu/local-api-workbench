import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { importIntoProject } from "../src/core.mjs";

const unrelatedSchemas = {
  ExistingModel: {
    type: "object",
    properties: { retained: { type: "boolean" } },
  },
};
const requirements = {
  inherited: [{ Basic: [], HeaderKey: [] }],
  choice: [{ Implicit: ["read"] }, { Password: ["write"], QueryKey: [] }],
  flows: [{ Application: ["read"], AccessCode: ["read", "write"] }],
  public: [],
  optional: [{}, { BasicAlias: [] }],
};
const basic = {
  type: "basic",
  description: "Documentation only; no credentials",
  "x-literal": {
    $ref: "https://example.invalid/not-a-reference",
    note: "保留",
  },
};
const schemes = {
  Basic: { ...basic, type: "http", scheme: "basic" },
  BasicAlias: { ...basic, type: "http", scheme: "basic" },
  HeaderKey: {
    type: "apiKey",
    in: "header",
    name: "X-Fixture-Key",
    description: "Header key documentation",
    "x-owner": "fictional",
  },
  QueryKey: { type: "apiKey", in: "query", name: "fixture_key" },
  Implicit: {
    type: "oauth2",
    description: "Implicit documentation",
    "x-flow": { retained: true },
    flows: {
      implicit: {
        authorizationUrl: "https://oauth.example.invalid/authorize",
        scopes: { read: "Read records" },
      },
    },
  },
  Password: {
    type: "oauth2",
    flows: {
      password: {
        tokenUrl: "https://oauth.example.invalid/token",
        scopes: { write: "Write records" },
      },
    },
  },
  Application: {
    type: "oauth2",
    flows: {
      clientCredentials: {
        tokenUrl: "https://oauth.example.invalid/token",
        scopes: { read: "Read records" },
      },
    },
  },
  AccessCode: {
    type: "oauth2",
    flows: {
      authorizationCode: {
        authorizationUrl: "https://oauth.example.invalid/authorize",
        tokenUrl: "https://oauth.example.invalid/token",
        scopes: { read: "Read records", write: "Write records" },
      },
    },
  },
};

function swagger(origin) {
  return {
    swagger: "2.0",
    info: { title: "Swagger security workflow", version: "1" },
    host: new URL(origin).host,
    schemes: ["http"],
    securityDefinitions: {
      Basic: structuredClone(basic),
      BasicAlias: { $ref: "#/securityDefinitions/Basic" },
      HeaderKey: structuredClone(schemes.HeaderKey),
      QueryKey: structuredClone(schemes.QueryKey),
      Implicit: {
        type: "oauth2",
        description: schemes.Implicit.description,
        "x-flow": { retained: true },
        flow: "implicit",
        ...schemes.Implicit.flows.implicit,
      },
      Password: {
        type: "oauth2",
        flow: "password",
        ...schemes.Password.flows.password,
      },
      Application: {
        type: "oauth2",
        flow: "application",
        ...schemes.Application.flows.clientCredentials,
      },
      AccessCode: {
        type: "oauth2",
        flow: "accessCode",
        ...schemes.AccessCode.flows.authorizationCode,
      },
    },
    security: structuredClone(requirements.inherited),
    paths: Object.fromEntries(
      Object.entries(requirements).map(([name, security]) => [
        "/" + name,
        {
          get: {
            operationId: name,
            ...(name === "inherited"
              ? {}
              : { security: structuredClone(security) }),
            responses: { 200: { description: "Fictional local echo" } },
          },
        },
      ]),
    ),
  };
}

function assertProjectMetadata(project) {
  assert.deepEqual(project.openapiComponents, {
    schemas: unrelatedSchemas,
    securitySchemes: schemes,
  });
  assert.equal(project.requests.length, Object.keys(requirements).length);
  for (const request of project.requests) {
    assert.deepEqual(
      request.openapiOperation.security,
      requirements[request.sourceOperationId],
      request.sourceOperationId,
    );
    assert.deepEqual(request.auth, { type: "none" });
  }
  assert.equal(
    project.requests.find((request) => request.sourceOperationId === "public")
      .inheritAuth,
    false,
  );
}

function assertOpenAPIMetadata(document) {
  assert.equal(document.openapi, "3.0.3");
  assert.equal(document.securityDefinitions, undefined);
  assert.deepEqual(document.components, {
    schemas: unrelatedSchemas,
    securitySchemes: schemes,
  });
  for (const [name, security] of Object.entries(requirements))
    assert.deepEqual(document.paths["/" + name].get.security, security, name);
  for (const scheme of Object.values(document.components.securitySchemes))
    assert.equal(Object.hasOwn(scheme, "$ref"), false);
  assert.deepEqual(
    document.components.securitySchemes.Basic["x-literal"],
    basic["x-literal"],
  );
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function fixture(t) {
  const observed = [];
  const echo = http.createServer((request, response) => {
    const value = {
      url: request.url,
      authorization: request.headers.authorization || "",
      apiKey: request.headers["x-fixture-key"] || "",
    };
    observed.push(value);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "swagger2-security-"));
  let app;
  t.after(async () => {
    await closeServer(app?.server);
    await closeServer(echo);
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  app = await createApp({ root, port: 0 });
  return {
    origin: `http://127.0.0.1:${echo.address().port}`,
    observed,
    get app() {
      return app;
    },
    async restart() {
      await closeServer(app.server);
      app = await createApp({ root, port: 0 });
    },
    async call(url, method = "GET", body, status = 200) {
      const response = await fetch(app.url + url, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      assert.equal(response.status, status, JSON.stringify(value));
      return value;
    },
  };
}

async function diskFiles(directory, prefix = "") {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const key = path.join(prefix, entry.name);
    const location = path.join(directory, entry.name);
    if (entry.isDirectory())
      Object.assign(files, await diskFiles(location, key));
    else files[key] = (await readFile(location)).toString("base64");
  }
  return files;
}

test("Swagger2 security metadata survives owner save, restart, OpenAPI reimport and backup restore without executing credentials", async (t) => {
  const f = await fixture(t);
  let project = await f.call(
    "/api/projects",
    "POST",
    { name: "Swagger2 security" },
    201,
  );
  const url = "/api/projects/" + project.id;
  project.openapiComponents = { schemas: structuredClone(unrelatedSchemas) };
  await f.call(url, "PUT", project);
  const document = swagger(f.origin);
  const sourceBefore = structuredClone(document);
  project = await f.call(url + "/import", "POST", { document });
  assertProjectMetadata(project);
  assert.deepEqual(document, sourceBefore);
  assert.equal(f.observed.length, 0);
  project = await f.call(url, "PUT", project);
  const savedRevision = project.configRevision;
  await f.restart();
  project = await f.call(url);
  assert.equal(project.configRevision, savedRevision);
  assertProjectMetadata(project);

  const exported = await f.call(url + "/export?format=openapi");
  assertOpenAPIMetadata(exported);
  const fresh = await f.call(
    "/api/projects",
    "POST",
    { name: "OAS3 reimport" },
    201,
  );
  const freshURL = "/api/projects/" + fresh.id;
  const reimported = await f.call(freshURL + "/import", "POST", {
    document: exported,
  });
  assertProjectMetadata(reimported);
  assertOpenAPIMetadata(await f.call(freshURL + "/export?format=openapi"));
  const backup = await f.call(freshURL + "/export");
  assertProjectMetadata(backup);
  const restored = await f.call(
    "/api/restore",
    "POST",
    { document: backup },
    201,
  );
  assert.notEqual(restored.id, fresh.id);
  assert.deepEqual(restored.requests, backup.requests);
  assertProjectMetadata(restored);
  await f.restart();
  for (const id of [project.id, fresh.id, restored.id]) {
    assertProjectMetadata(await f.call("/api/projects/" + id));
    assertOpenAPIMetadata(
      await f.call(`/api/projects/${id}/export?format=openapi`),
    );
  }
  assert.equal(
    f.observed.length,
    0,
    "metadata imports must not contact any endpoint",
  );

  const request = project.requests.find(
    (item) => item.sourceOperationId === "inherited",
  );
  const execute = async (input) => {
    const result = await f.call(url + "/execute", "POST", { request: input });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.outcome, "passed", JSON.stringify(result));
    return JSON.parse(result.body);
  };
  assert.deepEqual(await execute(request), {
    url: "/inherited",
    authorization: "",
    apiKey: "",
  });
  const username = "fictional-user",
    password = "fictional-password";
  assert.equal(
    (await execute({ ...request, auth: { type: "basic", username, password } }))
      .authorization,
    "Basic " + Buffer.from(username + ":" + password).toString("base64"),
  );
  assert.equal(
    (
      await execute({
        ...request,
        auth: {
          type: "apiKey",
          in: "header",
          key: "X-Fixture-Key",
          value: "fictional-key",
        },
      })
    ).apiKey,
    "fictional-key",
  );
  const query = await execute({
    ...request,
    auth: {
      type: "apiKey",
      in: "query",
      key: "fixture_key",
      value: "fictional + / & key",
    },
  });
  assert.equal(
    new URL(query.url, f.origin).searchParams.get("fixture_key"),
    "fictional + / & key",
  );
  assert.equal(query.authorization, "");
  project = await f.call(url);
  assertProjectMetadata(project);
  project.settings.globalAuth = {
    type: "bearer",
    token: "fictional-project-token",
  };
  await f.call(url, "PUT", project);
  assert.equal(
    (
      await execute(
        project.requests.find((item) => item.sourceOperationId === "public"),
      )
    ).authorization,
    "",
    "explicit security: [] must not acquire shared project credentials",
  );
  assert.equal(f.observed.length, 5);
  assertProjectMetadata(await f.call(url));
});

test("Swagger2 invalid batches and scheme collisions are atomic in memory and owner storage; reordered equivalent schemes are accepted", async (t) => {
  const f = await fixture(t);
  let project = await f.call(
    "/api/projects",
    "POST",
    { name: "Atomic Swagger2 import" },
    201,
  );
  const url = "/api/projects/" + project.id;
  project.openapiComponents = {
    schemas: structuredClone(unrelatedSchemas),
    securitySchemes: { Coincidental: { type: "http", scheme: "basic" } },
  };
  await f.call(url, "PUT", project);
  project = await f.call(url + "/import", "POST", {
    document: swagger(f.origin),
  });
  const before = structuredClone(project);
  const directory = f.app.store.directory(project.id);
  const filesBefore = await diskFiles(directory);
  const invalid = [
    [
      "hybrid non-source scheme alias cannot leak an old Swagger pointer",
      (document) => {
        document.components = {
          securitySchemes: {
            ExtraAlias: { $ref: "#/securityDefinitions/Basic" },
          },
        };
      },
    ],
    ...["components", "openapiComponents"].flatMap((field) =>
      [
        null,
        [],
        "abc",
        { securitySchemes: null },
        { securitySchemes: [] },
        { securitySchemes: "abc" },
      ].map((value) => [
        "malformed hybrid " + field + ": " + JSON.stringify(value),
        (document) => {
          document[field] = value;
        },
      ]),
    ),
    [
      "same source supplies conflicting definitions",
      (document) => {
        document.components = {
          securitySchemes: {
            Basic: { type: "apiKey", in: "query", name: "different" },
          },
        };
      },
    ],
    [
      "late operation has no source definition",
      (document) => {
        document.paths["/optional"].get.security = [{ Missing: [] }];
      },
    ],
    [
      "target-only scheme cannot satisfy source requirement",
      (document) => {
        document.paths["/optional"].get.security = [{ Coincidental: [] }];
      },
    ],
    [
      "non-OAuth scheme cannot declare scopes",
      (document) => {
        document.paths["/optional"].get.security = [{ Basic: ["read"] }];
      },
    ],
    [
      "undeclared OAuth scope",
      (document) => {
        document.paths["/optional"].get.security = [{ Implicit: ["missing"] }];
      },
    ],
    [
      "malformed late security scopes",
      (document) => {
        document.paths["/optional"].get.security = [{ Basic: "not-an-array" }];
      },
    ],
    [
      "late cookie API key is unsupported",
      (document) => {
        document.securityDefinitions.LateInvalid = {
          type: "apiKey",
          in: "cookie",
          name: "sid",
        };
      },
    ],
    [
      "unrepresentable component name",
      (document) => {
        document.securityDefinitions["invalid/name"] = { type: "basic" };
      },
    ],
    [
      "external reference is never fetched",
      (document) => {
        document.securityDefinitions.LateInvalid = {
          $ref: f.origin + "/must-not-fetch",
        };
      },
    ],
    [
      "dangling local scheme reference",
      (document) => {
        document.securityDefinitions.LateInvalid = {
          $ref: "#/securityDefinitions/Missing",
        };
      },
    ],
    [
      "cyclic local scheme reference",
      (document) => {
        document.securityDefinitions.LateInvalid = {
          $ref: "#/securityDefinitions/LateInvalid",
        };
      },
    ],
    [
      "conflicting same-name scheme after a new scheme",
      (document) => {
        document.securityDefinitions = {
          NewBeforeConflict: { type: "basic" },
          ...document.securityDefinitions,
          Basic: { type: "apiKey", in: "query", name: "different" },
        };
      },
    ],
  ];
  for (const [label, mutate] of invalid) {
    const document = swagger(f.origin);
    mutate(document);
    const sourceBefore = structuredClone(document);
    const inMemory = structuredClone(before);
    assert.throws(() => importIntoProject(inMemory, document), label);
    assert.deepEqual(inMemory, before, label);
    assert.deepEqual(document, sourceBefore, label);
    const error = await f.call(url + "/import", "POST", { document }, 400);
    assert.equal(typeof error.error, "string", label);
    assert(error.error.length > 0, label);
    assert.deepEqual(await f.call(url), before, label);
    assert.deepEqual(await diskFiles(directory), filesBefore, label);
    assert.equal(f.observed.length, 0, label);
  }
  await f.restart();
  assert.deepEqual(await f.call(url), before);
  assert.deepEqual(await diskFiles(directory), filesBefore);
  const reordered = swagger(f.origin);
  reordered.securityDefinitions = {
    Basic: {
      "x-literal": structuredClone(basic["x-literal"]),
      description: basic.description,
      type: "basic",
    },
  };
  reordered.security = [{ Basic: [] }];
  reordered.paths = {
    "/equivalent": {
      get: {
        operationId: "equivalent",
        responses: { 200: { description: "Equivalent scheme" } },
      },
    },
  };
  const accepted = await f.call(url + "/import", "POST", {
    document: reordered,
  });
  assert.equal(accepted.requests.length, before.requests.length + 1);
  assert.deepEqual(accepted.openapiComponents, before.openapiComponents);
  assert.deepEqual(accepted.requests.at(-1).openapiOperation.security, [
    { Basic: [] },
  ]);
  assert.deepEqual(accepted.requests.at(-1).auth, { type: "none" });
  assert(accepted.configRevision > before.configRevision);
  assert.equal(f.observed.length, 0);

  // Sync is an explicit update, not an ordinary collision bypass. It keeps IDs
  // and unrelated categories while revalidating requirements against source.
  const synced = structuredClone(before);
  const update = swagger(f.origin);
  update.securityDefinitions.Basic.description = "Updated source description";
  const ids = synced.requests.map((request) => request.id);
  importIntoProject(synced, update, { sync: true });
  assert.deepEqual(
    synced.requests.map((request) => request.id),
    ids,
  );
  assert.deepEqual(synced.openapiComponents.schemas, unrelatedSchemas);
  assert.equal(
    synced.openapiComponents.securitySchemes.Basic.description,
    "Updated source description",
  );
  assert.equal(
    synced.openapiComponents.securitySchemes.Coincidental.scheme,
    "basic",
  );
  const syncBefore = structuredClone(synced);
  update.paths["/optional"].get.security = [{ Coincidental: [] }];
  assert.throws(() => importIntoProject(synced, update, { sync: true }));
  assert.deepEqual(synced, syncBefore);
});
