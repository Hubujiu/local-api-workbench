import test from "node:test";
import assert from "node:assert/strict";
import {
  environmentVariables,
  manageEnvironment,
  resolveServiceRequest,
} from "../src/environments.mjs";
test("environment CRUD, global precedence and shared service addresses are deterministic", () => {
  const p = {
    environments: [{ id: "dev", name: "Dev", variables: { shared: "dev" } }],
    globalVariables: { shared: "global", onlyGlobal: 1 },
  };
  const created = manageEnvironment(p, "create_environment", {
    name: "Production",
    baseUrl: "https://prod.example",
  });
  manageEnvironment(p, "switch_environment", { environmentId: created.id });
  const server = manageEnvironment(p, "create_environment_server", {
    name: "Orders",
    environmentId: "dev",
    url: "http://localhost:8080",
  });
  manageEnvironment(p, "update_environment_server", {
    serverId: server.id,
    environmentId: created.id,
    url: "https://orders.example",
  });
  manageEnvironment(p, "upsert_environment_variable", {
    environmentId: created.id,
    key: "shared",
    value: "prod",
  });
  assert.deepEqual(environmentVariables(p), {
    shared: "prod",
    onlyGlobal: 1,
    baseUrl: "https://prod.example",
  });
  assert.equal(
    resolveServiceRequest(p, { url: "/orders", serviceId: server.id }).url,
    "https://orders.example/orders",
  );
  assert.equal(
    resolveServiceRequest(p, { url: "/orders", serviceId: server.id }, "dev")
      .url,
    "http://localhost:8080/orders",
  );
  manageEnvironment(p, "delete_environment_server", { serverId: server.id });
  assert.throws(
    () => resolveServiceRequest(p, { url: "/orders", serviceId: server.id }),
    /服务/,
  );
  manageEnvironment(p, "delete_environment", { environmentId: created.id });
  assert.equal(p.currentEnvironmentId, "dev");
  assert.throws(
    () => manageEnvironment(p, "delete_environment", { environmentId: "dev" }),
    /至少/,
  );
});
test("missing environment and unsafe variable keys never fall back silently", () => {
  const p = { environments: [{ id: "dev", name: "Dev", variables: {} }] };
  assert.throws(() => environmentVariables(p, "missing"), /环境/);
  assert.throws(
    () =>
      manageEnvironment(p, "upsert_global_variable", {
        key: "__proto__",
        value: { polluted: true },
      }),
    /变量/,
  );
  assert.throws(
    () =>
      manageEnvironment(p, "create_environment", {
        name: "bad",
        baseUrl: "file:///tmp/private",
      }),
    /HTTP/,
  );
  assert.equal({}.polluted, undefined);
});
