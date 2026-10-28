import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createApp } from "../src/server.mjs";
import { importDocument } from "../src/core.mjs";

const collection = (item, extra = {}) => ({
  info: {
    name: "Shorthand",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  item,
  ...extra,
});
const bearer = {
  type: "bearer",
  bearer: [{ key: "token", value: "fixture-token" }],
};

test("Postman string requests preserve the object-request import contract without executing events", () => {
  for (const url of [
    "",
    "https://example.test/:id?x=1&x=2",
    "{{base}}/path?q={{value}}",
  ])
    for (const auth of [undefined, bearer, { type: "noauth" }]) {
      const make = (request) =>
        collection(
          [
            {
              name: "Folder",
              auth,
              event: [
                {
                  listen: "prerequest",
                  script: { exec: ["// folder marker"] },
                },
              ],
              item: [
                {
                  name: "Leaf",
                  request,
                  event: [
                    { listen: "test", script: { exec: ["// leaf marker"] } },
                  ],
                },
              ],
            },
          ],
          {
            auth: bearer,
            event: [
              {
                listen: "prerequest",
                script: { exec: ["// collection marker"] },
              },
            ],
          },
        );
      const string = importDocument(make(url))[0],
        object = importDocument(make({ url }))[0];
      delete string.id;
      delete object.id;
      assert.deepEqual(string, object);
      assert.equal(string.folder, "Folder");
      assert.equal(string.method, "GET");
      assert.match(
        string.beforeScript,
        /collection marker[\s\S]*folder marker/,
      );
      assert.match(string.afterScript, /leaf marker/);
    }
});

test("existing URL object parameters and disabled query semantics remain unchanged", () => {
  const [request] = importDocument(
    collection([
      {
        name: "Structured",
        request: {
          method: "POST",
          url: {
            raw: "https://example.test/:id?x=old",
            query: [
              { key: "x", value: "new" },
              { key: "off", value: "hidden", disabled: true },
            ],
            variable: [{ key: "id", value: "42" }],
          },
          header: [{ key: "x-test", value: "kept" }],
          body: { mode: "raw", raw: "payload" },
        },
      },
    ]),
  );
  assert.equal(request.url, "https://example.test/{id}");
  assert.equal(request.method, "POST");
  assert.equal(request.query[0].value, "new");
  assert.equal(request.query[1].enabled, false);
  assert.equal(request.path[0].value, "42");
  assert.equal(request.headers[0].value, "kept");
  assert.equal(request.body, "payload");
});

test("owner Postman shorthand import persists, restarts, executes and restores frozen HTTP plans", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
    });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const root = await mkdtemp(path.join(tmpdir(), "postman-shorthand-"));
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
  const call = async (route, body, expected = 200) => {
    const response = await fetch(app.url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  const p = await app.store.create("Shorthand owner"),
    other = await app.store.create("Isolated");
  const untouched = await app.store.get(other.id);
  const document = collection(
    [
      {
        name: "Folder",
        item: [{ name: "Leaf", request: "{{base}}/wire?x=1&x=2&empty=" }],
      },
    ],
    { auth: bearer, variable: [{ key: "base", value: base }] },
  );
  await call(`/api/projects/${p.id}/import`, { document });
  await stop();
  app = await createApp({ root, port: 0 });
  const persisted = await app.store.get(p.id);
  const curl = await call(`/api/projects/${p.id}/curl`, {
    request: persisted.requests[0],
    environmentId: persisted.environments.find(
      (env) => env.variables.base === base,
    ).id,
  });
  assert.ok(curl.curl.includes(base + "/wire?x=1&x=2&empty="));
  assert.ok(curl.curl.includes("Bearer fixture-token"));
  const plan = await call(`/api/projects/${p.id}/plans`, {
    name: "Frozen shorthand",
    environmentId: persisted.environments.find(
      (env) => env.variables.base === base,
    ).id,
    steps: [{ request: persisted.requests[0] }],
  });
  const run = await call(`/api/projects/${p.id}/run`, { planId: plan.id });
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.deepEqual(seen.at(-1), {
    method: "GET",
    url: "/wire?x=1&x=2&empty=",
    auth: "Bearer fixture-token",
  });
  assert.equal(persisted.requests[0].url, "{{base}}/wire?x=1&x=2&empty=");
  const before = await app.store.get(p.id);
  await call(
    `/api/projects/${p.id}/import`,
    {
      document: collection([
        { name: "Valid first", request: base + "/not-committed" },
        { name: "Invalid second", request: "ftp://example.test/private" },
      ]),
    },
    400,
  );
  assert.deepEqual(
    await app.store.get(p.id),
    before,
    "failed import must be atomic",
  );
  const live = await app.store.get(p.id);
  live.requests[0].url = base + "/changed";
  await app.store.save(live);
  const backup = await call(`/api/projects/${p.id}/export`);
  const restored = await call("/api/restore", { document: backup }, 201);
  await stop();
  app = await createApp({ root, port: 0 });
  const again = await call(`/api/projects/${restored.id}/run`, {
    planId: plan.id,
  });
  assert.equal(again.status, "passed", JSON.stringify(again));
  assert.equal(seen.at(-1).url, "/wire?x=1&x=2&empty=");
  const cli = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/run-plan.mjs", "--project", restored.id, "--plan", plan.id],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (x) => (stdout += x));
    child.stderr.on("data", (x) => (stderr += x));
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("CLI timeout"));
    }, 15000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  assert.equal(cli.code, 0, cli.stderr + cli.stdout);
  assert.equal(JSON.parse(cli.stdout).status, "passed");
  assert.equal(seen.at(-1).url, "/wire?x=1&x=2&empty=");
  const cliSaved = await app.store.get(restored.id);
  assert.ok(
    cliSaved.runs.some(
      (run) => run.source === "cli" && run.status === "passed",
    ),
  );
  assert.deepEqual(await app.store.get(other.id), untouched);
});
