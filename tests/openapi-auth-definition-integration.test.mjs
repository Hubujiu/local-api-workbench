// Runtime acceptance belongs to CI; do not execute this application test locally.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { exportOpenAPI } from "../src/core.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
import { openAPIAuthDefinition } from "../src/openapi-auth-definition.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";

async function disk(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await disk(file)
      : (await readFile(file)).toString("base64");
  }
  return result;
}

test("combined native inheritance guard and imported noauth definition lifecycle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auth-definition-integration-"));
  const seen = [];
  const peer = http.createServer((request, response) => {
    seen.push(request.headers.authorization);
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + peer.address().port;
  let app = await createApp({ root, port: 0 });
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await close();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
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
  const create = (name) => call("/api/projects", "POST", { name }, 201);

  // Use the existing graph fixture, changing only its URL to a static definition.
  const document = nativeInheritanceFixture();
  document.apis[1].url = origin + "/native";
  const original = structuredClone(document);
  let preserved = await create("Preserved native auth");
  preserved = await call(`/api/projects/${preserved.id}/import`, "POST", {
    document,
    inheritanceMode: "preserve",
  });
  assert.equal(preserved.requests[0].nativeInheritance.authMode, "inherit");
  assert.equal(preserved.requests[0].inheritAuth, false);
  const saved = structuredClone(preserved);
  const before = await disk(app.store.directory(preserved.id));
  const rejected = await call(
    `/api/projects/${preserved.id}/export?format=openapi`,
    "GET",
    undefined,
    400,
  );
  assert.match(JSON.stringify(rejected), /原生继承图/);
  assert.equal(rejected.paths, undefined);
  assert.deepEqual(await call(`/api/projects/${preserved.id}`), saved);
  assert.deepEqual(await disk(app.store.directory(preserved.id)), before);
  const detached = structuredClone(preserved.requests[0]);
  delete detached.nativeInheritance;
  assert.throws(() => openAPIAuthDefinition(preserved, detached), /原生继承图/);
  assert.throws(
    () => exportOpenAPI({ ...preserved, requests: [detached] }),
    /原生继承图/,
  );

  let flattened = await create("Flattened native auth");
  flattened = await call(`/api/projects/${flattened.id}/import`, "POST", {
    document,
  });
  assert.equal(flattened.settings.nativeInheritance, undefined);
  const effective = freezeServiceBinding(preserved, preserved.requests[0]);
  const flat = freezeServiceBinding(flattened, flattened.requests[0]);
  for (const key of ["auth", "headers", "query", "cookies", "form"])
    assert.deepEqual(flat[key], effective[key], key + " effective definition");
  const flatDocument = await call(
    `/api/projects/${flattened.id}/export?format=openapi`,
  );
  const operation = flatDocument.paths["/native"].get;
  const schemeName = Object.keys(operation.security[0])[0];
  assert.deepEqual(flatDocument.components.securitySchemes[schemeName], {
    type: "http",
    scheme: "bearer",
  });
  assert.deepEqual(document, original);
  assert.equal(seen.length, 0, "definition export must not execute requests");

  const noauth = {
    openapi: "3.0.3",
    info: { title: "Public", version: "1" },
    servers: [{ url: origin }],
    components: {
      securitySchemes: { OriginalBearer: { type: "http", scheme: "bearer" } },
    },
    security: [{ OriginalBearer: [] }],
    paths: {
      "/public": {
        get: {
          tags: ["Public"],
          security: [],
          responses: { 200: { description: "ok" } },
        },
      },
    },
  };
  const shared = {
    globalAuth: { type: "bearer", token: "fictional-global" },
    folderAuth: { Public: { type: "bearer", token: "fictional-folder" } },
  };
  const importWithShared = async (name, source) => {
    let project = await create(name);
    project.settings = { ...project.settings, ...structuredClone(shared) };
    project = await call(`/api/projects/${project.id}`, "PUT", project);
    return call(`/api/projects/${project.id}/import`, "POST", {
      document: source,
    });
  };
  const first = await importWithShared("Original noauth", noauth);
  assert.equal(first.requests[0].inheritAuth, false);
  const exported = await call(
    `/api/projects/${first.id}/export?format=openapi`,
  );
  assert.deepEqual(exported.paths["/public"].get.security, []);
  const second = await importWithShared("Reimported noauth", exported);
  assert.equal(second.requests[0].inheritAuth, false);
  assert.equal(second.requests[0].auth.type, "none");
  const plan = await call(`/api/projects/${second.id}/plans`, "POST", {
    steps: [{ request: second.requests[0] }],
  });
  const run = async (id) => {
    const count = seen.length;
    const result = await call(`/api/projects/${id}/run`, "POST", {
      planId: plan.id,
    });
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(seen.length, count + 1);
    assert.equal(
      seen.at(-1),
      undefined,
      "public request must not inherit credentials",
    );
  };
  await run(second.id);
  const changed = await call(`/api/projects/${second.id}`);
  changed.settings.globalAuth.token = "fictional-changed";
  changed.settings.folderAuth.Public.token = "fictional-changed-folder";
  changed.requests[0].auth = { type: "bearer", token: "fictional-live" };
  changed.requests[0].inheritAuth = true;
  await call(`/api/projects/${second.id}`, "PUT", changed);
  await run(second.id);
  const backup = await call(`/api/projects/${second.id}/export`);
  const restored = await call(
    "/api/restore",
    "POST",
    { document: backup },
    201,
  );
  assert.deepEqual(
    restored.plans.find((entry) => entry.id === plan.id).steps,
    plan.steps,
  );
  await close();
  app = await createApp({ root, port: 0 });
  await run(restored.id);
  assert.deepEqual(await call(`/api/projects/${preserved.id}`), saved);
  assert.deepEqual(await disk(app.store.directory(preserved.id)), before);
});
