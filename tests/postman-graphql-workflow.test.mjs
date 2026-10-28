import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importDocument, importCurl, toCurl } from "../src/core.mjs";

// All inputs are static data. No scripts, XML, database adapters or dynamic values.
const payload = {
  query: "query Echo($id: ID!) { echo(id: $id) }",
  operationName: "Echo",
  variables: {
    id: 'quoted " 中文 \\ value',
    nested: { enabled: false },
    items: [1, null],
  },
};
function collection(
  url,
  graphql = { ...payload, variables: JSON.stringify(payload.variables) },
  extra = {},
) {
  return {
    info: {
      name: "Static GraphQL",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: "Echo",
        request: {
          method: "POST",
          url,
          body: { mode: "graphql", graphql, ...extra },
        },
      },
    ],
  };
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "graphql-workflow-"));
  const seen = [];
  const peer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = {
      method: request.method,
      url: request.url,
      contentType: request.headers["content-type"] ?? null,
      body: Buffer.concat(chunks).toString(),
    };
    seen.push(entry);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(entry));
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await Promise.all([close(app.server), close(peer)]);
    await rm(root, { recursive: true, force: true });
  });
  async function response(route, data, method = "POST") {
    return fetch(app.url + "/api" + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  }
  async function api(route, data, method = "POST") {
    const res = await response(route, data, method);
    const text = await res.text();
    assert.equal(res.ok, true, text);
    return JSON.parse(text);
  }
  const project = await api("/projects", { name: "GraphQL owner workflow" });
  project.environments = [
    { id: "selected", name: "Selected", variables: { guard: "unchanged" } },
  ];
  project.globalVariables = { globalGuard: "unchanged" };
  const route = "/projects/" + project.id;
  await api(route, project, "PUT");
  return {
    root,
    seen,
    project,
    route,
    api,
    response,
    url: `http://127.0.0.1:${peer.address().port}/graphql`,
    async restart() {
      await close(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}
function assertBody(
  response,
  expected = payload,
  contentType = "application/json",
) {
  assert.equal(response.status, 200);
  const echoed = JSON.parse(response.body);
  assert.equal(echoed.method, "POST");
  assert.equal(echoed.url, "/graphql");
  assert.equal(echoed.contentType, contentType);
  assert.deepEqual(JSON.parse(echoed.body), expected);
}
async function cli(t, root, projectId) {
  const output = path.join(root, "cli.json");
  const child = spawn(
    process.execPath,
    [
      "scripts/run-plan.mjs",
      "--project",
      projectId,
      "--plan",
      "frozen-plan",
      "--environment",
      "selected",
      "--output",
      output,
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, LOCAL_API_DATA: root },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr + stdout);
    const result = JSON.parse(stdout);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
async function diskSnapshot(directory) {
  const files = {};
  async function walk(current, prefix = "") {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const relative = prefix + entry.name;
      if (entry.isDirectory())
        await walk(path.join(current, entry.name), relative + "/");
      else {
        assert.equal(entry.isFile(), true);
        files[relative] = (
          await readFile(path.join(current, entry.name))
        ).toString("base64");
      }
    }
  }
  await walk(directory);
  return files;
}

test("GraphQL owner import survives restart, frozen case/CLI, backup restore and HTTP JSON export round trips", async (t) => {
  const f = await fixture(t);
  let project = await f.api(f.route + "/import", {
    document: collection(f.url),
  });
  assert.equal(project.requests[0].bodyType, "json");
  assert.deepEqual(JSON.parse(project.requests[0].body), payload);
  assert.equal(f.seen.length, 0);
  await f.restart();
  project = await f.api(f.route, undefined, "GET");
  assert.deepEqual(JSON.parse(project.requests[0].body), payload);
  const original = structuredClone(project.requests[0]);
  assertBody(
    await f.api(f.route + "/execute", {
      request: original,
      environmentId: "selected",
    }),
  );
  const { item } = await f.api(f.route + "/cases", {
    id: "frozen-case",
    name: "Frozen GraphQL",
    sourceRequestId: original.id,
    request: original,
  });
  await f.api(f.route + "/plans", {
    id: "frozen-plan",
    name: "Frozen GraphQL",
    environmentId: "selected",
    steps: [{ request: item.request }],
  });

  // Export canonical HTTP semantics, not Postman's GraphQL editor-mode metadata.
  const openapi = await f.api(
    f.route + "/export?format=openapi",
    undefined,
    "GET",
  );
  const [fromOpenAPI] = importDocument(openapi);
  const fromCurl = importCurl(toCurl(original));
  for (const request of [fromOpenAPI, fromCurl]) {
    assert.deepEqual(JSON.parse(request.body), payload);
    assertBody(
      await f.api(f.route + "/execute", { request, environmentId: "selected" }),
    );
  }
  project = await f.api(f.route, undefined, "GET");
  project.requests[0].url = f.url + "-live-changed";
  project.requests[0].body = JSON.stringify({
    query: "query Changed { changed }",
  });
  await f.api(f.route, project, "PUT");
  project = await f.api(f.route, undefined, "GET");
  assertBody(
    await f.api(f.route + "/execute", {
      request: project.cases[0].request,
      environmentId: "selected",
    }),
  );
  const run = await cli(t, f.root, project.id);
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true);
  assert.deepEqual(JSON.parse(run.snapshot.steps[0].request.body), payload);
  assertBody(run.results[0].response);
  const count = f.seen.length;
  assert.equal(count, 5);
  const backup = await f.api(f.route + "/export", undefined, "GET");
  const restored = await f.api("/restore", { document: backup });
  assert.notEqual(restored.id, project.id);
  await f.restart();
  const reopened = await f.api("/projects/" + restored.id, undefined, "GET");
  assert.equal(
    f.seen.length,
    count,
    "backup, restore and reads do not replay traffic",
  );
  const saved = reopened.runs.find((entry) => entry.id === run.id);
  assertBody(saved.results[0].response);
  assert.deepEqual(JSON.parse(reopened.cases[0].request.body), payload);
  const resumed = await f.api("/projects/" + restored.id + "/run", {
    planId: "frozen-plan",
    environmentId: "selected",
  });
  assert.equal(resumed.status, "passed");
  assertBody(resumed.results[0].response);
  assert.equal(f.seen.length, count + 1);
  assert.equal(
    f.seen.some((entry) => entry.url.includes("live-changed")),
    false,
  );
  const unchanged = await new Store(f.root).get(project.id);
  assert.equal(unchanged.runs.length, 1);
  assert.deepEqual(unchanged.environments[0].variables, { guard: "unchanged" });
  assert.deepEqual(unchanged.globalVariables, { globalGuard: "unchanged" });
});

test("mixed invalid GraphQL owner imports leave all project bytes unchanged; disabled body is not sent", async (t) => {
  const f = await fixture(t);
  await f.api(f.route + "/import", { document: collection(f.url) });
  const before = await f.api(f.route, undefined, "GET");
  const bytes = await diskSnapshot(f.root);
  for (const graphql of [
    { ...payload, variables: "{invalid" },
    { ...payload, query: "query { {{field}} }" },
    { ...payload, variables: "[1,2]" },
  ]) {
    const document = collection(f.url);
    document.item.push(collection(f.url, graphql).item[0]);
    const response = await f.response(f.route + "/import", { document });
    assert.equal(response.status, 400, await response.text());
    assert.deepEqual(await f.api(f.route, undefined, "GET"), before);
    assert.deepEqual(await diskSnapshot(f.root), bytes);
    assert.equal(f.seen.length, 0);
  }
  const document = collection(
    f.url,
    { query: 42, variables: "{invalid" },
    { disabled: true },
  );
  document.item[0].request.header = [
    {
      key: "Content-Type",
      value: "application/custom-graphql",
      disabled: false,
    },
  ];
  const imported = await f.api(f.route + "/import", { document });
  const disabled = imported.requests.at(-1);
  assert.equal(disabled.bodyType, "none");
  const result = await f.api(f.route + "/execute", {
    request: disabled,
    environmentId: "selected",
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).body, "");
  assert.equal(
    JSON.parse(result.body).contentType,
    "application/custom-graphql",
  );
  const explicit = collection(f.url);
  explicit.item[0].request.header = [
    {
      key: "Content-Type",
      value: "application/custom-graphql",
      disabled: false,
    },
  ];
  const final = await f.api(f.route + "/import", { document: explicit });
  assertBody(
    await f.api(f.route + "/execute", {
      request: final.requests.at(-1),
      environmentId: "selected",
    }),
    payload,
    "application/custom-graphql",
  );
});
