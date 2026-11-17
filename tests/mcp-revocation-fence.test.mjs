import test from "node:test";
import assert from "node:assert/strict";
import {
  MCPConfigPublication,
  immediateMCPReduction,
} from "../src/mcp-config-publication.mjs";

const base = () => ({
  enabled: true,
  remember: true,
  projects: ["a", "b"],
  write: true,
  execute: true,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("finite policy states admit only strict capability and project attenuation", () => {
  for (let old = 0; old < 32; old++) {
    const current = {
      enabled: !!(old & 1),
      remember: !!(old & 2),
      write: !!(old & 4),
      execute: !!(old & 4) && !!(old & 8),
      projects: old & 16 ? ["a", "b"] : ["a"],
    };
    for (let next = 0; next < 64; next++) {
      const config = {
        enabled: !!(next & 1),
        remember: !!(next & 2),
        write: !!(next & 4),
        execute: !!(next & 8),
        projects: next & 32 ? ["a", "outside"] : next & 16 ? ["a"] : [],
      };
      const result = immediateMCPReduction(current, config);
      const normalizedExecute = config.write && config.execute;
      const expected =
        config.remember === current.remember &&
        (!config.enabled || current.enabled) &&
        (!config.write || current.write) &&
        (!normalizedExecute || current.execute) &&
        config.projects.every((id) => current.projects.includes(id)) &&
        (config.enabled !== current.enabled ||
          config.write !== current.write ||
          normalizedExecute !== current.execute ||
          config.projects.length < current.projects.length);
      assert.equal(
        result !== null,
        expected,
        JSON.stringify({ current, config }),
      );
      if (result) {
        assert.notEqual(result, current);
        assert.notEqual(result.projects, current.projects);
        assert.notEqual(result.projects, config.projects);
        assert.equal(result.execute, normalizedExecute);
      }
    }
  }
});

test("invalid, mixed, retention and rotation inputs never acquire a partial fence", () => {
  const current = base();
  for (const config of [
    null,
    [],
    { ...current, projects: "a" },
    { ...current, projects: [1] },
    { ...current, projects: ["a", "a"] },
    { ...current, write: "false" },
    { ...current, execute: false, rotate: true },
    { ...current, execute: false, rotate: "false" },
    { ...current, execute: false, remember: false },
    { ...current, execute: false, projects: ["a", "new"] },
  ]) {
    assert.equal(immediateMCPReduction(current, config), null);
    assert.deepEqual(current, base());
  }
});

for (const phase of ["entry", "validation", "write"])
  test(`older publication cannot regrant after a fence at ${phase}`, async () => {
    let policy = base(),
      disk = structuredClone(policy);
    const queue = new MCPConfigPublication({
      identity: () => policy,
      snapshot: () => structuredClone(policy),
      write: async (value) => {
        disk = value;
      },
    });
    const entered = deferred(),
      release = deferred();
    const generation = queue.captureRevocation();
    const old = queue.run(async () => {
      if (phase === "entry") {
        entered.resolve();
        await release.promise;
      }
      queue.assertRevocation(generation);
      if (phase === "validation") {
        entered.resolve();
        await release.promise;
      }
      queue.assertRevocation(generation);
      disk = { ...base(), projects: ["a", "b", "older-grant"] };
      if (phase === "write") {
        entered.resolve();
        await release.promise;
      }
      queue.assertRevocation(generation);
      policy = structuredClone(disk);
    });
    const rejected = assert.rejects(old, /减权请求替代/);
    await entered.promise;
    policy = immediateMCPReduction(policy, { ...policy, execute: false });
    const next = queue.advanceRevocation();
    const saved = queue.run(async () => {
      queue.assertRevocation(next);
      await queue.write(queue.snapshot());
      queue.assertRevocation(next);
    });
    release.resolve();
    await Promise.all([rejected, saved]);
    assert.equal(policy.execute, false);
    assert.equal(disk.execute, false);
    assert.deepEqual(policy.projects, ["a", "b"]);
    assert.deepEqual(disk.projects, ["a", "b"]);
  });

test("normal owner FIFO is not superseded by ordinary policy replacements", async () => {
  let identity = base();
  const queue = new MCPConfigPublication({
    identity: () => identity,
    snapshot: () => identity,
    write: async () => {},
  });
  const generation = queue.captureRevocation();
  const results = await Promise.all(
    [1, 2].map((n) =>
      queue.run(() => {
        queue.assertRevocation(generation);
        identity = { ...identity, projects: [String(n)] };
        return n;
      }),
    ),
  );
  assert.deepEqual(results, [1, 2]);
  assert.deepEqual(identity.projects, ["2"]);
});

test("archive removals and newer reductions survive old create identity and save completion", async () => {
  let policy = base();
  const previous = policy;
  let disk;
  const queue = new MCPConfigPublication({
    identity: () => policy,
    snapshot: () => structuredClone(policy),
    write: async (value) => {
      disk = value;
    },
  });
  const entered = deferred(),
    release = deferred();
  const archive = queue.run(async () => {
    entered.resolve();
    await release.promise;
    policy.projects.splice(policy.projects.indexOf("b"), 1);
    await queue.write(queue.snapshot());
  });
  await entered.promise;
  policy = immediateMCPReduction(policy, { ...policy, execute: false });
  const generation = queue.advanceRevocation();
  previous.projects.push("old-create");
  const staleCreate = queue.persist(previous);
  const save = queue.run(async () => {
    queue.assertRevocation(generation);
    await queue.write(queue.snapshot());
    queue.assertRevocation(generation);
  });
  release.resolve();
  await archive;
  assert.equal(await staleCreate, false);
  await save;
  assert.deepEqual(policy.projects, ["a"]);
  assert.deepEqual(disk.projects, ["a"]);
  assert.equal(disk.execute, false);
});
