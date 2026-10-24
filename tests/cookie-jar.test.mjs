import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectCookieJar } from "../src/cookie-jar.mjs";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-api-cookie-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("cookie jars are opt-in and isolated by project/environment across restart", async (t) => {
  const root = await fixture(t),
    jar = new ProjectCookieJar(root, "project", "dev");
  assert.equal(await jar.header("https://api.example.test/"), null);
  await jar.capture("https://api.example.test/", ["ignored=1; Path=/"]);
  assert.equal((await jar.inspect()).cookies.length, 0);
  await jar.configure({ enabled: true, expectedRevision: 0 });
  await jar.capture("https://api.example.test/login", [
    "sid=fixture; Path=/; HttpOnly",
    "private=1; Path=/private",
    "secret=1; Path=/; Secure",
  ]);
  const reopened = new ProjectCookieJar(root, "project", "dev");
  assert.equal(
    await reopened.header("https://api.example.test/"),
    "sid=fixture; secret=1",
  );
  assert.equal(
    await reopened.header("http://api.example.test/"),
    "sid=fixture",
  );
  assert.match(
    await reopened.header("https://api.example.test/private/page"),
    /^private=1;/,
  );
  assert.equal(await reopened.header("https://other.example.test/"), "");
  assert.equal(
    await new ProjectCookieJar(root, "project", "prod").header(
      "https://api.example.test/",
    ),
    null,
  );
  assert.equal(
    await new ProjectCookieJar(root, "other", "dev").header(
      "https://api.example.test/",
    ),
    null,
  );
});

test("cookie domain expiry prefixes and concurrent response writes are enforced", async (t) => {
  const jar = new ProjectCookieJar(await fixture(t), "project", "dev");
  await jar.configure({ enabled: true, expectedRevision: 0 });
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      jar.capture("https://api.example.test/", ["c" + i + "=value; Path=/"]),
    ),
  );
  assert.equal((await jar.inspect()).cookies.length, 8);
  await jar.capture("https://api.example.test/", [
    "cross=bad; Domain=elsewhere.test",
    "wide=bad; Domain=test",
    "__Host-bad=bad; Secure; Domain=example.test; Path=/",
    "expired=bad; Max-Age=0",
  ]);
  assert.equal((await jar.inspect()).cookies.length, 8);
  await jar.capture("https://api.example.test/", [
    "c0=gone; Max-Age=0; Path=/",
  ]);
  assert.equal((await jar.inspect()).cookies.length, 7);
  assert(
    !String(await jar.header("https://api.example.test/")).includes("bad"),
  );
  await jar.capture("http://localhost/", ["secure=bad; Secure; Path=/"]);
  assert(!String(await jar.header("http://localhost/")).includes("secure="));
});

test("manual cookie mutations require a fresh revision and preserve other entries", async (t) => {
  const jar = new ProjectCookieJar(await fixture(t), "project", "dev");
  await jar.setCookie("https://api.example.test/", "a=1; Path=/", {
    expectedRevision: 0,
  });
  await assert.rejects(
    jar.configure({ enabled: true, expectedRevision: 0 }),
    /修改/,
  );
  let state = await jar.inspect();
  assert.equal(state.enabled, false);
  await jar.setCookie("https://api.example.test/", "b=2; Path=/", {
    expectedRevision: state.revision,
  });
  state = await jar.inspect();
  await jar.remove({
    domain: "api.example.test",
    path: "/",
    key: "a",
    expectedRevision: state.revision,
  });
  state = await jar.inspect();
  assert.deepEqual(
    state.cookies.map((c) => c.key),
    ["b"],
  );
  await jar.clear({ expectedRevision: state.revision });
  assert.deepEqual((await jar.inspect()).cookies, []);
  await assert.rejects(
    jar.setCookie("file:///tmp/x", "a=1", {
      expectedRevision: (await jar.inspect()).revision,
    }),
    /HTTP/,
  );
});

