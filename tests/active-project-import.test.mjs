import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, executeRequest } from "../src/runtime.mjs";
import {
  ActiveProjectImports,
  normalizeAutoImports,
} from "../src/active-project-import.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "active-import-"));
  const store = new Store(root);
  const project = await store.create("one");
  const other = await store.create("two");
  let response = JSON.stringify({
    openapi: "3.0.3",
    servers: [{ url: "http://example.test" }],
    paths: {
      "/ping": {
        get: { summary: "first", responses: { 200: { description: "OK" } } },
      },
    },
  });
  let requests = 0,
    hold = false,
    pending;
  const server = http.createServer((_req, res) => {
    requests++;
    if (hold) pending = res;
    else res.end(response);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let now = 1000;
  const manager = new ActiveProjectImports({
    store,
    request: executeRequest,
    now: () => now,
  });
  const definition = {
    id: "source-one",
    name: "fixture",
    url: `http://127.0.0.1:${server.address().port}/spec`,
    intervalSeconds: 60,
    enabled: true,
    coverMode: "url_and_folder",
    folder: "",
  };
  project.settings.autoImports = [definition];
  await store.save(project);
  t.after(async () => {
    await manager.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  return {
    store,
    project,
    other,
    manager,
    definition,
    root,
    get requests() {
      return requests;
    },
    setResponse(v) {
      response = v;
    },
    hold() {
      hold = true;
    },
    release() {
      pending?.end(response);
    },
    advance(ms) {
      now += ms;
    },
  };
}

test("source definitions are explicit bounded data and unsupported policies fail closed", () => {
  assert.deepEqual(normalizeAutoImports(undefined), []);
  const good = {
    id: "a",
    name: "A",
    url: "https://example.test/spec",
    enabled: true,
    intervalSeconds: 60,
    folder: "",
    coverMode: "url",
  };
  assert.equal(normalizeAutoImports([good])[0].enabled, true);
  for (const patch of [
    { url: "file:///tmp/spec" },
    { url: "https://user:pass@example.test" },
    { intervalSeconds: 0 },
    { intervalSeconds: 59 },
    { intervalSeconds: 86401 },
    { coverMode: "clear" },
    { coverMode: "both" },
    { enabled: "yes" },
    { headers: { authorization: "secret" } },
  ])
    assert.throws(() => normalizeAutoImports([{ ...good, ...patch }]));
  assert.throws(() => normalizeAutoImports([good, good]));
});

test("real fetch sync persists stable IDs; restart and inactive projects cannot run", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.manager.run(f.project.id, "source-one"), /当前项目/);
  assert.equal(f.requests, 0);
  await f.manager.activate(f.project.id);
  assert.equal(f.requests, 0);
  const first = await f.manager.run(f.project.id, "source-one");
  assert.equal(first.status, "success");
  const a = await f.store.get(f.project.id);
  assert.equal(a.requests.length, 1);
  const id = a.requests[0].id;
  await f.manager.run(f.project.id, "source-one");
  const reloaded = await new Store(f.root).get(f.project.id);
  assert.equal(reloaded.requests.length, 1);
  assert.equal(reloaded.requests[0].id, id);
  assert.equal(reloaded.settings.autoImportRuns.length, 2);
  assert.equal((await f.store.get(f.other.id)).requests.length, 0);
  await f.manager.deactivate(f.project.id);
  await assert.rejects(f.manager.run(f.project.id, "source-one"), /当前项目/);
});

test("scheduled imports use current project only and reopening resets the interval", async (t) => {
  const f = await fixture(t);
  await f.manager.activate(f.project.id);
  f.advance(59999);
  await f.manager.tick();
  assert.equal(f.requests, 0);
  f.advance(1);
  await f.manager.tick();
  assert.equal(f.requests, 1);
  await f.manager.activate(f.other.id);
  f.advance(60000);
  await f.manager.tick();
  assert.equal(f.requests, 1);
  await f.manager.activate(f.project.id);
  await f.manager.tick();
  assert.equal(f.requests, 1);
  f.advance(60000);
  await f.manager.tick();
  assert.equal(f.requests, 2);
});

test("invalid remote documents and missing folders preserve existing project data", async (t) => {
  const f = await fixture(t);
  await f.manager.activate(f.project.id);
  await f.manager.run(f.project.id, "source-one");
  const before = (await f.store.get(f.project.id)).requests;
  f.setResponse("not: [valid");
  await assert.rejects(f.manager.run(f.project.id, "source-one"));
  assert.deepEqual((await f.store.get(f.project.id)).requests, before);
  assert.equal(
    (await f.store.get(f.project.id)).settings.autoImportRuns[0].status,
    "failed",
  );
  const p = await f.store.get(f.project.id);
  p.settings.autoImports[0].folder = "gone";
  await f.store.save(p);
  f.setResponse('{"openapi":"3.0.3","paths":{}}');
  await assert.rejects(f.manager.run(f.project.id, "source-one"), /目录/);
  assert.deepEqual((await f.store.get(f.project.id)).requests, before);
});

test("switching aborts an in-flight request and stale responses cannot import", async (t) => {
  const f = await fixture(t);
  await f.manager.activate(f.project.id);
  f.hold();
  const running = f.manager.run(f.project.id, "source-one");
  const rejected = assert.rejects(running, /取消|中止|abort|当前项目/i);
  while (f.requests === 0) await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(f.manager.run(f.project.id, "source-one"), /正在执行/);
  await f.manager.activate(f.other.id);
  f.release();
  await rejected;
  assert.equal((await f.store.get(f.project.id)).requests.length, 0);
  assert.equal((await f.store.get(f.other.id)).requests.length, 0);
});

test("disabled or edited definitions reject a response already in flight", async (t) => {
  const f = await fixture(t);
  await f.manager.activate(f.project.id);
  f.hold();
  const running = f.manager.run(f.project.id, "source-one");
  const rejected = assert.rejects(running, /配置已变化/);
  while (f.requests === 0) await new Promise((r) => setTimeout(r, 5));
  const p = await f.store.get(f.project.id);
  p.settings.autoImports[0].enabled = false;
  await f.store.save(p);
  f.release();
  await rejected;
  const saved = await f.store.get(f.project.id);
  assert.equal(saved.requests.length, 0);
  assert.equal(saved.settings.autoImports[0].enabled, false);
});

test("cancellation while waiting for the save queue prevents a new disk commit", async (t) => {
  const f = await fixture(t);
  await f.manager.activate(f.project.id);
  let unlock;
  const gate = new Promise((r) => {
    unlock = r;
  });
  f.store.pending = gate;
  let saveReached;
  const reached = new Promise((r) => {
    saveReached = r;
  });
  const save = f.store.save.bind(f.store);
  f.store.save = (p, options) => {
    saveReached();
    return save(p, options);
  };
  const running = f.manager.run(f.project.id, "source-one");
  const rejected = assert.rejects(running, /取消/);
  await reached;
  const stopped = f.manager.activate(f.other.id);
  unlock();
  assert.equal((await stopped).projectId, f.other.id);
  await rejected;
  assert.equal((await f.store.get(f.project.id)).requests.length, 0);
});

test("public HTTP API completes remote YAML import, reload, disable and inactive restart", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "import-api-"));
  let requests = 0;
  const feed = http.createServer((_req, res) => {
    requests++;
    res.end(
      'openapi: 3.0.3\nservers:\n  - url: https://example.test\npaths:\n  /actual:\n    get:\n      responses:\n        "200":\n          description: OK\n',
    );
  });
  await new Promise((r) => feed.listen(0, "127.0.0.1", r));
  let app = await createApp({ root, port: 0 });
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await close();
    feed.closeAllConnections();
    await new Promise((r) => feed.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (url, method = "GET", data, expected = 200) => {
    const response = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  const p = await call("/api/projects", "POST", { name: "sync-api" }, 201);
  const base = `/api/projects/${p.id}`;
  const definition = {
    id: "remote",
    name: "Remote",
    url: `http://127.0.0.1:${feed.address().port}/source`,
    enabled: true,
    intervalSeconds: 60,
    coverMode: "url_and_folder",
    folder: "",
  };
  await call(base + "/auto-imports", "PUT", { definitions: [definition] });
  await call(base + "/auto-import-run", "POST", { sourceId: "remote" }, 400);
  assert.equal(requests, 0);
  await call(base + "/auto-import-session", "POST", { action: "activate" });
  const result = await call(base + "/auto-import-run", "POST", {
    sourceId: "remote",
  });
  assert.equal(result.status, "success");
  const saved = await call(base);
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.settings.autoImportRuns[0].status, "success");
  await call(base + "/auto-imports", "PUT", {
    definitions: [{ ...definition, enabled: false }],
  });
  await call(base + "/auto-import-run", "POST", { sourceId: "remote" }, 400);
  assert.equal(requests, 1);
  await close();
  app = await createApp({ root, port: 0 });
  const reopened = await call(base + "/auto-imports");
  assert.equal(reopened.session.projectId, null);
  assert.equal(reopened.definitions[0].enabled, false);
  assert.equal(reopened.runs.length, 1);
  assert.equal((await call(base)).requests[0].id, saved.requests[0].id);
  await call(base + "/auto-imports", "PUT", {}, 400);
});

test("uncertain save acknowledgement stops scheduling without retrying or claiming rollback", async (t) => {
  const f = await fixture(t);
  await f.manager.activate(f.project.id);
  const save = f.store.save.bind(f.store);
  f.store.save = async (...args) => {
    await save(...args);
    throw Error("simulated lost save acknowledgement");
  };
  await assert.rejects(
    f.manager.run(f.project.id, "source-one"),
    /lost save acknowledgement/,
  );
  assert.equal(f.manager.snapshot().projectId, null);
  assert.match(f.manager.snapshot().warning, /保存结果/);
  // The transaction actually committed, even though its acknowledgement failed.
  assert.equal((await f.store.get(f.project.id)).requests.length, 1);
  f.advance(180000);
  await f.manager.tick();
  assert.equal(f.requests, 1);
});
