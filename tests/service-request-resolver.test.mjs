import test from "node:test";
import assert from "node:assert/strict";
import { createServiceRequestResolver } from "../src/environments.mjs";

function project() {
  return {
    currentEnvironmentId: "one",
    environments: [
      {
        id: "one",
        serverUrls: { a: "http://127.0.0.1:10001" },
        variables: { token: "old" },
      },
      {
        id: "two",
        serverUrls: {
          a: "http://127.0.0.1:10002",
          b: "http://127.0.0.1:10003",
        },
        variables: {},
      },
    ],
    servers: [{ id: "a" }, { id: "b" }],
    settings: { folderServices: { Orders: "a" } },
  };
}

test("resolver privately captures selected environment, catalog IDs and folder bindings, not variables", () => {
  const p = project(),
    resolve = createServiceRequestResolver(p),
    request = { folder: "Orders", url: "/{{token}}" };
  p.currentEnvironmentId = "two";
  p.environments[0].id = "renamed";
  p.environments[0].serverUrls.a = "http://127.0.0.1:10004";
  p.environments[0].variables.token = "fresh";
  p.settings.folderServices.Orders = "b";
  p.servers[0].id = "deleted";
  assert.equal(resolve(request).url, "http://127.0.0.1:10001/{{token}}");
  assert.equal(
    createServiceRequestResolver(p)(request).url,
    "http://127.0.0.1:10003/{{token}}",
  );
  assert.deepEqual(request, { folder: "Orders", url: "/{{token}}" });
  assert.equal(p.environments[0].variables.token, "fresh");
});

test("missing service and missing address remain missing for this execution even when configured later", () => {
  for (const missingCatalog of [false, true]) {
    const p = project();
    if (missingCatalog) p.servers = [];
    else delete p.environments[0].serverUrls.a;
    const resolve = createServiceRequestResolver(p, "one");
    p.servers = [{ id: "a" }];
    p.environments[0].serverUrls.a = "http://127.0.0.1:10005";
    const request = { serviceId: "a", url: "/items" };
    assert.throws(
      () => resolve(request),
      missingCatalog ? /服务不存在/ : /当前环境未配置服务地址/,
    );
    assert.equal(
      createServiceRequestResolver(p, "one")(request).url,
      "http://127.0.0.1:10005/items",
    );
  }
});

test("resolver preserves explicit, frozen, absolute and templated routing semantics and host guards", () => {
  const p = project(),
    resolve = createServiceRequestResolver(p, "two");
  assert.equal(
    resolve({ serviceId: "b", folder: "Orders", url: "/items" }).url,
    "http://127.0.0.1:10003/items",
  );
  for (const request of [
    { folder: "Orders", url: "http://127.0.0.1:10004/direct" },
    { folder: "Orders", url: "{{baseUrl}}/direct" },
    { folder: "Orders", url: "/items", serviceSnapshot: true },
  ])
    assert.equal(resolve(request), request);
  assert.throws(
    () => resolve({ serviceId: "a", url: "//127.0.0.1:10004/items" }),
    /覆盖服务主机/,
  );
  assert.throws(
    () => resolve({ serviceId: "a", url: "http://127.0.0.1:10004/items" }),
    /必须为相对路径/,
  );
  assert.throws(() => createServiceRequestResolver(p, "missing"), /环境不存在/);
  const separate = project();
  separate.environments[0].serverUrls.a = "http://127.0.0.1:10005";
  assert.equal(
    createServiceRequestResolver(separate)({ serviceId: "a", url: "/items" })
      .url,
    "http://127.0.0.1:10005/items",
  );
  assert.equal(
    resolve({ serviceId: "a", url: "/items" }).url,
    "http://127.0.0.1:10002/items",
  );
});
