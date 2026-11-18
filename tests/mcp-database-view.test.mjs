import test from "node:test";
import assert from "node:assert/strict";
import {
  mcpDatabaseAllowed,
  mcpDatabasePanel,
  readMCPDatabaseInput,
  bindMCPDatabase,
} from "../public/mcp-database-view.js";
const config = { enabled: true, write: true, execute: true, projects: ["p"] };
function fixture() {
  const values = new Map(
    [
      "name",
      "type",
      "filename",
      "host",
      "port",
      "database",
      "user",
      "password",
      "authSource",
      "ca",
      "ssl",
      "ssh",
      "bindingId",
      "confirm",
    ].map((k) => [k, { value: "", checked: false }]),
  );
  const form = {
    elements: { namedItem: (k) => values.get(k) },
    reset() {
      for (const v of values.values()) {
        v.value = "";
        v.checked = false;
      }
      values.get("type").value = "sqlite";
    },
  };
  form.reset();
  const nodes = new Map([["#mcp-db-form", form]]);
  const root = {
    isConnected: true,
    querySelector(k) {
      if (!nodes.has(k))
        nodes.set(k, { innerHTML: "", textContent: "", contains: () => true });
      return nodes.get(k);
    },
  };
  return {
    root,
    form,
    nodes,
    values,
    set(k, value) {
      values.get(k).value = value;
    },
    confirm() {
      values.get("confirm").checked = true;
    },
  };
}
test("MCP database policy requires all explicit grants; panel never imports credentials", () => {
  assert.equal(mcpDatabaseAllowed(config, "p"), true);
  for (const key of ["enabled", "write", "execute"])
    assert.equal(mcpDatabaseAllowed({ ...config, [key]: false }, "p"), false);
  assert.equal(mcpDatabaseAllowed(config, "other"), false);
  assert.equal(mcpDatabaseAllowed({}, "p"), false);
  const html = mcpDatabasePanel({
    id: "p",
    name: "<project>",
    settings: {
      apipostDatabases: [
        {
          id: "binding",
          name: "<db>",
          password: "DO-NOT-RENDER",
          type: "mysql",
        },
      ],
    },
  });
  assert(!html.includes("DO-NOT-RENDER"));
  assert(!html.includes("<db>"));
  assert(html.includes("&lt;project&gt;"));
  assert(html.includes('id="mcp-db-fields" disabled'));
  assert(html.includes('type="password"'));
  assert(!html.includes('value="oracle"'));
});
test("input is an explicit temporary connection and SQLite discards inactive secret fields", () => {
  const f = fixture();
  f.set("name", "test");
  f.set("filename", "/tmp/fixture.db");
  f.set("password", "secret");
  assert.throws(() => readMCPDatabaseInput(f.form), /确认/);
  f.confirm();
  assert.deepEqual(readMCPDatabaseInput(f.form), {
    name: "test",
    type: "sqlite",
    filename: "/tmp/fixture.db",
  });
  f.set("type", "postgres");
  f.set("host", "localhost");
  f.set("port", "oops");
  assert.throws(() => readMCPDatabaseInput(f.form), /端口/);
  f.set("port", "5432");
  f.set("ssh", "bad-secret-json");
  assert.throws(
    () => readMCPDatabaseInput(f.form),
    (e) => !e.message.includes("bad-secret"),
  );
});
test("default denial performs no request and policy removal clears secrets", async () => {
  const f = fixture(),
    calls = [];
  const update = bindMCPDatabase(f.root, {
    projectId: "p",
    config: {},
    request: async (...args) => {
      calls.push(args);
      return [];
    },
  });
  f.set("password", "secret");
  await f.form.onsubmit({ preventDefault() {} });
  assert.equal(calls.length, 0);
  update(config);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  f.set("password", "another");
  update({ ...config, enabled: false });
  assert.equal(f.values.get("password").value, "");
  assert.equal(f.nodes.get("#mcp-db-fields").disabled, true);
});
test("submit is deduplicated, clears credentials and confirmation, and shows only safe metadata", async () => {
  const f = fixture(),
    calls = [];
  let resolve;
  bindMCPDatabase(f.root, {
    projectId: "p",
    config,
    request: async (url, method, payload) => {
      calls.push({ url, method, payload });
      if (method === "POST") return new Promise((r) => (resolve = r));
      return [
        {
          id: "one",
          name: "<safe>",
          type: "postgres",
          password: "server-secret",
          host: "private-host",
        },
      ];
    },
  });
  await new Promise((r) => setImmediate(r));
  f.set("name", "db");
  f.set("type", "postgres");
  f.set("host", "localhost");
  f.set("password", "secret");
  f.confirm();
  const pending = f.form.onsubmit({ preventDefault() {} });
  assert.equal(f.values.get("password").value, "");
  assert.equal(f.values.get("confirm").checked, false);
  await f.form.onsubmit({ preventDefault() {} });
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  resolve({ id: "one" });
  await pending;
  const html = f.nodes.get("#mcp-db-list").innerHTML;
  assert(html.includes("&lt;safe&gt;"));
  assert(!html.includes("server-secret"));
  assert(!html.includes("private-host"));
});
test("uncertain mutation is not replayed and exception secrets never appear", async () => {
  const f = fixture(),
    calls = [];
  bindMCPDatabase(f.root, {
    projectId: "p",
    config,
    request: async (url, method) => {
      calls.push(method);
      if (method) throw Error("credential-secret");
      return [];
    },
  });
  await new Promise((r) => setImmediate(r));
  f.set("name", "db");
  f.set("filename", "/tmp/db");
  f.confirm();
  await f.form.onsubmit({ preventDefault() {} });
  assert.equal(calls.filter((c) => c === "POST").length, 1);
  assert.match(f.nodes.get("#mcp-db-message").textContent, /不要盲目/);
  assert(
    !f.nodes.get("#mcp-db-message").textContent.includes("credential-secret"),
  );
});
test("late list replies cannot resurrect a revoked or departed view", async () => {
  const f = fixture();
  let resolve;
  const update = bindMCPDatabase(f.root, {
    projectId: "p",
    config,
    request: () => new Promise((r) => (resolve = r)),
  });
  update({ ...config, projects: [] });
  resolve([{ id: "stale", name: "stale", type: "mysql" }]);
  await new Promise((r) => setImmediate(r));
  assert(!f.nodes.get("#mcp-db-list").innerHTML.includes("stale"));
});

