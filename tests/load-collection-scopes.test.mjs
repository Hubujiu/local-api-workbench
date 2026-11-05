import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { runLoad } from "../src/load-runner.mjs";
import { preparePostmanCollection } from "../src/postman-collection-scopes.mjs";

function project() {
  return {
    globalVariables: { shadow: "global", globalOnly: "global" },
    environments: [
      { id: "env", name: "Environment", variables: { shadow: "environment" } },
    ],
    requests: [],
    cases: [],
    plans: [],
    settings: {},
    postmanCollections: {
      version: 1,
      items: ["a", "b"].map((id) =>
        preparePostmanCollection(
          {
            info: { name: id },
            item: [],
            variable: [
              { key: "only", value: id },
              { key: "shadow", value: "collection" },
              { key: "counter", value: 0, type: "number" },
              { key: "object", value: { nested: [0] } },
              { key: "nil", value: null },
              { key: "bool", value: false },
              { key: "empty", value: "" },
            ],
          },
          () => id,
        ),
      ),
    },
  };
}
async function fixture(t) {
  const seen = [];
  let active = 0,
    peak = 0,
    started;
  const arrived = new Promise((resolve) => {
    started = resolve;
  });
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    peak = Math.max(peak, ++active);
    res.on("close", () => active--);
    started();
    if (req.url === "/hold") return;
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    }, 40);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    arrived,
    peak: () => peak,
  };
}
const beforeScript = `
  pm.test('fresh collection', () => {
    pm.expect(pm.collectionVariables.get('counter')).to.equal(0);
    pm.expect(pm.collectionVariables.get('object')).to.deep.equal({nested:[0]});
    pm.expect(pm.collectionVariables.get('nil')).to.equal(null);
    pm.expect(pm.collectionVariables.get('bool')).to.equal(false);
    pm.expect(pm.collectionVariables.get('empty')).to.equal('');
  });
  const copy = pm.collectionVariables.get('object'); copy.nested.push(1);
  pm.expect(pm.collectionVariables.get('object')).to.deep.equal({nested:[0]});
  pm.collectionVariables.set('counter', '1');
  pm.collectionVariables.set('object', {nested:[pm.info.iteration]});
  pm.environment.set('ephemeral', 'private');
  pm.globals.set('ephemeral', 'private');
`;
const afterScript = `
  pm.test('pre-stage visible only here', () => {
    pm.expect(pm.collectionVariables.get('counter')).to.equal(1);
    pm.expect(pm.collectionVariables.get('object')).to.deep.equal({nested:[pm.info.iteration]});
    pm.expect(pm.collectionVariables.has('nil')).to.equal(true);
    pm.expect(pm.collectionVariables.replaceIn('{{only}}')).to.equal(pm.collectionVariables.get('only'));
    pm.expect(pm.collectionVariables.toObject().counter).to.equal(1);
  });
  pm.collectionVariables.unset('nil');
  pm.collectionVariables.clear();
  pm.collectionVariables.set('postOnly', 'private');
`;

test("bound HTTP load preserves collection layers and isolates concurrent and later iterations", async (t) => {
  const f = await fixture(t),
    p = project(),
    original = structuredClone(p);
  for (const concurrency of [3, 1]) {
    const result = await runLoad(
      p,
      {
        postmanCollectionId: "a",
        url: f.url + "/{{only}}/{{counter}}/{{shadow}}/{{globalOnly}}",
        headers: [{ key: "x-row", value: "{{row}}" }],
        beforeScript,
        afterScript,
      },
      { count: 6, concurrency, dataCSV: "row,shadow\nfirst,csv\nsecond,csv" },
    );
    assert.equal(result.passed, 6, JSON.stringify(result));
    assert.equal(result.mainRequests, 6);
    assert.equal(result.variableIsolation, "per-request");
    assert.deepEqual(
      result.results.map((r) => r.dataRow),
      [1, 2, 1, 2, 1, 2],
    );
    assert.deepEqual(p, original);
  }
  assert(f.peak() > 1, "real HTTP requests overlap");
  assert(f.seen.every((r) => r.url === "/a/1/csv/global"));
  assert.equal(f.seen.filter((r) => r.headers["x-row"] === "first").length, 6);
  const b = await runLoad(
    p,
    {
      postmanCollectionId: "b",
      url: f.url + "/{{only}}/{{counter}}/{{shadow}}",
    },
    { count: 1 },
  );
  assert.equal(b.passed, 1);
  assert.equal(f.seen.at(-1).url, "/b/0/environment");
  assert.deepEqual(p, original);
});

