// CI-only runtime workflow: author locally with syntax checks, never execute locally.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest, exportOpenAPI } from "../src/core.mjs";

async function disk(directory) {
  const out = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = join(directory, entry.name);
    out[entry.name] = entry.isDirectory()
      ? await disk(location)
      : (await readFile(location)).toString("base64");
  }
  return out;
}
test("owner auth definitions survive save/restart/backup/reimport; credentials require explicit reconfiguration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auth-definition-"));
  const seen = [];
  const credentials = {
    "/basic": {
      type: "basic",
      username: "fixture-user",
      password: "fixture-password",
    },
    "/bearer": { type: "bearer", token: "fixture-token" },
    "/header": {
      type: "apiKey",
      key: "X-Fixture-Key",
      value: "fixture-header-value",
      in: "header",
    },
    "/query": {
      type: "apiKey",
      key: "fixture_key",
      value: "fixture-query-value",
      in: "query",
    },
    "/none": { type: "none" },
  };
  const receiver = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    const actual = {
      path: url.pathname,
      authorization: req.headers.authorization ?? null,
      key: req.headers["x-fixture-key"] ?? null,
      query: url.searchParams.get("fixture_key"),
    };
    seen.push(actual);
    const ok =
      url.pathname === "/basic"
        ? actual.authorization ===
          "Basic " +
            Buffer.from("fixture-user:fixture-password").toString("base64")
        : url.pathname === "/bearer"
          ? actual.authorization === "Bearer fixture-token"
          : url.pathname === "/header"
            ? actual.key === "fixture-header-value"
            : url.pathname === "/query"
              ? actual.query === "fixture-query-value"
              : url.pathname === "/none" &&
                actual.authorization === null &&
                actual.key === null &&
                actual.query === null;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(actual));
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await closeApp();
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
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
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  let source = await call(
    "/api/projects",
    "POST",
    { name: "Auth definitions" },
    201,
  );
  const origin = "http://127.0.0.1:" + receiver.address().port;
  source.requests = Object.entries(credentials).map(([route, auth]) =>
    normalizeRequest({
      name: route,
      url: origin + route,
      auth,
      inheritAuth: false,
      openapiOperation: { security: [{ OldBearer: [] }] },
    }),
  );
  source.openapiComponents = {
    securitySchemes: { OldBearer: { type: "http", scheme: "bearer" } },
    schemas: {
      Retained: { type: "string", description: "unrelated source annotation" },
    },
  };
  source = await call(`/api/projects/${source.id}`, "PUT", source);
  const saved = structuredClone(source),
    savedDisk = await disk(app.store.directory(source.id));
  const exported = await call(
    `/api/projects/${source.id}/export?format=openapi`,
  );
  assert.deepEqual(exported.paths["/none"].get.security, []);
  assert.deepEqual(
    exported.components.schemas,
    source.openapiComponents.schemas,
  );
  for (const route of ["/basic", "/bearer", "/header", "/query"]) {
    const name = Object.keys(exported.paths[route].get.security[0])[0];
    assert.notEqual(name, "OldBearer");
    assert.ok(exported.components.securitySchemes[name]);
  }
  for (const secret of [
    "fixture-user",
    "fixture-password",
    "fixture-token",
    "fixture-header-value",
    "fixture-query-value",
  ])
    assert.ok(!JSON.stringify(exported).includes(secret));
  assert.deepEqual(await call(`/api/projects/${source.id}`), saved);
  assert.deepEqual(await disk(app.store.directory(source.id)), savedDisk);
  assert.equal(seen.length, 0);
  await closeApp();
  app = await createApp({ root, port: 0 });
  assert.deepEqual(
    await call(`/api/projects/${source.id}/export?format=openapi`),
    exported,
  );
  const backup = await call(`/api/projects/${source.id}/export`);
  let restored = await call(
    "/api/projects",
    "POST",
    { name: "Backup restored" },
    201,
  );
  restored = await call(`/api/projects/${restored.id}/import`, "POST", {
    document: backup,
  });
  assert.deepEqual(
    restored.requests.map((r) => r.auth),
    source.requests.map((r) => r.auth),
  );
  assert.deepEqual(
    (await call(`/api/projects/${restored.id}/export?format=openapi`)).paths,
    exported.paths,
  );
  let imported = await call(
    "/api/projects",
    "POST",
    { name: "Definition reimport" },
    201,
  );
  imported = await call(`/api/projects/${imported.id}/import`, "POST", {
    document: exported,
  });
  assert.ok(imported.requests.every((r) => r.auth.type === "none"));
  const reexported = await call(
    `/api/projects/${imported.id}/export?format=openapi`,
  );
  assert.deepEqual(
    reexported.components.securitySchemes,
    exported.components.securitySchemes,
  );
  for (const route of Object.keys(credentials))
    assert.deepEqual(
      reexported.paths[route].get.security,
      exported.paths[route].get.security,
    );
  const unauthenticated = imported.requests.find(
    (r) => new URL(r.url).pathname === "/bearer",
  );
  const rejected = await call(`/api/projects/${imported.id}/execute`, "POST", {
    request: unauthenticated,
  });
  assert.equal(rejected.status, 401);
  assert.equal(seen.at(-1).authorization, null);
  // Explicit fictional credential installation, NOT auth import inference.
  for (const request of imported.requests) {
    request.auth = structuredClone(credentials[new URL(request.url).pathname]);
    request.inheritAuth = false;
  }
  imported = await call(`/api/projects/${imported.id}`, "PUT", imported);
  await closeApp();
  app = await createApp({ root, port: 0 });
  imported = await call(`/api/projects/${imported.id}`);
  for (const request of imported.requests) {
    const result = await call(`/api/projects/${imported.id}/execute`, "POST", {
      request,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(JSON.parse(result.body).path, new URL(request.url).pathname);
  }
  assert.deepEqual(await call(`/api/projects/${source.id}`), saved);
  assert.deepEqual(await disk(app.store.directory(source.id)), savedDisk);

  // Export failures must not return a partial document or modify persisted data.
  for (const kind of ["collision", "unsupported"]) {
    let bad = await call("/api/projects", "POST", { name: kind }, 201);
    bad.requests = [
      normalizeRequest({ url: origin + "/first", auth: { type: "basic" } }),
      normalizeRequest({
        url: origin + "/later",
        auth: {
          type: kind === "unsupported" ? "digest" : "basic",
          password: "diagnostic-secret",
        },
      }),
    ];
    if (kind === "collision") {
      const projected = exportOpenAPI(bad);
      const name = Object.keys(projected.paths["/first"].get.security[0])[0];
      bad.openapiComponents = {
        securitySchemes: { [name]: { type: "http", scheme: "bearer" } },
      };
    }
    bad = await call(`/api/projects/${bad.id}`, "PUT", bad);
    const before = await disk(app.store.directory(bad.id));
    const failure = await call(
      `/api/projects/${bad.id}/export?format=openapi`,
      "GET",
      undefined,
      400,
    );
    assert.equal(failure.paths, undefined);
    assert.ok(!JSON.stringify(failure).includes("diagnostic-secret"));
    assert.deepEqual(await call(`/api/projects/${bad.id}`), bad);
    assert.deepEqual(await disk(app.store.directory(bad.id)), before);
  }
});
