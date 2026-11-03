import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MCPConfigPublication } from "../src/mcp-config-publication.mjs";
import { loadMCPConfig, saveMCPConfig } from "../src/mcp-config-store.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const initial = () => ({
  enabled: true,
  remember: true,
  projects: ["retained"],
  write: true,
  execute: false,
  token: "a".repeat(64), // fictional, never an account credential
  port: 4318,
});
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let policy = initial();
  await saveMCPConfig(root, policy);
  const state = {
    root,
    get policy() {
      return policy;
    },
    set policy(value) {
      policy = value;
    },
    snapshot: () => (policy.remember ? structuredClone(policy) : null),
  };
  return state;
}

// Only built-in filesystem operations and the policy helper: no app/VM/database.
test("an admitted auxiliary filesystem write precedes disable, rotation and forgetting", async (t) => {
  for (const mode of ["disable", "rotate", "forget"]) {
    const state = await fixture(t);
    const entered = deferred(),
      release = deferred();
    let first = true;
    const queue = new MCPConfigPublication({
      identity: () => state.policy,
      snapshot: state.snapshot,
      write: async (value) => {
        if (first) {
          first = false;
          // Deterministic real filesystem admission evidence, not a timed race.
          await writeFile(path.join(state.root, "writer-entered"), "held");
          entered.resolve();
          await release.promise;
        }
        await saveMCPConfig(state.root, value);
      },
    });
    const old = state.policy;
    old.projects.push("created");
    const auxiliary = queue.persist(old);
    await entered.promise;
    assert.equal(
      await readFile(path.join(state.root, "writer-entered"), "utf8"),
      "held",
    );
    let ownerCompleted = false;
    const owner = queue.run(async () => {
      const next = { ...state.policy, projects: [...state.policy.projects] };
      if (mode === "disable") {
        next.enabled = false;
        next.token = "";
      }
      if (mode === "rotate") next.token = "b".repeat(64);
      if (mode === "forget") next.remember = false;
      await saveMCPConfig(state.root, next);
      state.policy = next;
      ownerCompleted = true;
    });
    await Promise.resolve();
    assert.equal(ownerCompleted, false, "owner may not overtake held writer");
    release.resolve();
    assert.equal(await auxiliary, true);
    await owner;
    assert.equal(
      await queue.persist(old),
      false,
      "obsolete identity cannot resurrect policy",
    );
    const restored = await loadMCPConfig(state.root);
    if (mode === "forget") assert.equal(restored, null);
    else {
      assert.equal(restored.enabled, mode !== "disable");
      assert.equal(
        restored.token === old.token,
        false,
        "old bearer must not survive",
      );
      assert.deepEqual(restored.projects, ["retained", "created"]);
      assert.equal(restored.execute, false);
    }
  }
});

test("old auxiliary queued behind owner is skipped; current same-policy creates are preserved", async (t) => {
  const state = await fixture(t),
    entered = deferred(),
    release = deferred();
  let writes = 0;
  const queue = new MCPConfigPublication({
    identity: () => state.policy,
    snapshot: state.snapshot,
    write: async (value) => {
      writes++;
      await saveMCPConfig(state.root, value);
    },
  });
  const old = state.policy;
  const owner = queue.run(async () => {
    entered.resolve();
    await release.promise;
    const next = { ...old, token: "b".repeat(64), projects: ["retained"] };
    await saveMCPConfig(state.root, next);
    state.policy = next;
  });
  await entered.promise;
  old.projects.push("obsolete-create");
  const stale = queue.persist(old);
  release.resolve();
  await owner;
  assert.equal(await stale, false);
  assert.equal(writes, 0);
  const current = state.policy;
  current.projects.push("created-one");
  const one = queue.persist(current);
  current.projects.push("created-two");
  const two = queue.persist(current);
  assert.deepEqual(await Promise.all([one, two]), [true, true]);
  assert.deepEqual((await loadMCPConfig(state.root)).projects, [
    "retained",
    "created-one",
    "created-two",
  ]);
});

test("failed real rename leaves memory unchanged, cleans temporary file and queue recovers", async (t) => {
  const state = await fixture(t);
  const queue = new MCPConfigPublication({
    identity: () => state.policy,
    snapshot: state.snapshot,
    write: (value) => saveMCPConfig(state.root, value),
  });
  const old = state.policy;
  // Rename over a directory is refused on all supported platforms, without
  // chmod assumptions or production filesystem interception.
  await rm(path.join(state.root, ".mcp-config.json"));
  await mkdir(path.join(state.root, ".mcp-config.json"));
  await assert.rejects(
    queue.run(async () => {
      const next = { ...old, enabled: false, token: "" };
      await saveMCPConfig(state.root, next);
      state.policy = next;
    }),
  );
  assert.equal(state.policy, old);
  assert.equal(
    (await readdir(state.root)).some((name) => name.endsWith(".tmp")),
    false,
  );
  await rm(path.join(state.root, ".mcp-config.json"), { recursive: true });
  await queue.run(async () => {
    const next = { ...old, enabled: false, token: "" };
    await saveMCPConfig(state.root, next);
    state.policy = next;
  });
  assert.equal((await loadMCPConfig(state.root)).enabled, false);
});

test("pre-write failure preserves prior durable bytes and FIFO owner publication recovers", async (t) => {
  const state = await fixture(t);
  const queue = new MCPConfigPublication({
    identity: () => state.policy,
    snapshot: state.snapshot,
    write: (value) => saveMCPConfig(state.root, value),
  });
  const file = path.join(state.root, ".mcp-config.json"),
    ignore = path.join(state.root, ".gitignore");
  const before = await readFile(file),
    old = state.policy;
  await rm(ignore);
  await mkdir(ignore);
  await assert.rejects(
    queue.run(async () => {
      const next = { ...old, enabled: false, token: "" };
      await saveMCPConfig(state.root, next);
      state.policy = next;
    }),
  );
  assert.equal(state.policy, old);
  assert.equal(
    (await readFile(file)).equals(before),
    true,
    "prior durable bytes remain identical",
  );
  assert.equal((await loadMCPConfig(state.root)).token === old.token, true);
  await rm(ignore, { recursive: true });
  const entered = deferred(),
    release = deferred(),
    order = [];
  const first = queue.run(async () => {
    entered.resolve();
    await release.promise;
    const next = { ...state.policy, write: false, execute: false };
    await saveMCPConfig(state.root, next);
    state.policy = next;
    order.push("first");
  });
  await entered.promise;
  const second = queue.run(async () => {
    const next = { ...state.policy, token: "b".repeat(64) };
    await saveMCPConfig(state.root, next);
    state.policy = next;
    order.push("second");
  });
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
  const restored = await loadMCPConfig(state.root);
  assert.equal(restored.write, false);
  assert.equal(restored.token === old.token, false);
});
