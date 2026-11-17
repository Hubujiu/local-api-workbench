import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  chmod,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fork } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";
import { writeProject } from "../src/project-files.mjs";
const permissions = process.platform !== "win32" && process.getuid?.() !== 0;
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "project-creation-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "registry"),
    custom = path.join(home, "custom");
  await mkdir(custom);
  return { home, root, custom, store: new Store(root) };
}
async function intent(root, projects) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, ".creations.json"),
    JSON.stringify({ version: 1, projects }),
  );
}
async function pending(root) {
  return JSON.parse(await readFile(path.join(root, ".creations.json"), "utf8"))
    .projects;
}
const emptyProject = (id, name = "reserved") => ({
  id,
  name,
  version: 1,
  revision: 1,
  configRevision: 1,
  requests: [],
  environments: [],
  plans: [],
  cases: [],
  protocols: [],
  settings: {},
});

test(
  "owner POST unwritable custom base fails before registration and does not poison restart or next creation",
  { skip: !permissions },
  async (t) => {
    const { root, custom } = await fixture(t),
      app = await createApp({ root, port: 0 });
    t.after(async () => {
      await chmod(custom, 0o700).catch(() => {});
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
    });
    await chmod(custom, 0o500);
    const response = await fetch(app.url + "/api/projects", {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "denied", directory: custom }),
    });
    assert.equal(response.status, 400);
    assert.notEqual((await response.json()).code, "PROJECT_COMMIT_UNCERTAIN");
    assert.deepEqual(await readdir(custom), []);
    assert.deepEqual(await app.store.list(), []);
    const restart = new Store(root);
    assert.deepEqual(await restart.list(), []);
    assert.equal((await restart.create("next")).name, "next");
  },
);

test(
  "definite pre-journal failure retires only its intent, preserving user directory data",
  { skip: !permissions },
  async (t) => {
    const { root, custom, store } = await fixture(t);
    const read = store.readUnlocked.bind(store);
    let key;
    store.readUnlocked = async (id, base) => {
      key = id;
      try {
        return await read(id, base);
      } finally {
        await writeFile(path.join(base, id, "keep.txt"), "user data");
        await chmod(path.join(base, id), 0o500);
      }
    };
    await assert.rejects(
      store.create("blocked", custom),
      (e) => e.code === "EACCES",
    );
    await chmod(path.join(custom, key), 0o700);
    assert.equal(
      await readFile(path.join(custom, key, "keep.txt"), "utf8"),
      "user data",
    );
    assert.deepEqual(await pending(root), {});
    assert.deepEqual(await new Store(root).list(), []);
    assert.equal((await new Store(root).create("next", custom)).name, "next");
  },
);

test("custom, explicit-root and ordinary creation persist independently and absent registry clears stale locations", async (t) => {
  const { root, custom, store } = await fixture(t);
  const p = await store.create("custom", custom),
    q = await store.create("root", root),
    r = await store.create("default");
  const restart = new Store(root);
  assert.deepEqual(
    (await restart.list()).map((x) => x.id).sort(),
    [p.id, q.id, r.id].sort(),
  );
  assert.equal((await restart.get(p.id)).revision, 1);
  assert.equal(restart.directory(p.id), path.join(custom, p.id));
  await rm(path.join(root, ".locations.json"));
  await restart.init();
  assert.equal(restart.directory(p.id), path.join(root, p.id));
});

test("a second Store cannot observe an incomplete registration during a fixed create interleaving", async (t) => {
  const { root, custom, store } = await fixture(t),
    other = new Store(root);
  const reached = Promise.withResolvers(),
    resume = Promise.withResolvers(),
    read = store.readUnlocked.bind(store);
  store.readUnlocked = async (id, base) => {
    reached.resolve(id);
    await resume.promise;
    return read(id, base);
  };
  const first = store.create("first", custom);
  await reached.promise;
  let listed = false,
    created = false;
  const listing = other.list().then((p) => {
    listed = true;
    return p;
  });
  const second = other.create("second", custom).then((p) => {
    created = true;
    return p;
  });
  await delay(40);
  assert.equal(listed, false);
  assert.equal(created, false);
  resume.resolve();
  const [p, q, list] = await Promise.all([first, second, listing]);
  assert.notEqual(p.id, q.id);
  assert(list.every((p) => !p.error));
  assert.deepEqual(
    (await new Store(root).list()).map((p) => p.id).sort(),
    [p.id, q.id].sort(),
  );
});

