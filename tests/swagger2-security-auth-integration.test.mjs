// Root integration only: runtime acceptance executes in CI, never locally.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

async function disk(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await disk(location)
      : (await readFile(location)).toString("base64");
  }
  return result;
}

test("Swagger security metadata survives PR58 inheritance and explicit auth overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "swagger-auth-integration-"));
  let app = await createApp({ root, port: 0 });
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, method = "GET", body, status = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const requirements = [{ Basic: [], Key: [] }, { OAuth: ["read"] }];
  const operation = (extra = {}) => ({
    tags: ["Secured"],
    responses: { 200: { description: "ok" } },
    ...extra,
  });
  const document = {
    swagger: "2.0",
    info: { title: "Fictional definitions", version: "1" },
    schemes: ["https"],
    host: "fixture.invalid",
    basePath: "/api",
    securityDefinitions: {
      Basic: { type: "basic", description: "Basic metadata" },
      Key: { type: "apiKey", in: "header", name: "X-Fictional-Key" },
      OAuth: {
        type: "oauth2",
        flow: "application",
        tokenUrl: "https://fixture.invalid/token",
        scopes: { read: "Read fixture" },
      },
    },
    security: requirements,
    paths: {
      "/untouched": { get: operation() },
      "/explicit": { get: operation() },
      "/disabled": { get: operation() },
      "/public": { get: operation({ security: [] }) },
      "/optional": { get: operation({ security: [{}, { Basic: [] }] }) },
    },
  };
  const source = structuredClone(document);
  let project = await call(
    "/api/projects",
    "POST",
    { name: "Swagger PR58 integration" },
    201,
  );
  project.settings.globalAuth = {
    type: "bearer",
    token: "fictional-global-secret",
  };
  project.settings.folderAuth = {
    Secured: {
      type: "basic",
      username: "fictional-shared-user",
      password: "fictional-shared-password",
    },
  };
  project = await call(`/api/projects/${project.id}`, "PUT", project);
  project = await call(`/api/projects/${project.id}/import`, "POST", {
    document,
  });
  assert.deepEqual(document, source);
  assert.ok(project.requests.every((request) => request.auth.type === "none"));
  const find = (suffix) =>
    project.requests.find((request) =>
      new URL(request.url).pathname.endsWith(suffix),
    );
  assert.equal(find("/public").inheritAuth, false);
  assert.equal(find("/untouched").inheritAuth, true);
  const definition = () =>
    call(`/api/projects/${project.id}/export?format=openapi`);
  const before = await disk(app.store.directory(project.id));
  const exported = await definition();
  const bySuffix = (doc, suffix) =>
    Object.entries(doc.paths).find(([path]) => path.endsWith(suffix))[1].get;
  assert.deepEqual(bySuffix(exported, "/untouched").security, requirements);
  assert.deepEqual(bySuffix(exported, "/public").security, []);
  assert.deepEqual(bySuffix(exported, "/optional").security, [
    {},
    { Basic: [] },
  ]);
  assert.deepEqual(exported.components.securitySchemes.Basic, {
    type: "http",
    scheme: "basic",
    description: "Basic metadata",
  });
  assert.deepEqual(exported.components.securitySchemes.Key, {
    type: "apiKey",
    in: "header",
    name: "X-Fictional-Key",
  });
  assert.deepEqual(exported.components.securitySchemes.OAuth, {
    type: "oauth2",
    flows: {
      clientCredentials: {
        tokenUrl: "https://fixture.invalid/token",
        scopes: { read: "Read fixture" },
      },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(exported),
    /fictional-global-secret|fictional-shared-user|fictional-shared-password/,
  );
  assert.deepEqual(await disk(app.store.directory(project.id)), before);
  await close();
  app = await createApp({ root, port: 0 });
  assert.deepEqual(await definition(), exported);

  project = await call(`/api/projects/${project.id}`);
  find("/explicit").auth = {
    type: "apiKey",
    in: "query",
    key: "local_key",
    value: "fictional-local-secret",
  };
  find("/disabled").auth = { type: "none" };
  find("/disabled").inheritAuth = false;
  project = await call(`/api/projects/${project.id}`, "PUT", project);
  const changed = await definition();
  assert.deepEqual(bySuffix(changed, "/untouched").security, requirements);
  assert.deepEqual(bySuffix(changed, "/disabled").security, []);
  const selected = bySuffix(changed, "/explicit").security;
  assert.equal(selected.length, 1);
  const name = Object.keys(selected[0])[0];
  assert.deepEqual(changed.components.securitySchemes[name], {
    type: "apiKey",
    in: "query",
    name: "local_key",
  });
  assert.doesNotMatch(
    JSON.stringify(changed),
    /fictional-local-secret|fictional-global-secret|fictional-shared-password/,
  );
  const backup = await call(`/api/projects/${project.id}/export`);
  const restored = await call(
    "/api/restore",
    "POST",
    { document: backup },
    201,
  );
  const restoredDefinition = await call(
    `/api/projects/${restored.id}/export?format=openapi`,
  );
  assert.deepEqual(restoredDefinition.paths, changed.paths);
  assert.deepEqual(restoredDefinition.components, changed.components);
  const restoredExplicit = restored.requests.find((request) =>
    new URL(request.url).pathname.endsWith("/explicit"),
  );
  assert.equal(
    restoredExplicit.auth.value,
    "fictional-local-secret",
    "native backup is separate from sanitized definition projection",
  );
  let fresh = await call(
    "/api/projects",
    "POST",
    { name: "OAS3 definition reimport" },
    201,
  );
  fresh = await call(`/api/projects/${fresh.id}/import`, "POST", {
    document: changed,
  });
  assert.ok(fresh.requests.every((request) => request.auth.type === "none"));
  const roundtrip = await call(
    `/api/projects/${fresh.id}/export?format=openapi`,
  );
  assert.deepEqual(
    roundtrip.components.securitySchemes,
    changed.components.securitySchemes,
  );
  for (const suffix of [
    "/untouched",
    "/explicit",
    "/disabled",
    "/public",
    "/optional",
  ])
    assert.deepEqual(
      bySuffix(roundtrip, suffix).security,
      bySuffix(changed, suffix).security,
    );
});
