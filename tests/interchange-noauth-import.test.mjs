import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";

const bearer = {
  type: "bearer",
  bearer: [{ key: "token", value: "fictional-source" }],
};
const none = { type: "noauth" };
function fixtures(url) {
  const req = (auth) => ({
    name: "public",
    request: {
      url: url + "/public",
      method: "GET",
      ...(auth === undefined ? {} : { auth }),
    },
  });
  const pm = (items, auth) => ({
    info: {
      name: "Public",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    ...(auth === undefined ? {} : { auth }),
    item: items,
  });
  const oa = (root, operation) => ({
    openapi: "3.0.3",
    info: { title: "Public", version: "1" },
    servers: [{ url }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
    ...(root === undefined ? {} : { security: root }),
    paths: {
      "/public": {
        get: {
          tags: ["Public"],
          responses: { 200: { description: "ok" } },
          ...(operation === undefined ? {} : { security: operation }),
        },
      },
    },
  });
  return [
    ["postman-request", pm([req(none)], bearer), undefined],
    ["postman-collection", pm([req(undefined)], none), undefined],
    [
      "postman-folder",
      pm([{ name: "Public", auth: none, item: [req(null)] }], bearer),
      undefined,
    ],
    [
      "postman-child-bearer",
      pm([req(bearer)], none),
      "Bearer fictional-source",
    ],
    ["postman-absent", pm([req(undefined)]), "Bearer fictional-global"],
    ["postman-null", pm([req(null)]), "Bearer fictional-global"],
    ["openapi-operation", oa([{ bearer: [] }], []), undefined],
    ["openapi-root", oa([], undefined), undefined],
    ["openapi-absent", oa(undefined, undefined), "Bearer fictional-folder"],
    ["openapi-nonempty", oa([], [{ bearer: [] }]), "Bearer fictional-folder"],
    ["openapi-optional", oa([], [{}]), "Bearer fictional-folder"],
    ["openapi-null", oa([], null), "Bearer fictional-folder"],
  ];
}
test("explicit Postman and OpenAPI opt-outs preserve owner wire isolation, frozen execution and restore", async (t) => {
  const seen = [];
  const upstream = http.createServer((q, r) => {
    seen.push(q.headers.authorization);
    r.end("{}");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${upstream.address().port}`;
  const root = await mkdtemp(path.join(tmpdir(), "interchange-noauth-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await stop();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const post = async (route, body, status = 200) => {
    const r = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    const v = await r.json();
    assert.equal(r.status, status, JSON.stringify(v));
    return v;
  };
  const other = await app.store.create("untouched"),
    untouched = await app.store.get(other.id);
  for (const [name, document, expected] of fixtures(url)) {
    const p = await app.store.create(name);
    p.settings.globalAuth = { type: "bearer", token: "fictional-global" };
    p.settings.folderAuth = {
      Public: { type: "bearer", token: "fictional-folder" },
    };
    await app.store.save(p);
    const original = structuredClone(document);
    const imported = await post(`/api/projects/${p.id}/import`, { document });
    assert.deepEqual(document, original);
    const r = imported.requests[0];
    const plan = await post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: r }],
    });
    const direct = await post(`/api/projects/${p.id}/run`, { planId: plan.id });
    assert.equal(direct.status, "passed", JSON.stringify(direct));
    assert.equal(seen.at(-1), expected, name + " actual wire");
    assert.equal(
      r.inheritAuth,
      expected !== undefined,
      name + " inheritance flag",
    );

    const live = await app.store.get(p.id);
    live.settings.globalAuth.token = "fictional-changed";
    live.settings.folderAuth.Public.token = "fictional-changed-folder";
    live.requests[0].auth = { type: "bearer", token: "fictional-live" };
    live.requests[0].inheritAuth = true;
    await app.store.save(live);
    const run = await post(`/api/projects/${p.id}/run`, { planId: plan.id });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(seen.at(-1), expected, name + " frozen wire");
    const disk = await new Store(root).get(p.id);
    const restored = await post("/api/restore", { document: disk }, 201);
    assert.deepEqual(
      restored.plans.find((x) => x.id === plan.id).steps,
      plan.steps,
    );
    await stop();
    app = await createApp({ root, port: 0 });
    const again = await post(`/api/projects/${restored.id}/run`, {
      planId: plan.id,
    });
    assert.equal(again.status, "passed", JSON.stringify(again));
    assert.equal(seen.at(-1), expected, name + " restored wire");
  }
  assert.deepEqual(await app.store.get(other.id), untouched);
});
