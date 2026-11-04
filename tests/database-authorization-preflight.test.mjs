import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { MCPDatabaseGrants } from "../src/mcp-database-grants.mjs";

const bindingId = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
const project = () => ({
  id: "p",
  settings: { apipostDatabases: [{ id: bindingId, type: "redis" }] },
});
const config = { name: "fixture", type: "redis", host: "127.0.0.1", bindingId };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

test("authorization preflight resolves UUID and binding without opening connections or returning secrets", async (t) => {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const sessions = new DatabaseSessions({ resolveProject: project });
  t.after(() => sessions.close());
  const entry = sessions.register("p", {
    ...config,
    port: server.address().port,
    password: "must-not-escape",
  });
  assert.equal(await sessions.assertAuthorized("p", entry.id), undefined);
  assert.equal(await sessions.assertAuthorized("p", bindingId), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections, 0);
  await assert.rejects(sessions.assertAuthorized("other", entry.id), /未授权/);
  await assert.rejects(sessions.assertAuthorized("other", bindingId), /未授权/);
  await assert.rejects(sessions.assertAuthorized("p", "missing"), /未授权/);
});

test("session-only grants retain existing unbound/no-resolver semantics without touching SQLite files", async () => {
  const sessions = new DatabaseSessions({
    resolveProject: () => {
      throw Error("must not resolve unbound grant");
    },
  });
  const entry = sessions.register("p", {
    name: "missing sqlite",
    filename: "/no/such/preflight-only/database.sqlite",
  });
  assert.equal(await sessions.assertAuthorized("p", entry.id), undefined);
  for (const id of [undefined, null, "", 1, {}])
    await assert.rejects(sessions.assertAuthorized("p", id), /未授权/);
  const withoutResolver = new DatabaseSessions();
  withoutResolver.register("p", config);
  assert.equal(
    await withoutResolver.assertAuthorized("p", bindingId),
    undefined,
  );
  sessions.close();
  withoutResolver.close();
});

for (const action of ["revoke", "reissue", "close", "abort"]) {
  test(`preflight rejects ${action} during source resolution using captured identity`, async (t) => {
    const entered = deferred(),
      release = deferred();
    t.after(() => release.resolve());
    const sessions = new DatabaseSessions({
      resolveProject: async () => {
        entered.resolve();
        await release.promise;
        return project();
      },
    });
    t.after(() => sessions.close());
    const entry = sessions.register("p", config);
    const controller = new AbortController();
    const pending = sessions.assertAuthorized(
      "p",
      bindingId,
      controller.signal,
    );
    const rejected = assert.rejects(
      pending,
      action === "abort" ? /取消/ : /撤销/,
    );
    await entered.promise;
    if (action === "abort") controller.abort();
    else if (action === "close") sessions.close();
    else {
      sessions.revoke("p", entry.id);
      if (action === "reissue") sessions.register("p", config);
    }
    release.resolve();
    await rejected;
  });
}

for (const change of [
  (p) => {
    p.id = "other";
  },
  (p) => {
    p.settings.apipostDatabases = [];
  },
  (p) => {
    p.settings.apipostDatabases[0].type = "mysql";
  },
  (p) => {
    p.settings.apipostDatabases[0].requiresSSH = true;
  },
  (p) => {
    p.settings.apipostDatabases.push({ ...p.settings.apipostDatabases[0] });
  },
]) {
  test("preflight rejects changed binding source before returning", async () => {
    const p = project();
    const sessions = new DatabaseSessions({
      resolveProject: async () => {
        change(p);
        return p;
      },
    });
    sessions.register("p", config);
    await assert.rejects(sessions.assertAuthorized("p", bindingId), /来源|SSH/);
    sessions.close();
  });
}

test("already aborted preflight does not invoke resolver", async () => {
  let called = false;
  const sessions = new DatabaseSessions({
    resolveProject: () => {
      called = true;
      return project();
    },
  });
  sessions.register("p", config);
  await assert.rejects(
    sessions.assertAuthorized("p", bindingId, AbortSignal.abort()),
    /取消/,
  );
  assert.equal(called, false);
  sessions.close();
});

for (const action of ["epoch", "policy", "reissue", "abort"]) {
  test(`MCP preflight rejects concurrent ${action} change`, async (t) => {
    const entered = deferred(),
      release = deferred();
    t.after(() => release.resolve());
    let policy = { enabled: true, write: true, execute: true, projects: ["p"] };
    const grants = new MCPDatabaseGrants(
      () => policy,
      async () => {
        entered.resolve();
        await release.promise;
        return project();
      },
    );
    t.after(() => grants.invalidate());
    const entry = grants.register(project(), config);
    const epoch = grants.capture(),
      controller = new AbortController();
    const pending = grants.preflight(
      epoch,
      "p",
      [bindingId],
      controller.signal,
    );
    const rejected = assert.rejects(
      pending,
      action === "abort" ? /取消/ : /撤销/,
    );
    await entered.promise;
    if (action === "epoch") {
      grants.invalidate();
      grants.register(project(), config);
    } else if (action === "policy") policy = { ...policy, execute: false };
    else if (action === "abort") controller.abort();
    else {
      grants.revoke("p", entry.id);
      grants.register(project(), config);
    }
    release.resolve();
    await rejected;
  });
}

test("MCP preflight checks every ID, project, empty-plan epoch and cancellation", async (t) => {
  let lookups = 0;
  const grants = new MCPDatabaseGrants(
    () => ({ enabled: true, write: true, execute: true, projects: ["p"] }),
    () => {
      lookups++;
      return project();
    },
  );
  t.after(() => grants.invalidate());
  const entry = grants.register(project(), config);
  const epoch = grants.capture();
  assert.equal(
    await grants.preflight(epoch, "p", [entry.id, bindingId]),
    undefined,
  );
  assert.equal(lookups, 2);
  await assert.rejects(
    grants.preflight(epoch, "p", [entry.id, "missing"]),
    /未授权/,
  );
  await assert.rejects(grants.preflight(epoch, "other", []), /未授权/);
  await assert.rejects(
    grants.preflight(epoch, "p", [], AbortSignal.abort()),
    /取消/,
  );
  grants.invalidate();
  await assert.rejects(grants.preflight(epoch, "p", []), /撤销/);
});

for (const action of ["revoke", "reissue"]) {
  test(`MCP batch rejects ${action} of an earlier grant while a later lookup waits`, async (t) => {
    const secondBinding = "apipost-" + "c".repeat(20) + "-db-" + "d".repeat(20);
    const p = project();
    p.settings.apipostDatabases.push({ id: secondBinding, type: "redis" });
    const entered = deferred(),
      release = deferred();
    t.after(() => release.resolve());
    let calls = 0;
    const grants = new MCPDatabaseGrants(
      () => ({ enabled: true, write: true, execute: true, projects: ["p"] }),
      async () => {
        if (++calls === 2) {
          entered.resolve();
          await release.promise;
        }
        return p;
      },
    );
    t.after(() => grants.invalidate());
    const first = grants.register(p, config);
    grants.register(p, { ...config, bindingId: secondBinding });
    const epoch = grants.capture();
    const pending = grants.preflight(epoch, "p", [bindingId, secondBinding]);
    const rejected = assert.rejects(pending, /撤销/);
    await entered.promise;
    grants.revoke("p", first.id);
    if (action === "reissue") grants.register(p, config);
    release.resolve();
    await rejected;
    if (action === "reissue")
      assert.equal(
        await grants.preflight(epoch, "p", [bindingId, secondBinding]),
        undefined,
      );
  });
}