test("managed cookies follow real main/script requests and explicit off-switch precedence", async (t) => {
  const { createServer } = await import("node:http");
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie || "" });
    if (req.url === "/login")
      res.setHeader("Set-Cookie", "sid=fixture; Path=/; HttpOnly");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ cookie: req.headers.cookie || "" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`,
    jar = new ProjectCookieJar(await fixture(t), "project", "dev");
  await jar.configure({ enabled: true, expectedRevision: 0 });
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: url + "/login",
          headers: [{ key: "Cookie", value: "manual=ignored" }],
        },
      },
      {
        request: {
          url: url + "/main",
          beforeScript: `$.ajax({url:${JSON.stringify(url + "/script")},success:data=>pm.test('cookie in script',()=>pm.expect(data.cookie).to.equal('sid=fixture'))});`,
        },
      },
    ],
  });
  const result = await runPlan(plan, {}, executeRequest, {
    cookieSession: jar,
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(
    seen.map((r) => r.cookie),
    ["", "sid=fixture", "sid=fixture"],
  );
  const state = await jar.inspect();
  await jar.configure({ enabled: false, expectedRevision: state.revision });
  await executeRequest(
    {
      url: url + "/manual",
      headers: [{ key: "Cookie", value: "manual=kept" }],
    },
    undefined,
    { cookieSession: jar },
  );
  assert.equal(seen.at(-1).cookie, "manual=kept");
});

test("load-test cookie snapshots never persist or leak between iterations", async (t) => {
  const { memoryCookieSession } = await import("../src/cookie-jar.mjs");
  const jar = new ProjectCookieJar(await fixture(t), "project", "dev");
  await jar.setCookie(
    "https://api.example.test/",
    "__Host-valid=fixture; Secure; Path=/",
    { expectedRevision: 0 },
  );
  await jar.configure({
    enabled: true,
    expectedRevision: (await jar.inspect()).revision,
  });
  const state = await jar.inspect(),
    a = memoryCookieSession(state),
    b = memoryCookieSession(state);
  await a.capture("https://api.example.test/", ["iteration=only-a; Path=/"]);
  assert.match(await a.header("https://api.example.test/"), /iteration=only-a/);
  assert.equal(
    await b.header("https://api.example.test/"),
    "__Host-valid=fixture",
  );
  assert.equal(
    await jar.header("https://api.example.test/"),
    "__Host-valid=fixture",
  );
  assert.equal((await jar.inspect()).cookies.length, 1);
});

test("Max-Age is frozen to an absolute expiry and is not renewed by reads or settings", async (t) => {
  const jar = new ProjectCookieJar(await fixture(t), "project", "dev");
  await jar.setCookie(
    "https://api.example.test/",
    "bounded=1; Max-Age=60; Path=/",
    { expectedRevision: 0 },
  );
  const before = await jar.inspect();
  assert(before.cookies[0].expires);
  assert.equal(before.cookies[0].maxAge, undefined);
  await jar.configure({ enabled: true, expectedRevision: before.revision });
  await jar.header("https://api.example.test/");
  await jar.capture("https://api.example.test/", ["other=1; Path=/"]);
  assert.equal(
    (await jar.inspect()).cookies.find((c) => c.key === "bounded").expires,
    before.cookies[0].expires,
  );
});

test("IPv6 host cookies survive reopening and malformed control characters are rejected", async (t) => {
  const root = await fixture(t),
    jar = new ProjectCookieJar(root, "project", "dev");
  await jar.setCookie("http://[::1]/", "ipv6=fixture; Path=/", {
    expectedRevision: 0,
  });
  await jar.configure({
    enabled: true,
    expectedRevision: (await jar.inspect()).revision,
  });
  assert.equal(
    await new ProjectCookieJar(root, "project", "dev").header("http://[::1]/"),
    "ipv6=fixture",
  );
  await assert.rejects(
    jar.setCookie("http://[::1]/", "bad=1\r\nX: injected", {
      expectedRevision: (await jar.inspect()).revision,
    }),
    /控制字符/,
  );
});

test("cookie API is authenticated and keeps jar configuration out of portable project state", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "local-api-cookie-api-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, method = "GET", data) => {
    const response = await fetch(app.url + "/api" + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    assert(response.ok, await response.clone().text());
    return response.json();
  };
  const project = await call("/projects", "POST", { name: "Cookie fixture" }),
    route = "/projects/" + project.id + "/cookies";
  assert.equal((await fetch(app.url + "/api" + route)).status, 403);
  let state = await call(route);
  state = await call(route, "POST", {
    operation: "set",
    url: "https://api.example.test/",
    cookie: "fixture-only-secret=never-export; Path=/",
    expectedRevision: state.revision,
  });
  assert.equal(state.cookies.length, 1);
  const portable = await call("/projects/" + project.id);
  assert.equal(JSON.stringify(portable).includes("never-export"), false);
  assert.equal(portable.configRevision, project.configRevision);
  portable.name = "Unrelated edit after cookie write";
  await call("/projects/" + project.id, "PUT", portable);
});
