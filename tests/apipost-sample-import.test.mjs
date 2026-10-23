import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { snapshotCase } from "../src/cases.mjs";
import {
  resolveServiceRequest,
  environmentVariables,
} from "../src/environments.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { importIntoProject, runPlan } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

test("explicit service binding in a case resolves in each selected environment despite snapshot flags", async (t) => {
  const servers = [];
  const environments = [];
  for (const name of ["a", "b"]) {
    const server = http.createServer((req, res) => res.end(name + req.url));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    environments.push({
      id: name,
      name,
      variables: {},
      serverUrls: { service: "http://127.0.0.1:" + server.address().port },
    });
  }
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
  const item = snapshotCase({
    name: "Bound",
    sourceRequestId: "origin",
    request: { url: "/items", serviceId: "service" },
  });
  const p = { servers: [{ id: "service", name: "Service" }], environments };
  assert.equal(item.request.serviceSnapshot, true);
  for (const name of ["a", "b"])
    assert.equal(
      (await executeRequest(resolveServiceRequest(p, item.request, name))).body,
      name + "/items",
    );
  assert.equal(item.request.url, "/items");
});

test("flat modern samples become independent cases linked to imported APIs", () => {
  const source = modernApipostFixture();
  source.samples = [
    {
      sample_id: "sample-one",
      parent_id: "0",
      target_id: "api",
      project_id: "fixture",
      name: "Alternative",
      type: "sample",
      method: "POST",
      url: "/alternative/{{id}}",
      sort: 1,
      description: "sample description",
      protocol: "http/1.1",
      request: {
        auth: { type: "noauth" },
        body: { mode: "plain", raw: "sample body" },
        header: { parameter: [] },
        query: { parameter: [] },
        cookie: { parameter: [] },
        restful: { parameter: [] },
        pre_tasks: [],
        post_tasks: [],
      },
      response: { example: [] },
    },
  ];
  const p = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
  importIntoProject(p, source);
  assert.equal(p.requests.length, 1);
  assert.equal(p.cases.length, 1);
  assert.match(p.requests[0].importNotes.join("\n"), /根级样例/);
  assert.equal(p.cases[0].sourceRequestId, p.requests[0].id);
  assert.equal(p.cases[0].request.url, "/alternative/{{id}}");
  assert.equal(p.cases[0].request.body, "sample body");
  assert.equal(p.cases[0].request.description, "sample description");
});

function sampleFixture() {
  const source = modernApipostFixture();
  source.samples = [
    {
      sample_id: "root-sample",
      parent_id: "0",
      target_id: "api",
      project_id: "fixture",
      name: "Root sample",
      type: "sample",
      method: "POST",
      url: "/case/{{id}}",
      protocol: "http/1.1",
      request: {
        auth: { type: "noauth" },
        body: { mode: "plain", raw: "sample-body" },
        header: { parameter: [{ key: "X-Own", value: "own", is_checked: 1 }] },
        query: { parameter: [] },
        cookie: { parameter: [] },
        restful: { parameter: [] },
        pre_tasks: [],
        post_tasks: [],
      },
      response: { example: [] },
    },
  ];
  return source;
}
function destination() {
  return {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
}
const script = (id, data) => ({
  type: "customScript",
  id,
  name: id,
  enabled: 1,
  data,
});

test("imported root samples preserve selected-environment service addresses and folder scripts without executing origin API tasks", async (t) => {
  const seen = [],
    servers = [],
    source = sampleFixture();
  for (const name of ["A", "B"]) {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({ name, url: req.url, body, headers: req.headers });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ stage: req.headers["x-script"] }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
  }
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
  source.global.envs[0].name = "A";
  source.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + servers[0].address().port;
  const second = structuredClone(source.global.envs[0]);
  second.env_id = "2";
  second.name = "B";
  second.server_list[0].uri = "http://127.0.0.1:" + servers[1].address().port;
  second.env_var_list.id.current_value = "99";
  source.global.envs.push(second);
  source.global.global_param.header.parameter = [
    { key: "X-Global", value: "g", is_checked: 1 },
  ];
  source.apis[0].request.header = {
    parameter: [{ key: "X-Folder", value: "f", is_checked: 1 }],
  };
  source.global.global_param.pre_tasks = [
    script("global", 'const globalPart="g";'),
  ];
  source.apis[0].request.pre_tasks = [
    script("folder", 'const folderPart="f";'),
  ];
  source.apis[1].request.pre_tasks = [
    script("origin", 'throw Error("origin API must not run");'),
  ];
  source.samples[0].request.pre_tasks = [
    script("sample", 'pm.setRequestHeader("x-script",globalPart+folderPart);'),
  ];
  source.samples[0].request.post_tasks = [
    script(
      "after",
      'pm.test("sample wire",()=>pm.expect(pm.response.json().stage).to.equal("gf"));',
    ),
  ];
  const before = structuredClone(source),
    p = destination();
  importIntoProject(p, source);
  assert.deepEqual(source, before);
  assert.deepEqual(seen, []);
  const item = p.cases[0],
    saved = structuredClone(item);
  assert.deepEqual(
    item.request.importedScriptTasks.before.map((task) => task.origin.scope),
    ["project", "folder", "sample"],
  );
  assert.equal(
    item.request.importedScriptTasks.before.at(-1).origin.id,
    "root-sample",
  );
  for (const name of ["A", "B"]) {
    const env = p.environments.find((env) => env.name === name);
    const result = await runPlan(
      { steps: [{ request: resolveServiceRequest(p, item.request, env.id) }] },
      environmentVariables(p, env.id),
      executeRequest,
    );
    assert.equal(result.status, "passed", JSON.stringify(result));
  }
  assert.deepEqual(
    seen.map((x) => [x.name, x.url, x.body]),
    [
      ["A", "/case/43", "sample-body"],
      ["B", "/case/99", "sample-body"],
    ],
  );
  for (const entry of seen) {
    assert.equal(entry.headers["x-global"], "g");
    assert.equal(entry.headers["x-folder"], "f");
    assert.equal(entry.headers["x-own"], "own");
    assert.equal(entry.headers["x-test"], undefined);
    assert.equal(entry.headers["x-script"], "gf");
  }
  assert.deepEqual(item, saved);
});

