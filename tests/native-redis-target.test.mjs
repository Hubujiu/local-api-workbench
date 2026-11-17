import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSessions } from "../src/database-sessions.mjs";

const projectId = "fictional-project";
const bindingId = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
const input = {
  name: "fictional",
  type: "redis",
  host: "127.0.0.1",
  port: 6379,
  database: "2",
  user: "fixture",
  password: "private-value",
  bindingId,
};
function catalog() {
  return {
    id: projectId,
    settings: {
      apipostDatabases: [{ id: bindingId, type: "redis", name: "source" }],
    },
  };
}
const revoked = { code: "NATIVE_WRITE_REVOKED" };

test("native target capture freezes private configuration without publishing secrets or authority", async () => {
  const sessions = new DatabaseSessions({
    resolveProject: async () => catalog(),
  });
  const registered = sessions.register(projectId, input);
  const target = await sessions.captureNativeRedisTarget(projectId, bindingId);
  const direct = await sessions.captureNativeRedisTarget(
    projectId,
    registered.id,
  );
  assert.equal(target.sessionGeneration, direct.sessionGeneration);
  assert.notEqual(target.sessionGeneration, registered.id);
  assert.equal(target.bindingId, bindingId);
  assert.equal(target.config.password, input.password);
  assert.equal(target.signal.aborted, false);
  assert(Object.isFrozen(target));
  assert(Object.isFrozen(target.config));
  assert.throws(() => {
    target.config.host = "changed";
  }, TypeError);
  assert.equal(target.assertLive(), undefined);
  await target.revalidate();
  assert.equal(
    JSON.stringify(sessions.list(projectId)).includes(input.password),
    false,
  );
  assert.equal(
    JSON.stringify(sessions.list(projectId)).includes(target.sessionGeneration),
    false,
  );
  assert.equal(JSON.stringify(registered).includes("controller"), false);
  sessions.close();
});

test("native target rejects wrong project, unbound and unresolved sources without issuing a capability", async () => {
  const sessions = new DatabaseSessions({
    resolveProject: async () => catalog(),
  });
  const registered = sessions.register(projectId, input);
  await assert.rejects(
    sessions.captureNativeRedisTarget("other", registered.id),
    { code: "NATIVE_WRITE_TARGET_INVALID" },
  );
  await assert.rejects(sessions.captureNativeRedisTarget("other", bindingId), {
    code: "NATIVE_WRITE_TARGET_INVALID",
  });
  const unbound = sessions.register(projectId, {
    ...input,
    bindingId: undefined,
  });
  await assert.rejects(
    sessions.captureNativeRedisTarget(projectId, unbound.id),
    { code: "NATIVE_WRITE_TARGET_INVALID" },
  );
  const unresolved = new DatabaseSessions();
  const missing = unresolved.register(projectId, input);
  await assert.rejects(
    unresolved.captureNativeRedisTarget(projectId, missing.id),
    { code: "NATIVE_WRITE_TARGET_INVALID" },
  );
  sessions.close();
  unresolved.close();
});

for (const fields of [
  { host: undefined },
  { host: " localhost " },
  { port: undefined },
  { port: 0 },
  { database: undefined },
  { database: "02" },
  { database: "1024" },
  { password: "x".repeat(8193) },
  { type: "mysql" },
]) {
  test(`native target requires explicit bounded Redis address/configuration: ${Object.keys(fields).join()}/${String(Object.values(fields)[0]).slice(0, 12)}`, async () => {
    const sessions = new DatabaseSessions({
      resolveProject: async () => catalog(),
    });
    const registered = sessions.register(projectId, { ...input, ...fields });
    await assert.rejects(
      sessions.captureNativeRedisTarget(projectId, registered.id),
      { code: "NATIVE_WRITE_TARGET_INVALID" },
    );
    sessions.close();
  });
}

test("native target revoke aborts synchronously and alias reissue cannot revive prior capture", async () => {
  const sessions = new DatabaseSessions({
    resolveProject: async () => catalog(),
  });
  const registered = sessions.register(projectId, input);
  const target = await sessions.captureNativeRedisTarget(projectId, bindingId);
  let observed = false;
  target.signal.addEventListener("abort", () => {
    observed = true;
    assert.throws(() => target.assertLive(), revoked);
  });
  sessions.revoke(projectId, registered.id);
  assert.equal(observed, true);
  assert.throws(() => target.assertLive(), revoked);
  const replacement = sessions.register(projectId, input);
  const next = await sessions.captureNativeRedisTarget(
    projectId,
    replacement.id,
  );
  assert.notEqual(next.sessionGeneration, target.sessionGeneration);
  await assert.rejects(target.revalidate(), revoked);
  assert.equal(next.assertLive(), undefined);
  sessions.close();
});

test("native target source checks reject removed/type-changed sources, while admitted frozen target stays live", async () => {
  let project = catalog();
  const sessions = new DatabaseSessions({
    resolveProject: async () => project,
  });
  sessions.register(projectId, input);
  const target = await sessions.captureNativeRedisTarget(projectId, bindingId);
  project = { ...project, settings: { apipostDatabases: [] } };
  await assert.rejects(target.revalidate());
  assert.equal(
    target.assertLive(),
    undefined,
    "definition edits are admission checks, not explicit active revoke",
  );
  project = catalog();
  project.settings.apipostDatabases[0].type = "mysql";
  await assert.rejects(target.revalidate());
  project = catalog();
  project.settings.apipostDatabases[0].requiresSSH = true;
  await assert.rejects(target.revalidate());
  sessions.close();
});

test("native target rechecks exact identity after awaited source admission", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const sessions = new DatabaseSessions({
    resolveProject: async () => {
      await gate;
      return catalog();
    },
  });
  const registered = sessions.register(projectId, input);
  const pending = sessions.captureNativeRedisTarget(projectId, bindingId);
  sessions.revoke(projectId, registered.id);
  sessions.register(projectId, input);
  release();
  await assert.rejects(pending, revoked);
  sessions.close();
});

test("native target revalidation cannot succeed after revoke during asynchronous lookup", async () => {
  let hold = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const sessions = new DatabaseSessions({
    resolveProject: async () => {
      if (hold) await gate;
      return catalog();
    },
  });
  const registered = sessions.register(projectId, input);
  const target = await sessions.captureNativeRedisTarget(projectId, bindingId);
  hold = true;
  const pending = target.revalidate();
  sessions.revoke(projectId, registered.id);
  release();
  await assert.rejects(pending, revoked);
  sessions.close();
});

test("native target close aborts every captured generation without cancelling unrelated session owners", async () => {
  const one = new DatabaseSessions({ resolveProject: async () => catalog() });
  const other = new DatabaseSessions({ resolveProject: async () => catalog() });
  one.register(projectId, input);
  other.register(projectId, input);
  const first = await one.captureNativeRedisTarget(projectId, bindingId);
  const second = await other.captureNativeRedisTarget(projectId, bindingId);
  one.close();
  assert.equal(first.signal.aborted, true);
  assert.throws(() => first.assertLive(), revoked);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.assertLive(), undefined);
  other.close();
});
