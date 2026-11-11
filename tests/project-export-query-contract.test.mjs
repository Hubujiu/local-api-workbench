import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest, exportOpenAPI } from "../src/core.mjs";

import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "project-export-query-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("private-project-fixture");
  p.environments = [
    { id: "dev", name: "dev", variables: { token: "private-dev-fixture" } },
    { id: "prod", name: "prod", variables: { token: "private-prod-fixture" } },
  ];
  p.requests = [
    normalizeRequest({
      id: "private-request-fixture",
      name: "request",
      url: "https://example.com/",
      auth: { type: "bearer", token: "private-auth-fixture" },
    }),
  ];
  p.globalVariables = { secret: "private-global-fixture" };
  p.dictionary = [
    {
      id: "export-model",
      name: p.name + " / Model",
      schema: { type: "string" },
    },
  ];
  p.openapiComponents = { schemas: { "export-model": { type: "string" } } };
  await app.store.save(p);
  const before = await app.store.get(p.id);
  const get = async (query, authorized = true) => {
    const r = await fetch(
      app.url + "/api/projects/" + p.id + "/export" + query,
      { headers: authorized ? { "x-local-token": app.token } : {} },
    );
    return { status: r.status, body: await r.json() };
  };
  return { app, p: before, get };
}

test("explicit invalid export queries reject without project or query data disclosure", async (t) => {
  const f = await fixture(t);
  for (const query of [
    "?format=postman",
    "?format=postman-environment&environmentId=dev",
    "?format=",
    "?format=private-query-fixture",
    "?format=Native",
    "?format=native&format=apipost",
    "?format=apipost&format=native",
    "?format=native&format=native",
    "?format=native&%66ormat=openapi",
    "?format=native&environmentId=dev",
    "?environmentId=dev",
    "?format=openapi&selection=private-query-fixture",
    "?format=apipost&folder=private-query-fixture",
    "?private-query-fixture=private-query-fixture",
    "?databaseMode=rebind",
    "?format=native&databaseMode=rebind",
    "?format=openapi&databaseMode=rebind",
    "?format=apipost&databaseMode=rebind&databaseMode=rebind",
    "?format=apipost&databaseMode=private-query-fixture",
    "?format=apipost&databaseMode=",
    "?format=apipost&modelNameMode=private-query-fixture",
    "?format=apipost&modelNameMode=",
    "?format=native&modelNameMode=namespaced",
    "?format=apipost&modelNameMode=namespaced&modelNameMode=namespaced",
  ]) {
    const r = await f.get(query);
    assert.equal(r.status, 400, query);
    assert.deepEqual(Object.keys(r.body), ["error"], query);
    assert.equal(typeof r.body.error, "string");
    assert.doesNotMatch(JSON.stringify(r.body), /private-.*-fixture/);
    assert.deepEqual(await f.app.store.get(f.p.id), f.p);
  }
});

test("default and native remain full backups; historical explicit formats and options remain valid", async (t) => {
  const f = await fixture(t);
  for (const query of ["", "?format=native"]) {
    const r = await f.get(query);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, f.p);
    assert.match(JSON.stringify(r.body), /private-prod-fixture/);
    assert.match(JSON.stringify(r.body), /private-auth-fixture/);
    assert.match(JSON.stringify(r.body), /private-global-fixture/);
  }
  for (const [format, exporter] of [
    ["apipost", exportApipost],
    ["apipost-directory", exportApipostDirectory],
    ["openapi", exportOpenAPI],
  ]) {
    const r = await f.get("?format=" + format);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, JSON.parse(JSON.stringify(exporter(f.p))));
    if (format !== "openapi") {
      for (const modelNameMode of ["namespaced", "preserve"]) {
        const options = { modelNameMode, databaseMode: "rebind" };
        const r = await f.get(
          "?format=" +
            format +
            "&modelNameMode=" +
            modelNameMode +
            "&databaseMode=rebind",
        );
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(
          r.body,
          JSON.parse(JSON.stringify(exporter(f.p, options))),
        );
        const models =
          format === "apipost"
            ? r.body.models
            : JSON.parse(
                r.body.files.find((file) => file.path === "schemas/index.json")
                  .text,
              ).items;
        assert.deepEqual(
          models.map((model) => model.name),
          [modelNameMode === "preserve" ? f.p.name + " / Model" : "Model"],
        );
      }
    }
  }
  assert.deepEqual(await f.app.store.get(f.p.id), f.p);
});

test("owner authentication still precedes export and query validation", async (t) => {
  const f = await fixture(t);
  for (const q of [
    "",
    "?format=native",
    "?format=postman",
    "?format=apipost",
  ]) {
    const r = await f.get(q, false);
    assert.equal(r.status, 403);
    assert.doesNotMatch(JSON.stringify(r.body), /private-.*-fixture/);
  }
});