test("uncertain custom creation remains registered, blocks concurrent creation and recovers exactly once", async (t) => {
  const { root, custom, store } = await fixture(t),
    other = new Store(root);
  const reached = Promise.withResolvers(),
    resume = Promise.withResolvers(),
    read = store.readUnlocked.bind(store);
  let key;
  store.readUnlocked = async (id, base) => {
    key = id;
    await writeFile(path.join(base, id, "apis"), "blocked");
    reached.resolve();
    await resume.promise;
    return read(id, base);
  };
  const first = assert.rejects(
    store.create("recover me", custom),
    (e) => e.code === "PROJECT_COMMIT_UNCERTAIN" && e.projectId === key,
  );
  await reached.promise;
  const second = assert.rejects(other.create("unsafe second", custom), {
    code: "PROJECT_RECOVERY_REQUIRED",
  });
  resume.resolve();
  await Promise.all([first, second]);
  const restart = new Store(root),
    listing = await restart.list();
  assert.equal(listing.length, 1);
  assert.equal(listing[0].id, key);
  assert(listing[0].error);
  await rm(path.join(custom, key, "apis"));
  assert.equal((await restart.get(key)).name, "recover me");
  assert.equal((await restart.get(key)).revision, 1);
  assert.equal((await restart.list()).length, 1);
});

test("post-commit registry publication failure preserves durable intent and uncertain identity", async (t) => {
  const { root, custom, store } = await fixture(t),
    read = store.readUnlocked.bind(store);
  let key;
  store.readUnlocked = async (id, base) => {
    key = id;
    await mkdir(path.join(root, ".locations.json"));
    return read(id, base);
  };
  await assert.rejects(
    store.create("committed", custom),
    (e) => e.code === "PROJECT_COMMIT_UNCERTAIN" && e.projectId === key,
  );
  assert.equal((await pending(root))[key], custom);
  assert.equal(
    JSON.parse(await readFile(path.join(custom, key, "project.json"), "utf8"))
      .name,
    "committed",
  );
  await rm(path.join(root, ".locations.json"), { recursive: true });
  const restart = new Store(root);
  assert.equal((await restart.get(key)).name, "committed");
  assert.deepEqual(await pending(root), {});
  assert.equal((await restart.list()).length, 1);
});

test("post-commit registry lock cleanup failure retains typed uncertainty and the completed project", async (t) => {
  const { root, custom, store } = await fixture(t),
    read = store.readUnlocked.bind(store);
  let key;
  store.readUnlocked = async (id, base) => {
    key = id;
    await writeFile(
      path.join(root, ".registry.lock", "owner.json"),
      "broken test-owned lock",
    );
    return read(id, base);
  };
  await assert.rejects(
    store.create("committed", custom),
    (e) => e.code === "PROJECT_COMMIT_UNCERTAIN" && e.projectId === key,
  );
  await rm(path.join(root, ".registry.lock"), { recursive: true });
  assert.equal((await new Store(root).get(key)).name, "committed");
});

test("pending intent never erases a published registration when committed data becomes unavailable", async (t) => {
  const { root, custom, store } = await fixture(t),
    key = "registered";
  await intent(root, { [key]: custom });
  await writeFile(
    path.join(root, ".locations.json"),
    JSON.stringify({ [key]: custom }),
  );
  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, key);
  assert(list[0].error);
  await assert.rejects(store.create("unsafe"), {
    code: "PROJECT_RECOVERY_REQUIRED",
  });
  assert.equal(
    JSON.parse(await readFile(path.join(root, ".locations.json"), "utf8"))[key],
    custom,
  );
});

test("malformed or conflicting creation intent is retained rather than treated as an absent project", async (t) => {
  const { root, custom, store } = await fixture(t);
  await intent(root, { bad: "relative" });
  const bad = await readFile(path.join(root, ".creations.json"), "utf8");
  await assert.rejects(store.list(), /登记格式/);
  assert.equal(await readFile(path.join(root, ".creations.json"), "utf8"), bad);
  await intent(root, { collision: custom });
  await writeFile(
    path.join(root, ".locations.json"),
    JSON.stringify({ collision: root }),
  );
  await assert.rejects(store.list(), /位置冲突/);
  assert.equal((await pending(root)).collision, custom);
});

test("generated ID collision cannot overwrite an unregistered custom project or user directory", async (t) => {
  const { root, custom, store } = await fixture(t),
    key = "occupied-project";
  await writeProject(
    path.join(custom, key),
    emptyProject(key, "existing project"),
  );
  const before = await readFile(path.join(custom, key, "project.json"), "utf8");
  const original = crypto.randomUUID;
  crypto.randomUUID = () => key;
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.create("overwrite", custom), /已存在/);
  } finally {
    crypto.randomUUID = original;
    syncBuiltinESMExports();
  }
  assert.equal(
    await readFile(path.join(custom, key, "project.json"), "utf8"),
    before,
  );
  assert.deepEqual(await new Store(root).list(), []);
});