test("unsupported or conflicting samples reject the whole import before mutation", () => {
  for (const change of [
    (d) => (d.samples[0].target_id = "missing"),
    (d) => (d.samples[0].parent_id = "group"),
    (d) => (d.samples[0].type = "sample_group"),
    (d) => (d.samples[0].unknown = true),
    (d) => (d.samples[0].protocol = "ftp"),
    (d) => d.samples.push(structuredClone(d.samples[0])),
    (d) => d.global.servers.push({ server_id: "2", name: "Other" }),
    (d) =>
      d.samples[0].request.pre_tasks.push({
        type: "database",
        id: "sql",
        name: "SQL",
        enabled: 1,
        data: {},
      }),
  ]) {
    const source = sampleFixture(),
      p = destination(),
      before = structuredClone(p);
    change(source);
    assert.throws(() => importIntoProject(p, source));
    assert.deepEqual(p, before);
  }
  const source = sampleFixture(),
    p = destination();
  importIntoProject(p, source);
  const before = structuredClone(p);
  assert.throws(() => importIntoProject(p, source), /冲突/);
  assert.deepEqual(p, before);
  const full = destination();
  full.cases = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
  const old = structuredClone(full);
  assert.throws(() => importIntoProject(full, sampleFixture()), /1000/);
  assert.deepEqual(full, old);
});

