import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../src/server.mjs";
import {
  importIntoProject,
  restoreProject,
  normalizeRequest,
} from "../src/core.mjs";
import { nativeMockFixture } from "./fixtures/apipost-native-mock.mjs";
import {
  resolveNativeMockRoute,
  normalizeNativeMockRoute,
} from "../src/native-mock-route.mjs";
test("native method/path/selectors share the bounded Mock pipeline and preserve project/reload/restore isolation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mock-route-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const { directory } = nativeMockFixture(),
    before = JSON.stringify(directory),
    p = await app.store.create("source");
  importIntoProject(p, directory);
  p.requests[0].beforeScript =
    'throw Error("Mock must not run request scripts")';
  await app.store.save(p);
  const saved = await app.store.get(p.id),
    copy = restoreProject(JSON.stringify(saved));
  await app.store.save(copy);
  assert.deepEqual(
    copy.requests[0].nativeMockRoute,
    saved.requests[0].nativeMockRoute,
  );
  const call = (id, suffix, method = "GET", prefix = "/mock/") =>
    fetch(app.url + prefix + id + suffix, { method });
  for (const current of [saved, copy]) {
    for (const suffix of [
      "/items/123?mode=fail",
      "//items/123//?mode=fail",
      "/%69tems/%7Bid%7D?mode=fail",
    ]) {
      const r = await call(current.id, suffix);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-native-rule"), "matched");
      assert.match(r.headers.get("content-security-policy"), /sandbox/);
      assert.equal((await r.json()).kind, "matched");
    }
    for (const suffix of [
      "/Items/123?mode=fail",
      "/items/123/extra",
      "/absent",
    ])
      assert.equal((await call(current.id, suffix)).status, 404);
    assert.equal((await call(current.id, "/items/123", "POST")).status, 404);
    const selected = await call(
      current.id,
      "/absent?apipost_id=api&mode=fail",
      "POST",
    );
    assert.equal(selected.status, 200);
    assert.equal(selected.headers.get("x-native-rule"), "matched");
    assert.equal(
      (await call(current.id, "/items/123?target_id=missing")).status,
      404,
    );
    assert.equal(
      (await call(current.id, "/items/123?apipost_id=api&echoapi_id=other"))
        .status,
      400,
    );
    assert.equal(
      (
        await call(
          current.id,
          "/items/123?mode=fail",
          "GET",
          "/app/mock/project/",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          current.id,
          "/" + current.requests[0].id + "?apipost_id=ordinary-query&mode=fail",
          "POST",
        )
      ).status,
      200,
    );
  }
  const conflict = structuredClone(saved.requests[0]);
  conflict.id = "second";
  conflict.nativeMockRoute.sourceTargetId = "other";
  conflict.nativeMock.sourceTargetId = "other";
  conflict.nativeMock.rules[0].response.headers["x-selected"] = "other";
  saved.requests.push(conflict);
  await app.store.save(saved);
  assert.equal((await call(saved.id, "/items/123?mode=fail")).status, 409);
  const selected = await call(saved.id, "/unrelated?mode=fail&target_id=other");
  assert.equal(selected.headers.get("x-selected"), "other");
  assert.equal((await call(copy.id, "/unrelated?target_id=other")).status, 404);
  saved.requests[1].deletedAt = new Date().toISOString();
  await app.store.save(saved);
  assert.equal((await call(saved.id, "/items/123?mode=fail")).status, 200);
  copy.requests[0].url = "http://127.0.0.1:1/changed/{id}";
  await app.store.save(copy);
  assert.equal((await call(copy.id, "/items/123")).status, 404);
  assert.equal((await call(copy.id, "/changed/123")).status, 200);
  copy.requests[0].nativeMock.enabled = false;
  await app.store.save(copy);
  assert.equal((await call(copy.id, "/changed/123")).status, 404);
  saved.settings.mockEnabled = false;
  await app.store.save(saved);
  assert.equal((await call(saved.id, "/items/123")).status, 503);
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
  app = await createApp({ root, port: 0 });
  assert.equal((await call(copy.id, "/changed/123")).status, 404);
  assert.equal(JSON.stringify(directory), before);
});
test("Mock route metadata and matching reject malformed path/identity without regex or filesystem access", () => {
  assert.throws(
    () =>
      normalizeRequest({
        url: "http://127.0.0.1:1",
        nativeMock: { sourceTargetId: "one" },
        nativeMockRoute: { sourceTargetId: "two" },
      }),
    /来源接口不一致/,
  );
  const route = {
    version: 1,
    sourceProjectId: "project",
    sourceTargetId: "api",
    sourcePath: "/items/{id}",
  };
  for (const sourcePath of [
    "/a/%ZZ",
    "/a/%00",
    "/a/../b",
    "/a/%3Fquery",
    "/a\\b",
    "/" + "x".repeat(8193),
  ])
    assert.throws(() => normalizeNativeMockRoute({ ...route, sourcePath }));
  assert.throws(() =>
    normalizeRequest({
      url: "http://127.0.0.1:1",
      nativeMockRoute: { ...route, extra: "no" },
    }),
  );
  assert.throws(() =>
    normalizeNativeMockRoute({ ...route, sourceTargetId: "../foreign" }),
  );
  const request = {
    id: "a",
    method: "GET",
    url: "http://127.0.0.1:1/items/{id}",
    nativeMockRoute: route,
  };
  assert.equal(
    resolveNativeMockRoute(
      { requests: [request] },
      "GET",
      "/items/a%2Fb",
      new URLSearchParams(),
    ),
    undefined,
  );
  assert.equal(
    resolveNativeMockRoute(
      { requests: [request] },
      "GET",
      "/items/value",
      new URLSearchParams(),
    ),
    request,
  );
  assert.throws(() =>
    resolveNativeMockRoute(
      { requests: [request] },
      "GET",
      "/items/value",
      new URLSearchParams("target_id=../foreign"),
    ),
  );
});
