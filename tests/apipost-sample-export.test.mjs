import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import {
  importIntoProject,
  snapshotPlan,
  runPlan,
  restoreProject,
} from "../src/core.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import {
  environmentVariables,
  resolveServiceRequest,
} from "../src/environments.mjs";
import { nativeSampleExportFixture } from "./fixtures/apipost-sample-export.mjs";
const formats = [exportApipost, exportApipostDirectory];
const empty = (id = "target") => ({
  id,
  name: id,
  requests: [],
  environments: [],
  folders: [],
  settings: {},
  servers: [],
  cases: [],
  caseFolders: [],
});
const imported = (source, id) => {
  const p = empty(id);
  importIntoProject(p, source);
  return p;
};
const graph = (p) => ({
  cases: p.cases.map((c) => ({
    name: c.name,
    api: p.requests.findIndex((r) => r.id === c.sourceRequestId),
    group: c.folderId
      ? p.caseFolders.findIndex((g) => g.id === c.folderId)
      : -1,
    url: c.request.url,
    body: c.request.body,
    auth: c.request.auth,
    snapshots: [
      c.request.authSnapshot,
      c.request.parametersSnapshot,
      c.request.serviceSnapshot,
      c.request.sharedScriptsSnapshot,
    ],
  })),
  groups: p.caseFolders.map((g) => ({
    name: g.name,
    sort: g.sort,
    api: p.requests.findIndex((r) => r.id === g.sourceRequestId),
    parent: g.parentId
      ? p.caseFolders.findIndex((x) => x.id === g.parentId)
      : -1,
  })),
});

test("native HTTP samples and empty groups preserve API ownership, current order and identity graphs in both formats twice", () => {
  const p = imported(nativeSampleExportFixture(), "source"),
    before = structuredClone(p),
    expected = graph(p);
  assert.deepEqual(
    p.cases.map((c) => c.name),
    ["grouped", "other", "root"],
  );
  for (const encode of formats) {
    const document = encode(p);
    const one = imported(document, "first"),
      two = imported(encode(one), "second");
    assert.deepEqual(graph(one), expected);
    assert.deepEqual(graph(two), expected);
    assert.equal(one.requests.length, 2);
    assert.equal(one.cases.length, 3);
    assert.equal(one.caseFolders.length, 2);
    assert.equal(
      one.cases.some((c) => c.folderId === one.caseFolders[1].id),
      false,
    );
    if (document.files) {
      const index = JSON.parse(
        document.files.find((f) => f.path === "samples/index.json").text,
      );
      assert.equal(index.items.length, 5);
      for (const row of index.items) {
        const detail = JSON.parse(
          document.files.find(
            (f) => f.path === "samples/" + row.sample_id + ".json",
          ).text,
        );
        for (const [k, v] of Object.entries(row))
          assert.deepEqual(detail.data[k], v);
      }
    }
  }
  assert.deepEqual(p, before);
});

test("sample export rejects unrepresentable live API reinheritance and incomplete or unsupported graphs without mutation", () => {
  const original = imported(nativeSampleExportFixture(), "source");
  const changes = [
    (p) =>
      p.requests[0].headers.push({ key: "X-Live-Only", value: "not-in-case" }),
    (p) => p.requests[0].query.push({ key: "liveOnly", value: "not-in-case" }),
    (p) =>
      p.requests[0].cookies.push({ key: "liveOnly", value: "not-in-case" }),
    (p) => {
      p.requests[0].bodyType = "urlencoded";
      p.requests[0].form = [{ key: "liveOnly", value: "not-in-case" }];
    },
    (p) => {
      p.requests[0].beforeScript = "apt.setVar('liveOnly','injected')";
      p.requests[0].scriptDialect = "apipost8";
    },
    (p) => (p.cases[0].request.beforeScript = "apt.setVar('unsupported',1)"),
    (p) => (p.cases[0].request.schema = { type: "object" }),
    (p) => (p.cases[0].functions = [{ name: "custom" }]),
    (p) => (p.cases[0].unknown = "metadata"),
    (p) => (p.caseFolders[0].unknown = "metadata"),
    (p) => (p.caseFolders[1].parentId = p.caseFolders[1].id),
    (p) => (p.caseFolders[0].sourceRequestId = p.requests[1].id),
    (p) => (p.cases[0].sourceRequestId = "missing"),
    (p) => (p.requests[0].deletedAt = "2026-01-01T00:00:00Z"),
    (p) => p.cases.push(structuredClone(p.cases[0])),
    (p) => (p.cases[0].request.authSnapshot = false),
  ];
  for (const change of changes)
    for (const encode of formats) {
      const p = structuredClone(original);
      change(p);
      const before = structuredClone(p);
      assert.throws(() => encode(p));
      assert.deepEqual(p, before);
    }
  // Explicit noauth overrides live API auth; raw API body is not inherited.
  const auth = structuredClone(original);
  auth.requests[0].auth = { type: "bearer", token: "fictional-live-only" };
  auth.requests[0].bodyType = "json";
  auth.requests[0].body = '{"liveOnly":true}';
  for (const encode of formats) {
    const q = imported(encode(auth), "auth");
    assert(q.cases.every((c) => c.request.auth.type === "none"));
    assert.deepEqual(
      q.cases.map((c) => c.request.body),
      original.cases.map((c) => c.request.body),
    );
  }
});

