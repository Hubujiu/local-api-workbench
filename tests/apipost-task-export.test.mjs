import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import {
  importIntoProject,
  normalizeRequest,
  snapshotPlan,
} from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const task = (id, type, data, enabled = 1) => ({
  id,
  name: id,
  type,
  enabled,
  data,
});
function sourceFor(url) {
  const source = modernApipostFixture();
  source.global.envs = [];
  source.global.servers = [];
  source.global.global_vars = {};
  const api = source.apis[1];
  api.url = url + "/login";
  api.name = "Login";
  api.request.header.parameter = [];
  api.request.query.parameter = [];
  api.request.pre_tasks = [
    task("pre-lexical", "customScript", 'const prefix="pre:";'),
    task("pre-wait", "wait", 15),
    task(
      "pre-use",
      "customScript",
      'pm.environment.set("preProof",prefix+"literal {{token}}");',
    ),
    task(
      "pre-disabled-pick",
      "pickVars",
      {
        source: "responseJson",
        variables: [
          { name: "", expression: "$..unsupported", type: "tempVars" },
        ],
      },
      0,
    ),
    task(
      "pre-disabled-assert",
      "assert",
      {
        type: "responseJson",
        expression: { path: "{{token}}", compareValue: "{{token}}" },
      },
      -1,
    ),
  ];
  api.request.post_tasks = [
    task("post-lexical", "customScript", 'const prefix="proof:";'),
    task("post-wait", "wait", 20),
    task("extract", "pickVars", {
      source: "responseJson",
      variables: [
        { name: "token", expression: "$.token", type: "envVars" },
        { name: "temporary", expression: "$.token", type: "tempVars" },
        { name: "globalProof", expression: "$.token", type: "globalVars" },
        { name: "nested", expression: "$.nested", type: "envVars" },
      ],
    }),
    task("business", "assert", {
      type: "responseJson",
      expression: { path: "$.ok", compareType: "eq", compareValue: "true" },
    }),
    task("status", "assert", {
      type: "responseCode",
      expression: { path: "", compareType: "uneq", compareValue: "400" },
    }),
    // Same IDs are legal independent tasks, not identities to deduplicate.
    task(
      "post-lexical",
      "customScript",
      'pm.environment.set("proof",prefix+pm.variables.get("temporary"));',
    ),
    task(
      "disabled-script",
      "customScript",
      'throw Error("disabled {{token}} must not run")',
      -1,
    ),
    task("disabled-wait", "wait", "{{token}}", 0),
    task(
      "disabled-pick",
      "pickVars",
      {
        source: "responseJson",
        variables: [
          { name: "disabled", expression: "{{token}}", type: "envVars" },
        ],
      },
      -1,
    ),
  ];
  const resource = structuredClone(api);
  resource.target_id = "resource";
  resource.name = "Resource";
  resource.url = url + "/resource";
  resource.request.pre_tasks = [];
  resource.request.post_tasks = [];
  resource.request.auth = { type: "bearer", bearer: { key: "{{token}}" } };
  source.apis.push(resource);
  return source;
}
const projectFor = () => {
  const p = {
    id: "p",
    name: "P",
    requests: [],
    environments: [],
    settings: {},
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
  importIntoProject(p, sourceFor("http://127.0.0.1:1"));
  return p;
};
const withoutTaskIds = (pipeline) => ({
  ...pipeline,
  before: pipeline.before.map(({ id, ...value }) => value),
  after: pipeline.after.map(({ id, ...value }) => value),
});

test("native API-local mixed task export preserves schemas, flags, lexical source and order without aliasing", () => {
  for (const format of [exportApipost, exportApipostDirectory]) {
    const p = projectFor(),
      before = structuredClone(p);
    const document = format(p);
    const copy = { requests: [], environments: [], settings: {} };
    importIntoProject(copy, document);
    const original = p.requests[0].nativeTasks;
    assert.deepEqual(
      withoutTaskIds(copy.requests[0].nativeTasks),
      withoutTaskIds(original),
    );
    if (format === exportApipost)
      assert.deepEqual(copy.requests[0].nativeTasks, original);
    assert.deepEqual(copy.requests[0].responses, p.requests[0].responses);
    assert.equal(copy.requests[0].beforeScript, "");
    assert.equal(copy.requests[0].afterScript, "");
    assert.equal(copy.requests[0].inheritSharedScripts, false);
    copy.requests[0].nativeTasks.after[2].data.variables[0].name = "changed";
    assert.deepEqual(p, before);
    assert.deepEqual(format(p), document);
  }
});

test("native task export rejects unsupported or ambiguous semantics atomically in both formats", () => {
  const changes = [
    (r) =>
      r.nativeTasks.after.push(
        task(
          "db",
          "database",
          {
            connectionId: "db",
            query: "SELECT 1",
            variables: [],
            isConsoleOutput: -1,
          },
          -1,
        ),
      ),
    ...["project", "folder", "request", "sample"].map((scope) => (r) => {
      r.nativeTasks.after.at(-1).origin = { scope, id: "source" };
    }),
    (r) => {
      delete r.nativeTasks.after[0].id;
    },
    (r) => {
      delete r.nativeTasks.after[0].name;
    },
    (r) => {
      r.scriptDialect = "legacy";
    },
    (r) => {
      r.beforeScript = "edited()";
    },
    (r) => {
      r.inheritSharedScripts = true;
    },
    (r) => {
      r.importedScriptTasks = { version: 1, before: [], after: [] };
    },
    (r) => {
      r.importedNativeTaskSource = { version: 1, before: [], after: [] };
    },
    (r) => {
      r.nativeTasks.after[2].data.variables[0].type = "unknown";
    },
    (r) => {
      r.nativeTasks.after[3].data.expression.compareType = "contains";
    },
    (r) => {
      r.nativeTasks.after[1].data = "20";
    },
    (r) => {
      r.nativeTasks.after[1].data = 1001;
    },
    (r) => {
      r.nativeTasks.after[0].unknown = true;
    },
    (r) => {
      r.nativeTasks.version = 2;
    },
    (r) => {
      r.nativeTasks = {
        version: 1,
        before: [],
        after: [task("only-script", "customScript", "const value=1;")],
      };
    },
    (r) => {
      r.nativeTasks = { version: 1, before: [], after: [] };
    },
  ];
  for (const mutate of changes)
    for (const format of [exportApipost, exportApipostDirectory]) {
      const p = projectFor();
      mutate(p.requests[0]);
      const before = structuredClone(p);
      assert.throws(() => format(p));
      assert.deepEqual(p, before);
    }
});

test("directory rejects frozen native task execution instead of erasing it or making it inert", () => {
  for (const tasks of [
    projectFor().requests[0].nativeTasks,
    { version: 1, before: [], after: [] },
    {
      version: 1,
      before: [task("disabled", "wait", "{{literal}}", -1)],
      after: [],
    },
  ]) {
    const p = projectFor();
    p.environments = [{ id: "e", name: "E", variables: {} }];
    p.plans = [
      snapshotPlan({
        id: "plan",
        name: "Plan",
        statusPolicy: "strict200",
        environmentId: "e",
        steps: [{ request: { ...p.requests[0], nativeTasks: tasks } }],
      }),
    ];
    const before = structuredClone(p);
    assert.throws(() => exportApipostDirectory(p), /冻结步骤nativeTasks/);
    assert.deepEqual(p, before);
  }
  const p = projectFor();
  p.requests[0] = normalizeRequest({
    id: "inert",
    url: "http://127.0.0.1:1",
    importedNativeTaskSource: {
      version: 1,
      before: [task("source", "customScript", "throw Error('inert')")],
      after: [],
    },
  });
  for (const format of [exportApipost, exportApipostDirectory])
    assert.throws(() => format(p), /importedNativeTaskSource/);
});

test("real HTTP import/run/native export/reimport/run/backup/restart retains fresh values and project/environment isolation", async (t) => {
  const received = [];
  let nonce = 0;
  const upstream = http.createServer((req, res) => {
    received.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        token: `fictional-${++nonce}`,
        ok: true,
        nested: { list: [0, false, ""] },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(tmpdir(), "native-task-roundtrip-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, document, method = "POST") => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(document === undefined ? {} : { body: JSON.stringify(document) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const importProject = async (document) => {
    const p = await app.store.create("Roundtrip");
    const result = await call(`/api/projects/${p.id}/import`, { document });
    assert.equal(result.status, 200, JSON.stringify(result));
    return app.store.get(p.id);
  };
  const source = sourceFor(`http://127.0.0.1:${upstream.address().port}`),
    original = structuredClone(source);
  const first = await importProject(source),
    other = await importProject(source);
  first.environments.push({
    id: "separate",
    name: "Separate",
    variables: { token: "untouched" },
  });
  await app.store.save(first);
  const run = async (id) => {
    const project = await app.store.get(id),
      environmentId = project.environments[0].id;
    const login = await call(`/api/projects/${id}/execute`, {
      request: project.requests[0],
      environmentId,
    });
    assert.equal(login.status, 200, JSON.stringify(login));
    assert.equal(login.value.outcome, "passed", JSON.stringify(login));
    const saved = await app.store.get(id),
      token = saved.environments[0].variables.token;
    assert.equal(saved.environments[0].variables.proof, "proof:" + token);
    assert.equal(
      saved.environments[0].variables.preProof,
      "pre:literal {{token}}",
    );
    assert.equal(saved.globalVariables.globalProof, token);
    assert.deepEqual(saved.environments[0].variables.nested, {
      list: [0, false, ""],
    });
    assert.equal(saved.environments[0].variables.temporary, undefined);
    assert.equal(saved.environments[0].variables.disabled, undefined);
    const resource = await call(`/api/projects/${id}/execute`, {
      request: project.requests[1],
      environmentId,
    });
    assert.equal(resource.status, 200, JSON.stringify(resource));
    assert.equal(resource.value.outcome, "passed", JSON.stringify(resource));
    assert.equal(received.at(-1).auth, "Bearer " + token);
    return token;
  };
  const firstToken = await run(first.id);
  const firstAfterRun = await app.store.get(first.id);
  await run(other.id);
  assert.deepEqual(await app.store.get(first.id), firstAfterRun);
  const copies = [];
  for (const format of ["apipost", "apipost-directory"]) {
    const before = await app.store.get(first.id),
      hits = received.length;
    const noToken = await fetch(
      `${app.url}/api/projects/${first.id}/export?format=${format}`,
    );
    assert.equal(noToken.status, 403);
    const exported = await call(
      `/api/projects/${first.id}/export?format=${format}`,
      undefined,
      "GET",
    );
    assert.equal(exported.status, 200, JSON.stringify(exported));
    assert.equal(received.length, hits, "export must never execute tasks");
    assert.deepEqual(await app.store.get(first.id), before);
    const copy = await importProject(exported.value);
    copies.push(copy.id);
    assert.deepEqual(
      withoutTaskIds(copy.requests[0].nativeTasks),
      withoutTaskIds(before.requests[0].nativeTasks),
    );
    assert.notEqual(
      await run(copy.id),
      firstToken,
      "run must extract fresh response, not replay saved values",
    );
    assert.deepEqual(await app.store.get(first.id), before);
  }
  const hits = received.length;
  const foreign = await call(`/api/projects/${first.id}/execute`, {
    request: first.requests[0],
    environmentId: other.environments[0].id,
  });
  assert.equal(foreign.status, 400);
  assert.equal(received.length, hits);
  assert.equal(
    (await app.store.get(first.id)).environments[1].variables.token,
    "untouched",
  );
  const backup = await call(
    `/api/projects/${first.id}/export`,
    undefined,
    "GET",
  );
  assert.equal(backup.status, 200);
  const restored = await call("/api/restore", { document: backup.value });
  assert.equal(restored.status, 201, JSON.stringify(restored));
  assert.deepEqual(
    restored.value.requests[0].nativeTasks,
    first.requests[0].nativeTasks,
  );
  await stop();
  app = await createApp({ root, port: 0 });
  assert.equal(
    received.length,
    hits,
    "restart and restore must not replay tasks",
  );
  for (const id of [first.id, ...copies, restored.value.id]) await run(id);
  const disk = await new Store(root).get(first.id);
  assert.deepEqual(disk.requests[0].nativeTasks, first.requests[0].nativeTasks);
  assert.equal(disk.environments[1].variables.token, "untouched");
  assert.deepEqual(source, original);
});

test("authenticated export and malformed reimport failures leave memory, disk and backup unchanged", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "native-task-rejection-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (p, action, value, method = "GET") => {
    const response = await fetch(`${app.url}/api/projects/${p.id}/${action}`, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    return { status: response.status, value: await response.json() };
  };
  for (const change of [
    (p) => {
      p.requests[0].nativeTasks.after.at(-1).origin = {
        scope: "folder",
        id: "original-folder",
      };
    },
    (p) => {
      p.requests[0].nativeTasks.after.push(
        task(
          "db",
          "database",
          {
            connectionId: "unbound",
            query: "SELECT 1",
            variables: [],
            isConsoleOutput: -1,
          },
          -1,
        ),
      );
    },
    (p) => {
      p.plans = [
        snapshotPlan({
          id: "plan",
          name: "Plan",
          statusPolicy: "strict200",
          environmentId: p.environments[0].id,
          steps: [{ request: p.requests[0] }],
        }),
      ];
    },
    (p) => {
      p.requests[0].importedScriptTasks = { version: 1, before: [], after: [] };
    },
  ]) {
    const p = await app.store.create("Rejected export");
    importIntoProject(p, sourceFor("http://127.0.0.1:1"));
    change(p);
    await app.store.save(p);
    const before = await app.store.get(p.id),
      disk = await readFile(app.store.file(p.id));
    for (const format of ["apipost", "apipost-directory"]) {
      const result = await call(p, "export?format=" + format);
      assert.equal(result.status, 400, JSON.stringify(result));
      assert.match(result.value.error, /备份/);
      assert.deepEqual(await app.store.get(p.id), before);
      assert.deepEqual(await readFile(app.store.file(p.id)), disk);
    }
    assert.deepEqual((await call(p, "export")).value, before);
  }
  const p = await app.store.create("Atomic import");
  importIntoProject(p, sourceFor("http://127.0.0.1:1"));
  await app.store.save(p);
  const before = await app.store.get(p.id),
    disk = await readFile(app.store.file(p.id));
  const exported = exportApipost(p);
  for (const format of ["apipost", "apipost-directory"]) {
    const document =
      format === "apipost"
        ? structuredClone(exported)
        : exportApipostDirectory(p);
    let request;
    let file;
    if (format === "apipost")
      request = document.apis.find((node) => node.name === "Login").request;
    else {
      file = document.files.find(
        (entry) =>
          /^apis\/a[^/]+\.json$/.test(entry.path) &&
          JSON.parse(entry.text).data.name === "Login",
      );
      request = JSON.parse(file.text).data.request;
    }
    request.post_tasks[2].data.variables[0].type = "unsupported-scope";
    if (file) {
      const value = JSON.parse(file.text);
      value.data.request = request;
      file.text = JSON.stringify(value);
    }
    const result = await call(p, "import", { document }, "POST");
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.deepEqual(await app.store.get(p.id), before);
    assert.deepEqual(await readFile(app.store.file(p.id)), disk);
  }
});

test("native export validates request descriptors and data limits before reading or normalizing task fields", () => {
  for (const key of [
    "nativeTasks",
    "inheritSharedScripts",
    "beforeScript",
    "afterScript",
    "before",
    "after",
    "sharedBeforeScripts",
    "sharedAfterScripts",
    "scriptDialect",
    "importedScriptTasks",
    "importedNativeTaskSource",
  ]) {
    for (const format of [exportApipost, exportApipostDirectory]) {
      let reads = 0;
      const p = projectFor(),
        value = p.requests[0][key];
      Object.defineProperty(p.requests[0], key, {
        enumerable: true,
        configurable: true,
        get() {
          reads++;
          return value;
        },
      });
      assert.throws(() => format(p), /访问器/);
      assert.equal(reads, 0);
      Object.defineProperty(p.requests[0], key, {
        enumerable: false,
        configurable: true,
        value,
      });
      assert.throws(() => format(p), /隐藏字段/);
    }
  }
  const inherited = projectFor(),
    pipeline = inherited.requests[0].nativeTasks;
  delete inherited.requests[0].nativeTasks;
  let reads = 0;
  Object.setPrototypeOf(inherited.requests[0], {
    get nativeTasks() {
      reads++;
      return pipeline;
    },
  });
  assert.throws(() => exportApipost(inherited), /继承属性/);
  assert.equal(reads, 0);
  for (const [size, accepted] of [
    [16, true],
    [17, false],
  ]) {
    const p = projectFor();
    p.requests[0].nativeTasks.before = Array.from({ length: size }, (_, i) =>
      task("wait" + i, "wait", 0),
    );
    if (accepted) assert.doesNotThrow(() => exportApipost(p));
    else assert.throws(() => exportApipost(p), /超限|16/);
  }
  for (const [duration, accepted] of [
    [500, true],
    [501, false],
  ]) {
    const p = projectFor();
    p.requests[0].nativeTasks.before = [
      task("a", "wait", 500),
      task("b", "wait", duration),
    ];
    if (accepted) assert.doesNotThrow(() => exportApipost(p));
    else assert.throws(() => exportApipost(p), /1000/);
  }
});

test("mixed task export validates pure-script phase import limits without trimming source or injecting tasks", () => {
  const make = (before) => {
    const p = projectFor();
    p.requests[0].nativeTasks = {
      version: 1,
      before,
      after: [task("wait", "wait", 0)],
    };
    return p;
  };
  const metadata = make(
    Array.from({ length: 10 }, (_, i) => ({
      ...task("x".repeat(100) + i, "customScript", "const value" + i + "=1;"),
      name: "y".repeat(100),
    })),
  );
  const merged = make([
    task("one", "customScript", "x".repeat(32768)),
    task("two", "customScript", "y".repeat(32768)),
  ]);
  for (const [p, error] of [
    [metadata, /导入说明上限/],
    [merged, /合并脚本/],
  ]) {
    const before = structuredClone(p);
    assert.doesNotThrow(
      () => normalizeRequest(p.requests[0]),
      "valid canonical runtime does not guarantee native interchange",
    );
    for (const format of [exportApipost, exportApipostDirectory])
      assert.throws(() => format(p), error);
    assert.deepEqual(p, before);
  }
  const p = make([
    task("first", "customScript", "  const first=1;\n"),
    task("disabled", "customScript", "literal {{token}}", 0),
  ]);
  for (const format of [exportApipost, exportApipostDirectory]) {
    const copy = { requests: [], environments: [], settings: {} };
    importIntoProject(copy, format(p));
    assert.deepEqual(
      withoutTaskIds(copy.requests[0].nativeTasks),
      withoutTaskIds(p.requests[0].nativeTasks),
    );
    assert.equal(copy.requests[0].nativeTasks.before.length, 2);
  }
});