test("HTTP import, restart, explicit case execution and local restore preserve sample linkage", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  let executions = 0;
  const fixture = http.createServer((req, res) => {
    executions++;
    res.end("sample endpoint");
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(join(tmpdir(), "apipost-samples-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    if (app.server.listening) await new Promise((r) => app.server.close(r));
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (url, method = "GET", body) => {
    const r = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(r.ok, true, await r.clone().text());
    return r.json();
  };
  const p = await call("/api/projects", "POST", { name: "Sample import" }),
    source = groupedFixture();
  source.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + fixture.address().port;
  const imported = await call("/api/projects/" + p.id + "/import", "POST", {
    document: source,
  });
  assert.equal(executions, 0);
  await new Promise((r) => app.server.close(r));
  app = await createApp({ root, port: 0 });
  const backup = await call("/api/projects/" + p.id + "/export"),
    copy = await call("/api/restore", "POST", { document: backup });
  assert.equal(executions, 0);
  for (const project of [backup, copy]) {
    const item = project.cases[0],
      env = project.environments.find((env) => env.name === "Imported");
    assert.equal(
      item.sourceRequestId,
      project.requests.find(
        (request) => request.sourceOperationId === "apipost:api",
      ).id,
    );
    const result = await call(
      "/api/projects/" + project.id + "/execute",
      "POST",
      {
        request: item.request,
        functions: item.functions,
        environmentId: env.id,
      },
    );
    assert.equal(result.outcome, "passed", JSON.stringify(result));
    assert.equal(result.body, "sample endpoint");
  }
  assert.equal(executions, 2);
  assert.deepEqual(copy.cases, imported.cases);
  assert.deepEqual(copy.caseFolders, imported.caseFolders);
  assert.notEqual(copy.id, p.id);
});

test("sample array and record accessors are rejected without invocation", () => {
  for (const arrayGetter of [false, true]) {
    const source = sampleFixture(),
      p = destination(),
      before = structuredClone(p);
    let calls = 0;
    if (arrayGetter)
      Object.defineProperty(source.samples, "0", {
        enumerable: true,
        get() {
          calls++;
          return {};
        },
      });
    else
      Object.defineProperty(source.samples[0], "name", {
        enumerable: true,
        get() {
          calls++;
          return "Bad";
        },
      });
    assert.throws(() => importIntoProject(p, source));
    assert.equal(calls, 0);
    assert.deepEqual(p, before);
  }
});

function groupedFixture() {
  const source = sampleFixture();
  source.samples.unshift(
    {
      sample_id: "group",
      parent_id: "0",
      target_id: "api",
      project_id: "fixture",
      type: "sample_group",
      name: "Imported group",
      sort: 1,
    },
    {
      sample_id: "empty",
      parent_id: "group",
      target_id: "api",
      project_id: "fixture",
      type: "sample_group",
      name: "Empty group",
      sort: 2,
    },
  );
  const grouped = structuredClone(source.samples[2]);
  grouped.sample_id = "grouped";
  grouped.name = "Grouped case";
  grouped.parent_id = "group";
  source.samples.push(grouped);
  return source;
}
test("sample groups preserve hierarchy and grouped requests include API ancestry while roots do not", async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const source = groupedFixture();
  source.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + server.address().port;
  source.global.global_param.pre_tasks = [
    script("project", "const chainGlobal = 'g';"),
  ];
  source.apis[0].request.pre_tasks = [
    script("folder", "const chainFolder = 'f';"),
  ];
  source.apis[1].request.pre_tasks = [script("api", "const chainAPI = 'a';")];
  source.samples[2].request.pre_tasks = [
    script(
      "root",
      "pm.setRequestHeader('x-chain', chainGlobal + chainFolder);",
    ),
  ];
  source.samples[3].request.pre_tasks = [
    script(
      "grouped",
      "pm.setRequestHeader('x-chain', chainGlobal + chainFolder + chainAPI);",
    ),
  ];
  const before = structuredClone(source),
    p = destination();
  importIntoProject(p, source);
  assert.deepEqual(source, before);
  assert.equal(p.requests.length, 1);
  assert.equal(p.caseFolders.length, 2);
  assert.equal(p.cases.length, 2);
  assert.equal(received.length, 0);
  const folder = p.caseFolders.find((f) => f.name === "Imported group"),
    empty = p.caseFolders.find((f) => f.name === "Empty group");
  assert.equal(empty.parentId, folder.id);
  assert.equal(folder.sourceRequestId, p.requests[0].id);
  const grouped = p.cases.find((c) => c.name === "Grouped case");
  assert.equal(grouped.folderId, folder.id);
  assert.deepEqual(
    grouped.request.importedScriptTasks.before.map((t) => t.origin.scope),
    ["project", "folder", "request", "sample"],
  );
  assert.equal(grouped.request.importedScriptTasks.before[2].origin.id, "api");
  for (const item of p.cases) {
    const env = p.environments[0];
    const result = await runPlan(
      { steps: [{ request: resolveServiceRequest(p, item.request, env.id) }] },
      environmentVariables(p, env.id),
      executeRequest,
    );
    assert.equal(result.status, "passed", JSON.stringify(result));
  }
  assert.equal(received[0].headers["x-chain"], "gf");
  assert.equal(received[0].headers["x-test"], undefined);
  assert.equal(received[1].headers["x-chain"], "gfa");
  assert.equal(received[1].headers["x-test"], "current");
  assert.match(received[1].url, /q=one/);
});
test("empty sample groups survive import and invalid group graphs or collisions are atomic", () => {
  const source = groupedFixture();
  source.samples = source.samples.slice(0, 2);
  const p = destination();
  importIntoProject(p, source);
  assert.equal(p.cases, undefined);
  assert.equal(p.caseFolders.length, 2);
  assert.equal(p.caseFolders[0].sourceRequestId, p.requests[0].id);
  const before = structuredClone(p);
  assert.throws(() => importIntoProject(p, source));
  assert.deepEqual(p, before);
  for (const change of [
    (s) => (s.samples[0].parent_id = "empty"),
    (s) => (s.samples[1].target_id = "other"),
    (s) => (s.samples[3].parent_id = "root-sample"),
    (s) => (s.samples[0].url = "/unexpected"),
    (s) => (s.samples[0].request = {}),
    (s) => (s.samples[0].sort = Infinity),
    (s) =>
      (s.apis[1].request.body = { mode: "raw", raw: "not silently inherited" }),
  ]) {
    const s = groupedFixture(),
      p = destination(),
      old = structuredClone(p);
    change(s);
    assert.throws(() => importIntoProject(p, s));
    assert.deepEqual(p, old);
  }
});
