import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importIntoProject, restoreProject, runPlan } from "../src/core.mjs";
import { scopedExecution } from "../src/variable-scopes.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
const original = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/original-offline2/native-echo-original.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

for (const filename of [
  "native-echo-original.json",
  "native-echo-reexport.json",
]) {
  const original = JSON.parse(
    await readFile(
      new URL("./fixtures/original-offline2/" + filename, import.meta.url),
      "utf8",
    ),
  );
  test(
    "official Offline2 " +
      filename +
      " preserves the observed request through import, persistence and backup restore",
    async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "original-import-"));
      const seen = [];
      const server = http.createServer(async (req, res) => {
        let body = "";
        for await (const b of req) body += b;
        seen.push({ method: req.method, path: req.url, body });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(seen.at(-1)));
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      t.after(async () => {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        await rm(root, { recursive: true, force: true });
      });
      const store = new Store(root),
        p = await store.create("Original source acceptance");
      const sourceBefore = JSON.stringify(original);
      assert.equal(importIntoProject(p, original).length, 1);
      assert.equal(JSON.stringify(original), sourceBefore);
      // Change only the fixture port; source path, query, method and body stay intact.
      p.requests[0].url = p.requests[0].url.replace(
        "127.0.0.1:18766",
        `127.0.0.1:${server.address().port}`,
      );
      await store.save(p);
      const loaded = await new Store(root).get(p.id);
      assert.equal((await executeRequest(loaded.requests[0])).status, 200);
      const restored = restoreProject(structuredClone(loaded));
      await store.save(restored);
      assert.equal(
        (await executeRequest((await store.get(restored.id)).requests[0]))
          .status,
        200,
      );
      const expected = {
        method: "POST",
        path: "/echo?fixture=original",
        body: '{"message":"fictional","number":7}',
      };
      assert.deepEqual(seen, [expected, expected]);
      assert.notEqual(restored.id, p.id);
      assert.equal(
        loaded.requests[0].sourceOperationId,
        "apipost:" + original.apis[0].target_id,
      );
    },
  );
}

test("synthetic variations remove only mirrored query occurrences and retain independent raw fields", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "query-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const cases = [
    {
      url: "http://example.test/echo?a=x&a=x&unrelated=%2f#fragment",
      rows: [
        { key: "a", value: "x", is_checked: 1 },
        { key: "a", value: "x", is_checked: 1 },
      ],
      expected: "http://example.test/echo?unrelated=%2f#fragment",
      count: 2,
    },
    {
      url: "http://example.test/echo?encoded=a%2Bb&space=a+b",
      rows: [
        { key: "encoded", value: "a+b", is_checked: 1 },
        { key: "space", value: "a b", is_checked: 1 },
      ],
      expected: "http://example.test/echo",
      count: 2,
    },
    {
      url: "http://example.test/echo?raw=keep",
      rows: [{ key: "disabled", value: "no", is_checked: -1 }],
      expected: "http://example.test/echo?raw=keep",
      count: 1,
    },
    {
      url: "http://example.test/echo?flag",
      rows: [{ key: "flag", value: "", is_checked: 1 }],
      expected: "http://example.test/echo",
      count: 1,
    },
  ];
  for (const c of cases) {
    const doc = structuredClone(original);
    doc.apis[0].url = c.url;
    doc.apis[0].request.query.parameter = c.rows;
    const p = await store.create("variation");
    importIntoProject(p, doc);
    assert.equal(p.requests[0].url, c.expected);
    assert.equal(p.requests[0].query.length, c.count);
  }
});

test("genuine original script export executes pre-variable HTTP post-response scopes with persistence and project isolation", async (t) => {
  const document = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/original-offline2/native-echo-scripts.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "original-scripts-"));
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    seen.push({ path: req.url, body });
    res.setHeader("content-type", "application/json");
    res.end('{"fixture":"native-roundtrip"}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    project = await store.create("native scripts"),
    other = await store.create("isolation witness");
  importIntoProject(project, document);
  const env = project.environments.at(-1);
  assert.equal(env.variables.native_after, "native-roundtrip");
  assert.equal(env.variableDefinitions.native_after.initialValue, "");
  env.variables = {}; // prove imported scripts execute, not merely prior exported values
  project.requests[0].url = project.requests[0].url.replace(
    "127.0.0.1:18766",
    `127.0.0.1:${server.address().port}`,
  );
  await store.save(project);
  const saved = await store.get(project.id),
    request = saved.requests[0];
  const result = await runPlan(
    { steps: [{ request }] },
    {},
    executeRequest,
    scopedExecution(store, saved, env.id),
  );
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.deepEqual(seen, [
    {
      path: "/echo?fixture=original",
      body: '{"message":"from-before","number":7}',
    },
  ]);
  assert.equal(result.variables.native_value, "from-before");
  assert.equal(result.variables.native_after, "native-roundtrip");
  assert.deepEqual(
    result.results[0].logs.filter((l) => l.message).map((l) => l.message),
    ["native-before", "native-after"],
  );
  const reopened = await new Store(root).get(project.id);
  assert.equal(
    reopened.environments.find((e) => e.id === env.id).variables.native_after,
    "native-roundtrip",
  );
  assert.equal(
    (await store.get(other.id)).environments[0].variables.native_after,
    undefined,
  );
  const restored = restoreProject(structuredClone(reopened));
  assert.equal(restored.requests[0].scriptDialect, "apipost8");
  assert.deepEqual(
    restored.requests[0].importedScriptTasks,
    request.importedScriptTasks,
  );
  // Safety variations are synthetic, not attributed to original execution behavior.
  const bad = structuredClone(request);
  bad.beforeScript = 'throw Error("fixture-pre-stop")';
  const failed = await runPlan(
    { steps: [{ request: bad }] },
    {},
    executeRequest,
  );
  assert.equal(failed.status, "failed");
  assert.equal(seen.length, 1);
  assert.match(failed.results[0].error, /fixture-pre-stop/);
  const afterBad = structuredClone(request);
  afterBad.afterScript = 'throw Error("fixture-post-stop")';
  const afterFailed = await runPlan(
    { steps: [{ request: afterBad }] },
    {},
    executeRequest,
  );
  assert.equal(afterFailed.status, "failed");
  assert.equal(seen.length, 2);
  assert.equal(afterFailed.results[0].response.status, 200);
  assert.match(afterFailed.results[0].error, /fixture-post-stop/);
});
