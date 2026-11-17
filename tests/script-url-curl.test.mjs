import test from "node:test";
import assert from "node:assert/strict";
import { toCurl, interpolate } from "../src/core.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";

const source = {
  url: "https://example.test/{id}?raw=%2f+&flag&x=first&x=second",
  scriptURLMode: "sdk",
  path: [{ key: "id", value: "42" }],
  queryAddEqual: false,
  query: [
    { key: "table", value: "a+b&c" },
    { key: "empty", value: "" },
    { key: "off", value: "x", enabled: false },
  ],
};

test("SDK cURL definition export preserves raw and table query encodings without mutating source", () => {
  const original = structuredClone(source);
  const command = toCurl(source);
  assert.ok(
    command.includes(
      "https://example.test/42?raw=%2f+&flag&x=first&x=second&table=a%2Bb%26c&empty",
    ),
    command,
  );
  assert.deepEqual(source, original);
});

test("SDK cURL refuses unresolved dynamic providers and pre-request effects", async () => {
  for (const extra of [
    { beforeScript: "pm.request.url.query.add({key:'x',value:'changed'})" },
    { sharedBeforeScripts: [{ name: "global", code: "apt.setVar('x',1)" }] },
    { before: [{ type: "set", name: "x", value: "y" }] },
  ])
    assert.throws(() => toCurl({ ...source, ...extra }), /前置/);
  const dynamic = {
    ...source,
    query: [{ key: "value", dynamic: { source: "variable", value: "x" } }],
  };
  assert.throws(() => toCurl(dynamic), /动态/);
  assert.throws(
    () =>
      toCurl({
        ...source,
        headers: [
          { key: "x-value", dynamic: { source: "fixed", value: "secret" } },
        ],
      }),
    /动态/,
  );
  assert.throws(
    () =>
      toCurl({
        ...source,
        bodyType: "raw",
        body: "{{@value:one}}",
        bodyDynamic: { one: { source: "fixed", value: "x", format: "text" } },
      }),
    /动态/,
  );
  assert.ok(
    !toCurl({
      ...source,
      query: [
        {
          key: "off",
          enabled: false,
          dynamic: { source: "variable", value: "missing" },
        },
      ],
    }).includes("off="),
  );
  assert.throws(() => toCurl({ ...source, scriptURLRuntime: null }));
  const resolved = await resolveDynamicRequest(
    dynamic,
    { x: "a+b" },
    [],
    interpolate,
  );
  assert.ok(toCurl(resolved).includes("value=a%2Bb"));
});

test("SDK cURL API resolves selected variables and service binding but rejects inherited scripts before providers", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "sdk-curl-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("SDK cURL");
  project.globalVariables = { value: "a+b&c" };
  project.servers = [{ id: "svc", name: "Fixture" }];
  project.environments[0].serverUrls = { svc: "https://example.test/base" };
  await app.store.save(project);
  const request = {
    ...source,
    serviceId: "svc",
    url: "/{id}?raw=%2f+&flag",
    query: [{ key: "table", dynamic: { source: "variable", value: "value" } }],
  };
  const call = async (request) => {
    const response = await fetch(`${app.url}/api/projects/${project.id}/curl`, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        request,
        environmentId: project.environments[0].id,
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const exported = await call(request);
  assert.equal(exported.status, 200, JSON.stringify(exported));
  assert.ok(
    exported.body.curl.includes(
      "https://example.test/base/42?raw=%2f+&flag&table=a%2Bb%26c",
    ),
    JSON.stringify(exported),
  );
  project.settings.globalScripts = {
    beforeScript: "throw Error('must-not-execute')",
  };
  await app.store.save(project);
  const blocked = await call({
    ...request,
    query: [
      {
        key: "table",
        dynamic: { source: "variable", value: "undefined-provider" },
      },
    ],
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /前置/);
  const optedOut = await call({ ...request, inheritSharedScripts: false });
  assert.equal(optedOut.status, 200, JSON.stringify(optedOut));
  assert.ok(optedOut.body.curl.includes("table=a%2Bb%26c"));
});
