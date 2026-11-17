import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";

// Static, script-free input only. File paths below are inert metadata: never read.
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "postman-body-workflow-"));
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
  const project = await api("/projects", {
    name: "Postman body modes workflow",
  });
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

function collection(url, bodies) {
  return {
    info: {
      name: "Postman modes",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: bodies.map((body, index) => ({
      name: "Mode " + index,
      request: { method: "POST", url, body },
    })),
  };
}
const active = [
  { mode: "raw", raw: "raw 中文 + & =", urlencoded: [], formdata: [] },
  {
    mode: "urlencoded",
    urlencoded: [
      { key: "a", value: "中文 + & =" },
      { key: "a", value: "second" },
      { key: "skip", value: "no", disabled: true },
    ],
    formdata: [{ key: "wrong", value: "stale" }],
  },
  {
    mode: "formdata",
    urlencoded: [],
    formdata: [
      { key: "a", value: "中文 + & =" },
      { key: "a", value: "second" },
      { key: "skip", value: "no", disabled: true },
    ],
  },
];
const disabled = ["raw", "urlencoded", "formdata"].map((mode) => ({
  mode,
  disabled: true,
  raw: { invalid: true },
  urlencoded: 42,
  formdata: "invalid",
}));
function assertEcho(response, index) {
  assert.equal(response.status, 200);
  const echo = JSON.parse(response.body);
  assert.equal(echo.method, "POST");
  if (index >= 3) {
    assert.equal(echo.body, "");
    return;
  }
  if (index === 0) assert.equal(echo.body, active[0].raw);
  if (index === 1) {
    assert.match(echo.contentType, /^application\/x-www-form-urlencoded/);
    assert.deepEqual(
      [...new URLSearchParams(echo.body)],
      [
        ["a", "中文 + & ="],
        ["a", "second"],
      ],
    );
  }
  if (index === 2) {
    assert.match(echo.contentType, /^multipart\/form-data; boundary=/);
    const boundary = echo.contentType.split("boundary=")[1];
    assert.equal(
      echo.body,
      `--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\n中文 + & =\r\n--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\nsecond\r\n--${boundary}--\r\n`,
    );
    assert.equal(echo.body.includes("wrong"), false);
    assert.equal(echo.body.includes("skip"), false);
  }
}

test("raw, urlencoded and formdata active/disabled bodies survive owner freeze/restart/restore and actual HTTP execution", async (t) => {
  const f = await fixture(t);
  let project = await f.api(f.route + "/import", {
    document: collection(f.url, [...active, ...disabled]),
  });
  assert.deepEqual(
    project.requests.map((r) => r.bodyType),
    ["raw", "urlencoded", "form-data", "none", "none", "none"],
  );
  assert.equal(
    project.requests[2].form.length,
    3,
    "selected formdata is not shadowed by stale urlencoded=[]",
  );
  await f.api(f.route + "/plans", {
    id: "body-plan",
    name: "Frozen bodies",
    environmentId: "selected",
    steps: project.requests.map((request) => ({ request })),
  });
  for (let i = 0; i < project.requests.length; i++)
    assertEcho(
      await f.api(f.route + "/execute", {
        request: project.requests[i],
        environmentId: "selected",
      }),
      i,
    );
  assert.equal(f.seen.length, 6);
  project = await f.api(f.route, undefined, "GET");
  project.requests.forEach((request) => {
    request.bodyType = "raw";
    request.body = "live changed";
    request.form = [];
  });
  await f.api(f.route, project, "PUT");
  await f.restart();
  const frozen = await f.api(f.route + "/run", {
    planId: "body-plan",
    environmentId: "selected",
  });
  assert.equal(frozen.status, "passed");
  frozen.results.forEach((result, index) => assertEcho(result.response, index));
  assert.equal(f.seen.length, 12);
  const backup = await f.api(f.route + "/export", undefined, "GET");
  const restored = await f.api("/restore", { document: backup });
  assert.notEqual(restored.id, project.id);
  await f.restart();
  const reopened = await f.api("/projects/" + restored.id, undefined, "GET");
  assert.equal(
    f.seen.length,
    12,
    "backup/restore/reopen never replay requests",
  );
  reopened.runs
    .find((run) => run.id === frozen.id)
    .results.forEach((result, index) => assertEcho(result.response, index));
  const rerun = await f.api("/projects/" + restored.id + "/run", {
    planId: "body-plan",
    environmentId: "selected",
  });
  assert.equal(rerun.status, "passed");
  rerun.results.forEach((result, index) => assertEcho(result.response, index));
  assert.equal(f.seen.length, 18);
  assert.equal(
    f.seen.some((entry) => entry.body === "live changed"),
    false,
  );
  assert.equal(
    (await f.api(f.route, undefined, "GET")).runs.length,
    1,
    "restored execution does not append to original project",
  );
});

test("file/unknown modes and nonboolean disabled fail mixed imports atomically; multipart file placeholders persist and block network", async (t) => {
  const f = await fixture(t);
  await f.api(f.route + "/import", {
    document: collection(f.url, [active[0]]),
  });
  const before = await f.api(f.route, undefined, "GET");
  const bytes = await diskSnapshot(f.root);
  for (const invalid of [
    { mode: "file", file: { src: "/never-read/file.bin" } },
    { mode: "unknown", raw: "not silently discarded" },
    { ...active[0], disabled: "true" },
    { ...active[1], disabled: 0 },
    { ...active[2], disabled: null },
  ]) {
    const response = await f.response(f.route + "/import", {
      document: collection(f.url, [active[0], invalid]),
    });
    assert.equal(response.status, 400, await response.text());
    assert.deepEqual(await f.api(f.route, undefined, "GET"), before);
    assert.deepEqual(await diskSnapshot(f.root), bytes);
  }
  assert.equal(f.seen.length, 0);
  const imported = await f.api(f.route + "/import", {
    document: collection(f.url, [
      {
        mode: "formdata",
        urlencoded: [],
        formdata: [
          { key: "upload", type: "file", src: "/never-read/secret.bin" },
        ],
      },
    ]),
  });
  const request = imported.requests.at(-1);
  assert.equal(request.form[0].requiresFile, true);
  assert.equal(request.form[0].filename, "secret.bin");
  assert.equal(request.form[0].value, "");
  await f.api(f.route + "/plans", {
    id: "file-plan",
    name: "Unselected file",
    environmentId: "selected",
    steps: [{ request }],
  });
  await f.restart();
  const persisted = await f.api(f.route, undefined, "GET");
  assert.equal(persisted.plans[0].steps[0].request.form[0].requiresFile, true);
  const result = await f.api(f.route + "/execute", {
    request: persisted.requests.at(-1),
    environmentId: "selected",
  });
  assert.notEqual(result.outcome, "passed");
  assert.match(result.error, /重新选择.*文件/);
  assert.equal(
    f.seen.length,
    0,
    "unselected imported file is rejected before any HTTP",
  );
  const restored = await f.api("/restore", {
    document: await f.api(f.route + "/export", undefined, "GET"),
  });
  const run = await f.api("/projects/" + restored.id + "/run", {
    planId: "file-plan",
    environmentId: "selected",
  });
  assert.notEqual(run.status, "passed");
  assert.match(run.results[0].error, /重新选择.*文件/);
  assert.equal(run.snapshot.steps[0].request.form[0].requiresFile, true);
  assert.equal(f.seen.length, 0);
});
