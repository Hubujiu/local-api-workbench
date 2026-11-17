import nodeTest from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, executeRequest } from "../src/runtime.mjs";
import { ActiveProjectImports } from "../src/active-project-import.mjs";
import { createApp } from "../src/server.mjs";

const test = (name, run) => nodeTest(name, { timeout: 15000 }, run);
const heldCalls = new WeakMap();

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

// Only the selected real Store call is gated. Subsequent calls keep using the
// original implementation, so explicit stop/activate requests can overtake it.
function gateCall(store, method, { after = false, match = () => true } = {}) {
  const original = store[method].bind(store);
  const entered = deferred();
  const release = deferred();
  if (!heldCalls.has(store)) heldCalls.set(store, []);
  heldCalls.get(store).push(() => release.resolve());
  store[method] = async (...args) => {
    if (!match(...args)) return original(...args);
    store[method] = original;
    const result = after ? await original(...args) : undefined;
    entered.resolve();
    await release.promise;
    return after ? result : original(...args);
  };
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    fail: () => release.reject(Error("gated store failure")),
  };
}

async function fixture(t, { api = false, auth = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "import-ownership-"));
  const seen = [];
  let held = null;
  let status = 200;
  let requestEntered = null;
  const document = JSON.stringify({
    openapi: "3.0.3",
    paths: { "/owned": { get: { responses: { 200: { description: "OK" } } } } },
  });
  const feed = http.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.statusCode = status;
    if (requestEntered) {
      held = res;
      requestEntered.resolve();
      requestEntered = null;
    } else res.end(document);
  });
  await new Promise((resolve) => feed.listen(0, "127.0.0.1", resolve));
  const app = api ? await createApp({ root, port: 0 }) : null;
  const store = app?.store ?? new Store(root);
  const a = await store.create("A");
  const b = await store.create("B");
  const definition = {
    id: "feed",
    name: "feed",
    url: `http://127.0.0.1:${feed.address().port}/spec`,
    enabled: true,
    intervalSeconds: 60,
    folder: "",
    coverMode: "url_and_folder",
    ...(auth ? { authType: "bearer" } : {}),
  };
  for (const project of [a, b]) {
    project.settings.autoImports = [definition];
    await store.save(project);
  }
  let now = 1000;
  const manager = api
    ? null
    : new ActiveProjectImports({
        store,
        request: executeRequest,
        now: () => now,
      });
  // Exercise the actual controller deterministically, not the wall-clock loop.
  if (manager) clearInterval(manager.timer);
  const call = async (
    project,
    suffix = "",
    method = "GET",
    data,
    status = 200,
  ) => {
    const response = await fetch(
      app.url + `/api/projects/${project.id}` + suffix,
      {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      },
    );
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  t.after(async () => {
    for (const release of heldCalls.get(store) ?? []) release();
    held?.end(document);
    if (manager) await manager.close();
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    feed.closeAllConnections();
    await new Promise((resolve) => feed.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    app,
    store,
    a,
    b,
    definition,
    manager,
    seen,
    call,
    credentials: (token) => (auth ? { feed: { type: "bearer", token } } : {}),
    advance: () => {
      now += 60000;
    },
    hold: () => {
      requestEntered = deferred();
      return requestEntered.promise;
    },
    release: () => held?.end(document),
    failResponse: () => {
      status = 500;
    },
    session: async () => (await call(a, "/auto-imports")).session,
    activate: (project, token = "old") =>
      call(project, "/auto-import-session", "POST", {
        action: "activate",
        credentials: auth ? { feed: { type: "bearer", token } } : {},
      }),
    stop: (project) =>
      call(project, "/auto-import-session", "POST", { action: "deactivate" }),
    run: (project, status = 200) =>
      call(project, "/auto-import-run", "POST", { sourceId: "feed" }, status),
    edit: async (kind, definitions, status = 200) => {
      if (kind === "sources")
        return call(a, "/auto-imports", "PUT", { definitions }, status);
      const project = await store.get(a.id);
      project.settings.autoImports = definitions;
      return call(a, "", "PUT", project, status);
    },
  };
}

for (const phase of ["pending", "suspended", "resuming"]) {
  for (const target of ["same", "other"]) {
    test(`targeted stop ${target} respects ${phase} owner with active=null`, async (t) => {
      const f = await fixture(t);
      let pending, gate;
      if (phase !== "pending") await f.manager.activate(f.a.id);
      if (phase === "pending") {
        gate = gateCall(f.store, "get", { after: true });
        pending = f.manager.activate(f.a.id);
      } else {
        const lease = await f.manager.suspend(f.a.id);
        if (phase === "resuming")
          gate = gateCall(f.store, "get", { after: true });
        pending = phase === "resuming" ? f.manager.reactivate(lease) : lease;
      }
      const rejected =
        phase === "pending" && target === "same"
          ? assert.rejects(pending, /取消/)
          : null;
      if (gate) await gate.entered;
      assert.equal(f.manager.snapshot().projectId, null);
      await f.manager.deactivate(target === "same" ? f.a.id : f.b.id);
      gate?.release();
      if (phase === "suspended") await f.manager.reactivate(pending);
      else if (rejected) await rejected;
      else await pending;
      assert.equal(
        f.manager.snapshot().projectId,
        target === "same" ? null : f.a.id,
      );
      assert.equal(f.seen.length, 0);
    });
  }
}

test("opaque leases are single-use and successful unchanged save resumes exactly once", async (t) => {
  const f = await fixture(t);
  await f.manager.activate(f.a.id);
  const lease = await f.manager.suspend(f.a.id);
  let reads = 0;
  const get = f.store.get.bind(f.store);
  f.store.get = (...args) => {
    reads++;
    return get(...args);
  };
  for (const invalid of [undefined, null, {}, f.a.id, { ...lease }])
    await f.manager.reactivate(invalid);
  assert.equal(reads, 0);
  await f.store.save(await get(f.a.id));
  const gate = gateCall(f.store, "get", { after: true });
  const resumed = f.manager.reactivate(lease);
  await gate.entered;
  await f.manager.reactivate(lease);
  assert.equal(reads, 1);
  gate.release();
  await resumed;
  const snapshot = f.manager.snapshot();
  await f.manager.reactivate(lease);
  f.manager.discard(lease);
  assert.deepEqual(f.manager.snapshot(), snapshot);
  assert.equal(reads, 1);
  assert.equal(snapshot.nextRuns.length, 1);
  f.advance();
  await f.manager.tick();
  await f.manager.tick();
  assert.equal(f.seen.length, 1);
  assert.equal((await get(f.a.id)).settings.autoImportRuns.length, 1);
});

for (const next of ["switch", "stop", "credentials", "close"]) {
  for (const failedRead of [false, true]) {
    test(`delayed authenticated resume ${failedRead ? "failure" : "success"} cannot overwrite ${next}`, async (t) => {
      const f = await fixture(t, { auth: true });
      await f.manager.activate(f.a.id, f.credentials("old"));
      const lease = await f.manager.suspend(f.a.id);
      const gate = gateCall(f.store, "get", { after: true });
      const resumed = f.manager.reactivate(lease);
      await gate.entered;
      if (next === "switch")
        await f.manager.activate(f.b.id, f.credentials("fresh"));
      if (next === "stop") await f.manager.deactivate(f.a.id);
      if (next === "credentials")
        await f.manager.activate(f.a.id, f.credentials("fresh"));
      // Shutdown now drains this owned read; release the gate before awaiting it.
      const closing = next === "close" ? f.manager.close() : undefined;
      const snapshot = f.manager.snapshot();
      if (failedRead) gate.fail();
      else gate.release();
      await resumed;
      await closing;
      f.manager.discard(lease);
      assert.deepEqual(f.manager.snapshot(), snapshot);
      assert.equal(f.seen.length, 0);
      if (next === "switch" || next === "credentials") {
        await f.manager.run(next === "switch" ? f.b.id : f.a.id, "feed");
        assert.equal(f.seen.length, 1);
        assert.equal(f.seen[0].authorization, "Bearer fresh");
      }
    });
  }
}

test("superseding saves retire old leases, source removal rereads durable configuration", async (t) => {
  const f = await fixture(t);
  await f.manager.activate(f.a.id);
  const first = await f.manager.suspend(f.a.id);
  const second = await f.manager.suspend(f.a.id);
  await f.manager.reactivate(first);
  f.manager.discard(first);
  assert.equal(f.manager.snapshot().projectId, null);
  const project = await f.store.get(f.a.id);
  project.settings.autoImports = [];
  await f.store.save(project);
  await f.manager.reactivate(second);
  assert.equal(f.manager.snapshot().projectId, f.a.id);
  assert.deepEqual(f.manager.snapshot().nextRuns, []);
  await assert.rejects(f.manager.run(f.a.id, "feed"), /未启用/);
  assert.equal(f.seen.length, 0);
});

test("close while activation is reading cannot install a late schedule", async (t) => {
  const f = await fixture(t);
  const gate = gateCall(f.store, "get", { after: true });
  const activation = f.manager.activate(f.a.id);
  const rejected = assert.rejects(activation, /取消/);
  await gate.entered;
  const closing = f.manager.close();
  gate.release();
  await closing;
  await rejected;
  assert.equal(f.manager.snapshot().projectId, null);
  assert.deepEqual(f.manager.snapshot().nextRuns, []);
  assert.equal(f.seen.length, 0);
});

for (const kind of ["project", "sources"]) {
  for (const next of [
    "switch",
    "stop",
    "credentials",
    "unchanged",
    "failure",
  ]) {
    test(`HTTP ${kind} save lease preserves ${next} intent across Store.save await`, async (t) => {
      const auth = next === "credentials";
      const f = await fixture(t, { api: true, auth });
      await f.activate(f.a);
      const definitions = [{ ...f.definition, name: "saved configuration" }];
      const gate = gateCall(f.store, "save", { after: next === "credentials" });
      const editing = f.edit(kind, definitions, next === "failure" ? 400 : 200);
      await gate.entered;
      assert.equal((await f.session()).projectId, null);
      if (next === "switch") await f.activate(f.b);
      if (next === "stop") await f.stop(f.a);
      if (next === "credentials") await f.activate(f.a, "fresh");
      const snapshot = await f.session();
      if (next === "failure") gate.fail();
      else gate.release();
      await editing;
      const session = await f.session();
      if (next !== "unchanged") assert.deepEqual(session, snapshot);
      else {
        assert.equal(session.projectId, f.a.id);
        assert.equal(session.nextRuns.length, 1);
      }
      assert.equal(f.seen.length, 0);
      if (["switch", "credentials", "unchanged"].includes(next)) {
        await f.run(next === "switch" ? f.b : f.a);
        assert.equal(f.seen.length, 1);
        if (auth) assert.equal(f.seen[0].authorization, "Bearer fresh");
      } else {
        await f.run(f.a, 400);
        assert.equal(f.seen.length, 0);
      }
      assert.equal(
        (await f.store.get(f.a.id)).requests.length,
        ["credentials", "unchanged"].includes(next) ? 1 : 0,
      );
    });
  }
}

for (const kind of ["project", "sources"]) {
  test(`HTTP ${kind} save failure cannot discard a newer activation`, async (t) => {
    const f = await fixture(t, { api: true, auth: true });
    await f.activate(f.a);
    const gate = gateCall(f.store, "save");
    const editing = f.edit(
      kind,
      [{ ...f.definition, name: "failed change" }],
      400,
    );
    await gate.entered;
    await f.activate(f.a, "fresh");
    const snapshot = await f.session();
    gate.fail();
    await editing;
    assert.deepEqual(await f.session(), snapshot);
    await f.run(f.a);
    assert.equal(f.seen[0].authorization, "Bearer fresh");
  });
}

for (const mutation of ["archive", "remove"]) {
  test(`HTTP ${mutation} invalidates a pending activation, even while active=null`, async (t) => {
    const f = await fixture(t, { api: true });
    const get = f.store.get.bind(f.store);
    let reads = 0;
    const gate = gateCall(f.store, "get", {
      after: true,
      match: (id) => id === f.a.id && ++reads === 2,
    });
    const activating = f.call(
      f.a,
      "/auto-import-session",
      "POST",
      { action: "activate" },
      400,
    );
    await gate.entered;
    if (mutation === "archive") {
      const project = await get(f.a.id);
      project.archived = true;
      await f.call(f.a, "", "PUT", project);
    } else await f.edit("sources", []);
    gate.release();
    await activating;
    const session = await f.session();
    assert.equal(session.projectId, mutation === "archive" ? null : f.a.id);
    assert.deepEqual(session.nextRuns, []);
    await f.run(f.a, 400);
    assert.equal(f.seen.length, 0);
  });
}

test("HTTP archive during a suspended save retires its resume even if the old save fails", async (t) => {
  const f = await fixture(t, { api: true });
  await f.activate(f.a);
  const gate = gateCall(f.store, "save");
  const editing = f.edit("sources", [{ ...f.definition, name: "stale" }], 400);
  await gate.entered;
  const project = await f.store.get(f.a.id);
  project.archived = true;
  await f.call(f.a, "", "PUT", project);
  gate.release();
  await editing;
  assert.equal((await f.session()).projectId, null);
  await f.run(f.a, 400);
  assert.equal(f.seen.length, 0);
});

test("suspension drains a real aborted request before resuming and cannot commit the old result", async (t) => {
  const f = await fixture(t);
  await f.manager.activate(f.a.id);
  const reached = f.hold();
  const running = f.manager.run(f.a.id, "feed");
  const rejected = assert.rejects(running, /取消|abort/i);
  await reached;
  const lease = await f.manager.suspend(f.a.id);
  await rejected;
  assert.equal(f.manager.snapshot().running, false);
  f.release();
  await f.manager.reactivate(lease);
  await f.manager.run(f.a.id, "feed");
  assert.equal(f.seen.length, 2);
  const project = await f.store.get(f.a.id);
  assert.equal(project.requests.length, 1);
  assert.equal(project.settings.autoImportRuns.length, 1);
});

for (const committed of [false, true]) {
  test(`a late unknown run-save failure (${committed ? "committed" : "not committed"}) cannot invalidate pending B`, async (t) => {
    const f = await fixture(t);
    await f.manager.activate(f.a.id);
    const gate = gateCall(f.store, "save", { after: committed });
    const running = f.manager.run(f.a.id, "feed");
    const rejected = assert.rejects(running, /gated store failure/);
    await gate.entered;
    const activation = f.manager.activate(f.b.id);
    gate.fail();
    await rejected;
    await activation;
    assert.equal(f.manager.snapshot().projectId, f.b.id);
    assert.equal(f.manager.snapshot().warning, "");
    await f.manager.run(f.b.id, "feed");
    assert.equal(f.seen.length, 2);
    assert.equal(
      (await f.store.get(f.a.id)).requests.length,
      committed ? 1 : 0,
    );
  });
}

for (const kind of ["project", "sources"]) {
  for (const next of ["switch", "stop", "credentials"]) {
    for (const failedRead of [false, true]) {
      test(`HTTP ${kind} delayed resume ${failedRead ? "failure" : "auth warning"} preserves ${next}`, async (t) => {
        const f = await fixture(t, { api: true, auth: true });
        await f.activate(f.a);
        const save = gateCall(f.store, "save", { after: true });
        const editing = f.edit(kind, [{ ...f.definition, name: "updated" }]);
        await save.entered;
        const read = gateCall(f.store, "get", { after: true });
        save.release();
        await read.entered;
        if (next === "switch") await f.activate(f.b, "fresh");
        if (next === "stop") await f.stop(f.a);
        if (next === "credentials") await f.activate(f.a, "fresh");
        const snapshot = await f.session();
        if (failedRead) read.fail();
        else read.release();
        await editing;
        assert.deepEqual(await f.session(), snapshot);
        assert.equal(f.seen.length, 0);
        if (next === "stop") await f.run(f.a, 400);
        else {
          await f.run(next === "switch" ? f.b : f.a);
          assert.equal(f.seen.length, 1);
          assert.equal(f.seen[0].authorization, "Bearer fresh");
        }
      });
    }
  }
}

for (const kind of ["project", "sources"]) {
  test(`HTTP overlapping ${kind} saves let only the newest lease resume`, async (t) => {
    const f = await fixture(t, { api: true });
    await f.activate(f.a);
    const firstSave = gateCall(f.store, "save", { after: true });
    const first = f.edit(kind, [{ ...f.definition, name: "first" }]);
    await firstSave.entered;
    const secondSave = gateCall(f.store, "save");
    const second = f.edit(kind, []);
    await secondSave.entered;
    firstSave.release();
    await first;
    assert.equal((await f.session()).projectId, null);
    assert.equal(f.seen.length, 0);
    secondSave.release();
    await second;
    const session = await f.session();
    assert.equal(session.projectId, f.a.id);
    assert.deepEqual(session.nextRuns, []);
    await f.run(f.a, 400);
    assert.equal(f.seen.length, 0);
  });
}

test("ordinary project metadata save keeps its authenticated activation and schedule", async (t) => {
  const f = await fixture(t, { api: true, auth: true });
  await f.activate(f.a, "fresh");
  const snapshot = await f.session();
  const project = await f.store.get(f.a.id);
  project.name = "renamed only";
  await f.call(f.a, "", "PUT", project);
  assert.deepEqual(await f.session(), snapshot);
  await f.run(f.a);
  assert.equal(f.seen[0].authorization, "Bearer fresh");
});

test("activation admitted during an archive write cannot fetch after its durable commit", async (t) => {
  const f = await fixture(t);
  await f.manager.activate(f.a.id);
  await f.manager.deactivate(f.a.id);
  const project = await f.store.get(f.a.id);
  project.archived = true;
  const gate = gateCall(f.store, "save");
  const saving = f.store.save(project);
  await gate.entered;
  await f.manager.activate(f.a.id);
  gate.release();
  await saving;
  // No post-save global stop: a newer explicit activation can remain visible
  // until tick, but both run-now and tick reread archive state before fetching.
  assert.equal(f.manager.snapshot().projectId, f.a.id);
  await assert.rejects(f.manager.run(f.a.id, "feed"), /归档/);
  assert.equal(f.seen.length, 0);
  await f.manager.tick();
  assert.equal(f.manager.snapshot().projectId, null);
  assert.deepEqual(f.manager.snapshot().nextRuns, []);
  assert.equal(f.seen.length, 0);
});

test("cancelled queued failure-history save cannot make a late commit", async (t) => {
  const f = await fixture(t);
  await f.manager.activate(f.a.id);
  f.failResponse();
  const gate = gateCall(f.store, "save", {
    match: (_p, options) => options?.activity === true,
  });
  const running = f.manager.run(f.a.id, "feed");
  const rejected = assert.rejects(running, /HTTP状态/);
  await gate.entered;
  const stopping = f.manager.deactivate(f.a.id);
  gate.release();
  await rejected;
  await stopping;
  const project = await f.store.get(f.a.id);
  assert.equal(project.requests.length, 0);
  assert.equal(project.settings.autoImportRuns, undefined);
  assert.equal(f.seen.length, 1);
});