for (const phase of ["before-journal", "journal", "applied"])
  test(`process interruption at ${phase} reconciles intent without removing user data`, async (t) => {
    const { root, custom } = await fixture(t);
    const child = fork(
      new URL("./fixtures/project-creation-child.mjs", import.meta.url),
      [root, custom, phase],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    const ready = await Promise.race([
      once(child, "message").then(([value]) => value),
      once(child, "exit").then(() => {
        throw Error(stderr || "child exited before fixture was ready");
      }),
    ]);
    assert.equal(ready.phase, phase);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const restart = new Store(root),
      list = await restart.list();
    assert.equal(
      await readFile(path.join(custom, ready.id, "keep.txt"), "utf8"),
      "user data",
    );
    if (phase === "before-journal") {
      assert.deepEqual(list, []);
      await restart.create("next", custom);
    } else {
      assert.equal(list.length, 1);
      assert.equal(list[0].id, ready.id);
      if (phase === "journal") {
        assert(list[0].error);
        await rm(path.join(custom, ready.id, "apis"));
      }
      assert.equal((await restart.get(ready.id)).name, "interrupted");
      assert.equal((await restart.get(ready.id)).revision, 1);
    }
    assert.deepEqual(await pending(root), {});
  });

test("an interrupted custom creation with unknown lock does not prevent server restart or healthy project reads", async (t) => {
  const { root, custom, store } = await fixture(t),
    healthy = await store.create("healthy"),
    key = "pending-unknown-lock";
  await mkdir(path.join(custom, key));
  await intent(root, { [key]: custom });
  const lock = path.join(custom, key + ".json.lock");
  await mkdir(lock);
  await writeFile(path.join(lock, "owner.json"), "unknown test-owned lock");
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  });
  assert.equal((await app.store.get(healthy.id)).name, "healthy");
  const list = await app.store.list();
  assert.equal(list.length, 2);
  assert(list.find((p) => p.id === key).error);
  await assert.rejects(app.store.create("unsafe"), {
    code: "PROJECT_RECOVERY_REQUIRED",
  });
  assert.equal((await pending(root))[key], custom);
  assert.equal(
    await readFile(path.join(lock, "owner.json"), "utf8"),
    "unknown test-owned lock",
  );
  await rm(lock, { recursive: true });
  assert.equal((await app.store.list()).length, 1);
});

test(
  "unreadable pending custom directory is retained while unrelated healthy projects remain usable",
  { skip: !permissions },
  async (t) => {
    const { root, custom, store } = await fixture(t),
      healthy = await store.create("healthy"),
      key = "pending-denied";
    await mkdir(path.join(custom, key));
    await intent(root, { [key]: custom });
    await chmod(path.join(custom, key), 0o000);
    try {
      const restart = new Store(root);
      assert.equal((await restart.get(healthy.id)).name, "healthy");
      healthy.name = "healthy saved";
      await restart.save(healthy);
      assert.equal((await restart.get(healthy.id)).name, "healthy saved");
      await assert.rejects(restart.save({ ...healthy, id: key }), {
        code: "PROJECT_RECOVERY_REQUIRED",
      });
      assert.equal((await pending(root))[key], custom);
      assert((await restart.list()).find((p) => p.id === key).error);
      await assert.rejects(restart.create("unsafe"), {
        code: "PROJECT_RECOVERY_REQUIRED",
      });
    } finally {
      await chmod(path.join(custom, key), 0o700);
    }
    assert.equal((await new Store(root).list()).length, 1);
  },
);

test("complete custom commit followed by failed readback retains identity and does not replay", async (t) => {
  const { root, custom, store } = await fixture(t),
    read = store.readUnlocked.bind(store);
  let key,
    moved = false;
  const originalReadFile = filesystem.readFile;
  store.readUnlocked = async (id, base) => {
    key = id;
    return read(id, base);
  };
  // Test-only synchronization at the exact post-journal read boundary. Rename
  // real metadata, then perform the original filesystem read to produce ENOENT.
  // Unlike fs.watch, this cannot race ahead of or behind the final readback.
  filesystem.readFile = async (file, ...args) => {
    if (
      key &&
      !moved &&
      file === path.join(custom, key, "project.json") &&
      existsSync(file) &&
      !existsSync(path.join(custom, key, ".transaction.json"))
    ) {
      renameSync(file, path.join(custom, key, "readback-fixture.json"));
      moved = true;
    }
    return originalReadFile(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      store.create("readback committed", custom),
      (error) => {
        assert.equal(error.code, "PROJECT_COMMIT_UNCERTAIN");
        assert.equal(error.projectId, key);
        assert.equal(error.cause.code, "ENOENT");
        assert.equal(error.cause.path, path.join(custom, key, "project.json"));
        return true;
      },
    );
  } finally {
    filesystem.readFile = originalReadFile;
    syncBuiltinESMExports();
  }
  assert.equal(moved, true);
  await assert.rejects(readFile(path.join(custom, key, ".transaction.json")), {
    code: "ENOENT",
  });
  const applied = JSON.parse(
    await readFile(path.join(custom, key, "readback-fixture.json"), "utf8"),
  );
  assert.equal(applied.name, "readback committed");
  assert.equal(applied.revision, 1);
  assert.equal(
    JSON.parse(await readFile(path.join(root, ".locations.json"), "utf8"))[key],
    custom,
  );
  renameSync(
    path.join(custom, key, "readback-fixture.json"),
    path.join(custom, key, "project.json"),
  );
  const restart = new Store(root);
  assert.equal((await restart.get(key)).revision, 1);
  assert.equal((await restart.list()).length, 1);
});
