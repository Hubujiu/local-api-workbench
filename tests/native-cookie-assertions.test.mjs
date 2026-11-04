import vm from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import {
  compileNativeAssertions,
  nativeAssertionsInstallerSource,
} from "../src/native-response-assertions.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { executeRequest } from "../src/runtime.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { normalizeNativeAssertionData } from "../src/native-response-assertions.mjs";
import {
  captureResponseHeaderEvidence,
  readResponseCookieEvidence,
  readResponseHeaderEvidence,
} from "../src/response-header-evidence.mjs";
const assertion = (path, compareValue = "undefined", compareType = "eq") => ({
  type: "assert",
  enabled: 1,
  name: path,
  data: {
    type: "responseCookie",
    expression: { path, compareType, compareValue },
  },
});
const script = (data) => ({ type: "customScript", enabled: 1, data });
const phase = (response, tasks) =>
  runNativeTaskPhase(tasks, { request: {}, response });
async function fixture(t, cookies, version = "1.1") {
  const server = version === "2" ? http2.createServer() : http.createServer();
  const sessions = new Set();
  server.on("session", (s) => {
    sessions.add(s);
    s.on("close", () => sessions.delete(s));
  });
  server.on("request", (_req, res) => {
    if (cookies) res.setHeader("set-cookie", cookies);
    res.setHeader("x-proof", "ok");
    res.end("body");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const s of sessions) s.destroy();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  return executeRequest({
    url: `http://127.0.0.1:${server.address().port}/`,
    httpVersion: version,
  });
}
test("Cookie ordinary-name contract is literal, bounded and post-only", async () => {
  for (const path of [
    "a.b",
    "a[b]",
    "",
    " x ",
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__defineGetter__",
    "{{x}}",
  ])
    assert.throws(() => normalizeNativeAssertionData(assertion(path).data));
  for (const path of ["Session", "session", "a_b-~9"])
    assert.equal(
      normalizeNativeAssertionData(assertion(path).data).expression.path,
      path,
    );
  assert.throws(() => phase(undefined, [assertion("x")]), /响应|后置/);
});
test("Cookie real HTTP1 and HTTP2 preserve multiple unique names, equals, Unicode and invalid percent values", async (t) => {
  for (const version of ["1.1", "2"]) {
    const response = await fixture(
      t,
      [
        "Session=A=B==; HttpOnly; Path=/",
        "session=%E4%B8%AD%E6%96%87",
        "bad=%ZZ",
        "spaces=%20foo%20",
      ],
      version,
    );
    assert.equal(readResponseCookieEvidence(response).complete, true);
    const result = await phase(response, [
      assertion("Session", "A=B=="),
      assertion("session", "中文"),
      assertion("bad", "%ZZ"),
      assertion("spaces", " foo "),
      assertion("missing", "ignored", "notexist"),
    ]);
    assert.equal(result.tests.length, 5);
    assert.ok(result.tests.every((x) => x.passed));
  }
});
test("Cookie current captured map observes edits/deletion without public getter or replacement forgery", async (t) => {
  const response = await fixture(t, ["session=wire"]);
  const result = await phase(response, [
    script(
      "pm.cookies.get=()=>{throw Error('called')};response.cookies.session='edited';",
    ),
    assertion("session", "edited"),
    script(
      "const captured=response.cookies;response.cookies={session:'forged'};delete captured.session;",
    ),
    assertion("session", "ignored", "notexist"),
  ]);
  assert.ok(result.tests.every((x) => x.passed));
  for (const code of [
    "response.cookies.fresh='forged'",
    "Object.defineProperty(response.cookies,'session',{get(){throw Error('GETTER CALLED')}})",
    "response.cookies.session=42",
    "response.cookies.session='\\ud800'",
    "response.cookies.session='x'.repeat(65537)",
  ]) {
    await assert.rejects(
      () =>
        phase(response, [
          script(code),
          assertion(code.includes("fresh") ? "fresh" : "session"),
        ]),
      /Cookie|Unicode|64KiB/,
    );
  }
});
test("Cookie closed-world refusal does not downgrade Header evidence", async (t) => {
  for (const cookies of [
    ["a=1", "a=2"],
    ["a="],
    ["a= x"],
    ["a=x ; Path=/"],
    ["a.b=x"],
    ["a[b]=x"],
    ["constructor=x"],
    ["__proto__=x"],
  ]) {
    const response = await fixture(t, cookies);
    assert.equal(readResponseCookieEvidence(response).complete, false);
    assert.equal(readResponseHeaderEvidence(response).complete, true);
    await assert.rejects(
      () => phase(response, [assertion("absent", "ignored", "notexist")]),
      /Cookie.*证据/,
    );
    const good = assertion("x-proof", "ok");
    good.data.type = "responseHeader";
    assert.equal((await phase(response, [good])).tests[0].passed, true);
  }
});
test("Cookie requires transport identity and an exact initial projection, including trustworthy zero-cookie absence", async (t) => {
  const none = await fixture(t);
  assert.equal(
    (await phase(none, [assertion("absent", "ignored", "notexist")])).tests[0]
      .passed,
    true,
  );
  const response = await fixture(t, ["a=wire"]);
  for (const candidate of [
    { ...response },
    { ...response, cookieEvidence: { complete: true, values: { a: "wire" } } },
  ])
    await assert.rejects(
      () => phase(candidate, [assertion("a", "wire")]),
      /Cookie.*证据/,
    );
  response.headers["set-cookie"] = ["a=forged"];
  await assert.rejects(
    () => phase(response, [assertion("a", "forged")]),
    /Cookie.*证据/,
  );
  delete response.headers["set-cookie"];
  await assert.rejects(
    () => phase(response, [assertion("a", "ignored", "notexist")]),
    /Cookie.*证据/,
  );
  for (const cookies of [["a=1", "a=2"], ["a.b=x"]]) {
    const h2 = await fixture(t, cookies, "2");
    assert.equal(readResponseCookieEvidence(h2).complete, false);
    assert.equal(readResponseHeaderEvidence(h2).complete, true);
    await assert.rejects(
      () => phase(h2, [assertion("absent", "ignored", "notexist")]),
      /Cookie.*证据/,
    );
  }
  const bounded = {};
  captureResponseHeaderEvidence(
    bounded,
    ["set-cookie", "a=x; ignored=" + "x".repeat(65536)],
    "1.1",
  );
  assert.equal(readResponseCookieEvidence(bounded).complete, false);
  assert.equal(readResponseHeaderEvidence(bounded).complete, true);
  const truncated = {};
  captureResponseHeaderEvidence(
    truncated,
    Array.from({ length: 1000 }, () => ["x", "v"]).flat(),
    "1.1",
  );
  assert.equal(readResponseCookieEvidence(truncated).complete, false);
});

test("Cookie getters never execute and incomplete source cannot pass notexist", () => {
  const install = vm.runInNewContext(`(${nativeAssertionsInstallerSource})`);
  for (const initiallyAccessor of [false, true]) {
    let calls = 0,
      bodyReads = 0;
    const cookies = { a: "wire" };
    const getter = () => {
      calls++;
      throw Error("getter executed");
    };
    if (initiallyAccessor)
      Object.defineProperty(cookies, "a", {
        enumerable: true,
        configurable: true,
        get: getter,
      });
    const state = install(
      JSON.stringify(
        compileNativeAssertions([
          { name: "cookie", data: assertion("a", "ignored", "notexist").data },
        ]),
      ),
      () => {
        bodyReads++;
        throw Error("body/code executed");
      },
      () => {},
      [],
      {},
      JSON.stringify({ complete: false }),
      null,
      null,
      null,
      null,
      cookies,
      JSON.stringify({ complete: true, values: { a: "wire" } }),
    );
    if (!initiallyAccessor)
      Object.defineProperty(cookies, "a", {
        enumerable: true,
        configurable: true,
        get: getter,
      });
    assert.throws(() => state.run(0), /Cookie/);
    assert.equal(calls, 0);
    assert.equal(bodyReads, 0);
  }
});

test("Cookie imported HTTP workflow persists soft failure, scopes and frozen declarations across restore/restart", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("set-cookie", ["session=%E4%B8%AD%E6%96%87", "count=7"]);
    res.end("not JSON");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(tmpdir(), "native-cookie-http-"));
  let app = await createApp({ root, port: 0 });
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const post = async (route, value, status = 200) => {
    const r = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(value),
    });
    const data = await r.json();
    assert.equal(r.status, status, JSON.stringify(data));
    return data;
  };
  const source = modernApipostFixture();
  source.global.envs = [];
  source.global.servers = [];
  source.global.global_vars = {};
  source.global.global_param.pre_tasks = [];
  source.global.global_param.post_tasks = [];
  source.apis[0].request.pre_tasks = [];
  source.apis[0].request.post_tasks = [];
  const api = source.apis[1];
  api.url = `http://127.0.0.1:${server.address().port}/cookie`;
  api.request.query.parameter = [];
  api.request.header.parameter = [];
  api.request.pre_tasks = [];
  api.request.post_tasks = [
    assertion("session", "中文"),
    script('pm.environment.set("cookieProof","committed");pm.test=()=>{};'),
    assertion("count", "deliberate false"),
    script('tests.length=0;pm.globals.set("cookieAfter","yes");'),
    assertion("missing", "ignored", "notexist"),
  ];
  api.request.post_tasks.forEach((task, i) => {
    task.id = `cookie-${i}`;
    task.name ??= task.id;
  });
  const original = structuredClone(source),
    p = await app.store.create("cookie source");
  importIntoProject(p, source);
  assert.deepEqual(source, original);
  await app.store.save(p);
  const plan = await post(`/api/projects/${p.id}/plans`, {
    steps: [
      { request: p.requests[0] },
      { request: { url: api.url + "/later", inheritSharedScripts: false } },
    ],
  });
  const run = await post(`/api/projects/${p.id}/run`, { planId: plan.id });
  assert.equal(run.status, "failed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.equal(run.results[1].status, "passed");
  assert.deepEqual(
    Object.fromEntries(
      run.results[0].assertions.map((x) => [x.name, x.passed]),
    ),
    { session: true, count: false, missing: true },
  );
  assert.equal(seen.length, 2);
  const disk = await new Store(root).get(p.id);
  assert.equal(disk.environments[0].variables.cookieProof, "committed");
  assert.equal(disk.globalVariables.cookieAfter, "yes");
  const isolated = await app.store.create("isolated");
  assert(!Object.hasOwn(isolated.globalVariables, "cookieAfter"));
  assert(
    isolated.environments.every(
      (e) => !Object.hasOwn(e.variables, "cookieProof"),
    ),
  );
  const restored = await post("/api/restore", { document: disk }, 201);
  assert.deepEqual(
    restored.requests[0].nativeTasks,
    disk.requests[0].nativeTasks,
  );
  assert.deepEqual(
    restored.plans.find((x) => x.id === plan.id).steps[0].request.nativeTasks,
    plan.steps[0].request.nativeTasks,
  );
  await close();
  app = await createApp({ root, port: 0 });
  const rerun = await post(`/api/projects/${restored.id}/run`, {
    planId: plan.id,
  });
  assert.equal(rerun.status, "failed");
  assert.equal(rerun.recordSaved, true);
  assert.equal(rerun.results[1].status, "passed");
  assert.deepEqual(
    Object.fromEntries(
      rerun.results[0].assertions.map((x) => [x.name, x.passed]),
    ),
    { session: true, count: false, missing: true },
  );
});