test("same native sample IDs in distinct source namespaces and explicit current sort remain distinct", () => {
  const a = nativeSampleExportFixture(),
    b = nativeSampleExportFixture("http://127.0.0.1:2");
  b.project_id = "second-source";
  b.global.servers = [];
  b.global.envs = [];
  for (const node of [...b.apis, ...b.samples]) node.project_id = b.project_id;
  const p = imported(a, "merged");
  importIntoProject(p, b);
  // Namespace-safe identities; current array order may be explicitly reordered.
  p.cases[0].sort = 50;
  const names = p.cases
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.sort ?? a.i) - (b.c.sort ?? b.i))
    .map(({ c }) => c.request.url);
  for (const encode of formats) {
    const q = imported(encode(p), "read");
    assert.equal(new Set(q.cases.map((c) => c.id)).size, 6);
    assert.equal(q.caseFolders.length, 4);
    assert.deepEqual(
      q.cases.map((c) => c.request.url),
      names,
    );
    assert.deepEqual(
      imported(encode(q), "again").cases.map((c) => c.request.url),
      names,
    );
  }
});

test(
  "sample definition interchange is zero-network and frozen cases execute unchanged after live edits, backup and restart",
  { timeout: 30000 },
  async (t) => {
    const seen = [],
      server = http.createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        seen.push({
          url: req.url,
          body,
          auth: req.headers.authorization,
          live: req.headers["x-live-only"],
        });
        res.end("{}");
      });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const root = await mkdtemp(path.join(tmpdir(), "native-sample-export-")),
      store = new Store(root);
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const source = await store.create("source"),
      other = await store.create("other");
    importIntoProject(
      source,
      nativeSampleExportFixture(`http://127.0.0.1:${server.address().port}`),
    );
    await store.save(source);
    const sourceBefore = await store.get(source.id),
      otherBefore = await store.get(other.id);
    for (const encode of formats) {
      const one = await store.create("one"),
        two = await store.create("two");
      one.environments = [];
      two.environments = [];
      importIntoProject(one, encode(source));
      importIntoProject(two, encode(one));
      const count = seen.length;
      assert.equal(count, encode === formats[0] ? 0 : 6);
      const expected = structuredClone(two.cases),
        envId = two.environments.find((e) =>
          Object.hasOwn(e.variables, "id"),
        ).id;
      for (const api of two.requests) {
        api.url = "http://127.0.0.1:1/changed";
        api.auth = { type: "bearer", token: "fictional-live" };
        api.headers.push({ key: "X-Live-Only", value: "changed" });
        api.body = '{"changed":true}';
      }
      await store.save(two);
      const run = async (p) => {
        const plan = snapshotPlan({
          name: "frozen cases",
          environmentId: envId,
          steps: p.cases.map((c) => ({ name: c.name, request: c.request })),
        });
        const r = await runPlan(
          plan,
          environmentVariables(p, envId),
          executeRequest,
          {
            prepareRequest: (request) =>
              resolveServiceRequest(p, request, envId),
          },
        );
        assert.equal(r.status, "passed", JSON.stringify(r.results));
        assert.equal(r.results.length, 3);
        await store.append(p.id, "runs", r);
        assert.deepEqual(p.cases, expected);
      };
      await run(await store.get(two.id));
      const backup = await store.get(two.id),
        restored = restoreProject(backup);
      await store.save(restored);
      const restarted = await new Store(root).get(restored.id);
      assert.deepEqual(restarted.cases, expected);
      await run(restarted);
      assert.equal((await store.get(restored.id)).runs.length, 2);
      const wire = seen.slice(count);
      assert.equal(wire.length, 6);
      assert(wire.every((x) => x.auth === undefined && x.live === undefined));
      assert.deepEqual(
        wire.map((x) => x.url),
        [
          "/case-grouped",
          "/case-other",
          "/case-root",
          "/case-grouped",
          "/case-other",
          "/case-root",
        ],
      );
      assert(wire.every((x) => JSON.parse(x.body).id === "43"));
    }
    assert.deepEqual(await store.get(source.id), sourceBefore);
    assert.deepEqual(await store.get(other.id), otherBefore);
  },
);
