import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Store, executeRequest } from "../src/runtime.mjs";
import { ActiveProjectImports } from "../src/active-project-import.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

async function fixture(t, timer = false) {
  const root = await mkdtemp(join(tmpdir(), "import-read-shutdown-"));
  const store = new Store(root);
  const project = await store.create("shutdown fixture");
  let requests = 0;
  const peer = http.createServer((_req, res) => {
    requests++;
    res.end('{"openapi":"3.0.3","paths":{}}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  project.settings.autoImports = [
    {
      id: "source",
      name: "source",
      url: `http://127.0.0.1:${peer.address().port}/spec`,
      intervalSeconds: 60,
      enabled: true,
      coverMode: "url_and_folder",
      folder: "",
    },
  ];
  await store.save(project);
  const before = await store.get(project.id);
  const manager = new ActiveProjectImports({
    store,
    request: executeRequest,
    now: () => 1000,
  });
  if (!timer) clearInterval(manager.timer);
  const unblock = deferred();
  const pending = [];
  const readUnlocked = store.readUnlocked.bind(store);
  t.after(async () => {
    unblock.resolve();
    await Promise.allSettled(pending);
    await manager.close();
    store.readUnlocked = readUnlocked;
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  let reads = 0;
  const originalGet = store.get.bind(store);
  store.get = (...args) => {
    reads++;
    const reading = originalGet(...args);
    pending.push(reading);
    return reading;
  };
  const blockRead = (reject) => {
    const entered = deferred();
    store.readUnlocked = async (...args) => {
      // This is inside the real Store.get project guard. Neither its read nor
      // its eventual lock release is replaced by a fabricated Store response.
      const value = await readUnlocked(...args);
      entered.resolve();
      await unblock.promise;
      if (reject) throw Error("controlled read failure");
      return value;
    };
    return entered.promise;
  };
  return {
    root,
    store,
    project,
    before,
    manager,
    blockRead,
    unblock,
    pending,
    reads: () => reads,
    requests: () => requests,
  };
}

for (const action of ["poll", "activate", "reactivate"])
  for (const reject of [false, true])
    test(`close drains a ${reject ? "failing" : "successful"} locked ${action} read without late state or requests`, async (t) => {
      const f = await fixture(t);
      let lease;
      if (action !== "activate") await f.manager.activate(f.project.id);
      if (action === "reactivate")
        lease = await f.manager.suspend(f.project.id);
      const entered = f.blockRead(reject);
      const operation =
        action === "activate"
          ? f.manager.activate(f.project.id)
          : action === "reactivate"
            ? f.manager.reactivate(lease)
            : f.manager.poll();
      const settled = operation.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      f.pending.push(settled);
      await entered;
      let closed = 0;
      const closing = Promise.all([
        f.manager.close().then(() => closed++),
        f.manager.close().then(() => closed++),
      ]);
      f.pending.push(closing);
      await nextTurn();
      assert.equal(
        closed,
        0,
        "close must retain ownership until the guarded read settles",
      );
      assert.equal(f.manager.snapshot().projectId, null);
      const reads = f.reads();
      await f.manager.poll();
      await f.manager.tick();
      await f.manager.reactivate(lease);
      await assert.rejects(f.manager.activate(f.project.id), /关闭/);
      await assert.rejects(f.manager.run(f.project.id, "source"), /当前项目/);
      assert.equal(
        f.reads(),
        reads,
        "closed manager must not start another read",
      );
      f.unblock.resolve();
      await closing;
      const outcome = await settled;
      if (action === "activate")
        assert.match(
          outcome.error?.message,
          reject ? /controlled read failure/ : /取消/,
        );
      else assert.equal(outcome.error, undefined);
      assert.equal(closed, 2);
      assert.equal(f.requests(), 0);
      assert.deepEqual(f.manager.snapshot().nextRuns, []);
      assert.equal(f.manager.snapshot().projectId, null);
      assert.deepEqual(await new Store(f.root).get(f.project.id), f.before);
    });

test("actual interval poll remains owned by shutdown until its Store guard is released", async (t) => {
  const f = await fixture(t, true);
  await f.manager.activate(f.project.id);
  const entered = f.blockRead(false);
  await entered;
  let closed = false;
  const closing = f.manager.close().then(() => (closed = true));
  f.pending.push(closing);
  await nextTurn();
  assert.equal(closed, false);
  f.unblock.resolve();
  await closing;
  assert.equal(closed, true);
  assert.equal(f.requests(), 0);
  assert.deepEqual(await new Store(f.root).get(f.project.id), f.before);
});