test("revoke submits only the scoped connection ID and refreshes server truth", async () => {
  const f = fixture(),
    calls = [];
  bindMCPDatabase(f.root, {
    projectId: "p",
    config,
    request: async (url, method, data) => {
      calls.push({ url, method, data });
      return [];
    },
  });
  await new Promise((r) => setImmediate(r));
  const target = { dataset: { mcpDbRevoke: "connection-1" } };
  await f.nodes
    .get("#mcp-db-list")
    .onclick({ target: { closest: () => target } });
  assert.deepEqual(
    calls.find((c) => c.method === "DELETE"),
    {
      url: "/projects/p/mcp-database-connections",
      method: "DELETE",
      data: { id: "connection-1" },
    },
  );
  assert.equal(calls.length, 3);
  assert.match(f.nodes.get("#mcp-db-message").textContent, /已撤销/);
});

test("departing during mutation never displays success in another view", async () => {
  const f = fixture();
  let resolve;
  bindMCPDatabase(f.root, {
    projectId: "p",
    config,
    request: async (_, method) =>
      method ? new Promise((r) => (resolve = r)) : [],
  });
  await new Promise((r) => setImmediate(r));
  f.set("name", "db");
  f.set("filename", "/tmp/db");
  f.confirm();
  const pending = f.form.onsubmit({ preventDefault() {} });
  f.root.isConnected = false;
  resolve({ id: "new" });
  await pending;
  assert(!f.nodes.get("#mcp-db-message").textContent.includes("已临时授权"));
});

test("activity polling does not erase inputs or interrupt an in-flight grant", async () => {
  const f = fixture();
  let resolve;
  const update = bindMCPDatabase(f.root, {
    projectId: "p",
    config,
    request: async (_, method) =>
      method ? new Promise((r) => (resolve = r)) : [],
  });
  await new Promise((r) => setImmediate(r));
  f.set("name", "keep");
  f.set("password", "keep-secret");
  update({ ...config, lastActivity: { finishedAt: "2026-11-18" } });
  assert.equal(f.values.get("password").value, "keep-secret");
  f.set("filename", "/tmp/db");
  f.confirm();
  const pending = f.form.onsubmit({ preventDefault() {} });
  update({ ...config, lastActivity: { finishedAt: "2026-11-19" } });
  resolve({ id: "new" });
  await pending;
  assert.match(f.nodes.get("#mcp-db-message").textContent, /已临时授权/);
});

test("same policy with a new server grant epoch clears the stale list and pending inputs", async () => {
  const f = fixture();
  let calls = 0;
  const update = bindMCPDatabase(f.root, {
    projectId: "p",
    config: { ...config, databaseGrantEpoch: 1 },
    request: async () => {
      calls++;
      return calls === 1 ? [{ id: "old", type: "sqlite", name: "old" }] : [];
    },
  });
  await new Promise((r) => setImmediate(r));
  f.set("password", "pending-secret");
  update({ ...config, databaseGrantEpoch: 2 });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  assert.equal(f.values.get("password").value, "");
  assert(
    !f.nodes.get("#mcp-db-list").innerHTML.includes('data-mcp-db-revoke="old"'),
  );
});

test("failed revoke keeps the authoritative grant visible and never claims revocation", async () => {
  const f = fixture();
  bindMCPDatabase(f.root, {
    projectId: "p",
    config,
    request: async (_, method) => {
      if (method === "DELETE") throw Error("secret path");
      return [{ id: "remaining", name: "db", type: "sqlite" }];
    },
  });
  await new Promise((r) => setImmediate(r));
  const target = { dataset: { mcpDbRevoke: "remaining" } };
  await f.nodes
    .get("#mcp-db-list")
    .onclick({ target: { closest: () => target } });
  assert(
    f.nodes
      .get("#mcp-db-list")
      .innerHTML.includes('data-mcp-db-revoke="remaining"'),
  );
  assert.match(f.nodes.get("#mcp-db-message").textContent, /操作未确认/);
  assert(!f.nodes.get("#mcp-db-message").textContent.includes("已撤销"));
  assert(!f.nodes.get("#mcp-db-message").textContent.includes("secret path"));
});