test("collection load rejects missing bindings before effects and prevents failed/forged stages leaking", async (t) => {
  const f = await fixture(t),
    p = project(),
    original = structuredClone(p);
  await assert.rejects(
    runLoad(p, { postmanCollectionId: "missing", url: f.url }, { count: 1 }),
    /collection/,
  );
  assert.equal(f.seen.length, 0);
  for (const script of [
    "pm.collectionVariables.set('counter', 5); throw Error('stage failed');",
    "pm.collectionVariables.set('counter', 5); request.postmanCollectionId='b';",
  ]) {
    const result = await runLoad(
      p,
      { postmanCollectionId: "a", url: f.url, beforeScript: script },
      { count: 3, concurrency: 2 },
    );
    assert.equal(result.passed, 0);
    assert.equal(result.mainRequests, 0);
    assert(result.results.every((r) => r.error));
    assert.deepEqual(p, original);
  }
  const failedPost = await runLoad(
    p,
    {
      postmanCollectionId: "a",
      url: f.url,
      beforeScript,
      afterScript:
        "pm.collectionVariables.clear(); throw Error('post failed');",
    },
    { count: 3, concurrency: 2 },
  );
  assert.equal(failedPost.passed, 0);
  assert.equal(failedPost.mainRequests, 3);
  assert(
    failedPost.results.every(
      (r) => r.status === 200 && /post failed/.test(r.error),
    ),
  );
  assert.deepEqual(p, original);
});

test("collection load cancellation stops main HTTP and never persists pre-stage changes", async (t) => {
  const f = await fixture(t),
    p = project(),
    original = structuredClone(p),
    controller = new AbortController();
  const pending = runLoad(
    p,
    { postmanCollectionId: "a", url: f.url + "/hold", beforeScript },
    { count: 5, concurrency: 1, signal: controller.signal },
  );
  await f.arrived;
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.count, 1);
  assert.equal(result.mainRequests, 1);
  assert.equal(result.passed, 0);
  assert.equal(result.results[0].interrupted, true);
  assert.deepEqual(p, original);
});

test("owner load uses bound debug overrides without publishing scopes or changing saved project", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "load-collections-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  let p = await app.store.create("collection load");
  Object.assign(p, project());
  await app.store.save(p);
  p = await app.store.get(p.id);
  const original = structuredClone(p);
  const owner = async (action, method = "GET", body) => {
    const response = await fetch(app.url + `/api/projects/${p.id}/${action}`, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const debug = await owner(
    "debug-variables?environmentId=env&postmanCollectionId=a",
  );
  await owner("debug-variables", "PUT", {
    ...debug,
    variables: { ...debug.variables, shadow: "debug" },
  });
  const result = await owner("load", "POST", {
    environmentId: "env",
    request: {
      postmanCollectionId: "a",
      url: f.url + "/{{only}}/{{counter}}/{{shadow}}",
      beforeScript,
      afterScript,
    },
    count: 4,
    concurrency: 2,
  });
  assert.equal(result.passed, 4, JSON.stringify(result));
  assert(f.seen.every((r) => r.url === "/a/1/debug"));
  assert.deepEqual(await app.store.get(p.id), original);
  const after = await owner(
    "debug-variables?environmentId=env&postmanCollectionId=a",
  );
  assert.deepEqual(after.variables, { ...debug.variables, shadow: "debug" });
});

test(
  "collection child HTTP cancellation and duration retain existing stop semantics",
  { timeout: 10000 },
  async (t) => {
    for (const mode of ["cancelled", "duration"]) {
      const f = await fixture(t),
        p = project(),
        original = structuredClone(p),
        controller = new AbortController();
      const pending = runLoad(
        p,
        {
          postmanCollectionId: "a",
          url: f.url + "/main",
          beforeScript: `pm.collectionVariables.set('counter', 9); await pm.sendRequest(${JSON.stringify(f.url + "/hold")});`,
        },
        {
          count: 5,
          concurrency: 1,
          signal: controller.signal,
          mode: "duration",
          durationSeconds: mode === "duration" ? 1 : 60,
        },
      );
      await f.arrived;
      if (mode === "cancelled") controller.abort();
      const result = await pending;
      assert.equal(result.stopReason, mode);
      assert.equal(result.cancelled, mode === "cancelled");
      assert.equal(result.count, 1);
      assert.equal(result.mainRequests, 0);
      assert.equal(result.passed, 0);
      assert.equal(result.results[0].interrupted, true);
      assert.deepEqual(
        f.seen.map((r) => r.url),
        ["/hold"],
      );
      assert.deepEqual(p, original);
    }
  },
);

test("malformed collection types and redirect reject before effects; pre-abort and unbound writes remain safe", async (t) => {
  const f = await fixture(t),
    p = project();
  const invalid = structuredClone(p);
  invalid.postmanCollections.items[0].variables.counter = "not-a-number";
  await assert.rejects(
    runLoad(invalid, { postmanCollectionId: "a", url: f.url }, { count: 1 }),
    /Postman collection number 必须有限/,
  );
  await assert.rejects(
    runLoad(
      p,
      {
        postmanCollectionId: "a",
        url: f.url,
        redirect: { mode: "same-origin" },
      },
      { count: 1 },
    ),
    /重定向/,
  );
  const controller = new AbortController();
  controller.abort();
  const result = await runLoad(
    p,
    { postmanCollectionId: "a", url: f.url, beforeScript },
    { count: 3, signal: controller.signal },
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.count, 0);
  const unbound = await runLoad(
    p,
    { url: f.url, beforeScript: "pm.collectionVariables.set('x', 1);" },
    { count: 1 },
  );
  assert.equal(unbound.passed, 0);
  assert.equal(unbound.mainRequests, 0);
  assert.equal(f.seen.length, 0);
});
