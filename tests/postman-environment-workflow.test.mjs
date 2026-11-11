import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

// Synthetic environment exports and loopback only; values are deliberately distinctive.
const documentFor = (name, value) => ({
  _postman_variable_scope: "environment",
  name,
  values: [{ key: "who", value, enabled: true, type: "default" }],
});
const rawDocument = (document) =>
  typeof document === "string" ? document : JSON.stringify(document);
const inputFor = (document) => ({
  format: "auto",
  document: rawDocument(document),
  selection: { mode: "all" },
});
async function fixture(t) {
  const seen = [];
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    res.end("{}");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${peer.address().port}`;
  const root = await mkdtemp(path.join(tmpdir(), "postman-environment-"));
  let app = await createApp({ root, port: 0 });
  const p = await app.store.create("Environment workflow");
  p.environments = [
    { id: "existing", name: "Existing", variables: { who: "existing" } },
  ];
  p.currentEnvironmentId = "existing";
  p.requests = [
    normalizeRequest({ name: "Who", method: "GET", url: base + "/{{who}}" }),
  ];
  await app.store.save(p);
  const clients = [];
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    for (const c of clients) await c.close();
    await stop();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    p,
    seen,
    root,
    get: (id) => app.store.get(id || p.id),
    save: (value) => app.store.save(value),
    restart: async () => {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    owner: async (action, body, expected = 200, projectId = p.id) => {
      const route =
        action === "restore"
          ? "/api/restore"
          : `/api/projects/${projectId}/${action}`;
      const response = await fetch(app.url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    },
    connect: async () => {
      const c = new Client({ name: "environment-workflow", version: "1" });
      clients.push(c);
      await c.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            path.resolve(import.meta.dirname, "../src/mcp.mjs"),
            "--project",
            p.id,
            "--write",
            "--execute",
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        }),
      );
      return (name, args) =>
        c.callTool({
          name: "localapi_" + name,
          arguments: { projectId: p.id, ...args },
        });
    },
  };
}
function decode(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

test(
  "standalone Postman environments preview/apply without switching, execute explicitly, duplicate safely and preserve frozen requests with live environments after backup/restart",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const first = documentFor("First", "private-first-fixture"),
      second = documentFor("Second", "private-second-fixture");
    const before = await f.get();
    const firstInput = inputFor(first);
    const preview = await f.owner("import-preview", firstInput);
    assert.equal(typeof preview.token, "string");
    assert.ok(!JSON.stringify(preview).includes(first.values[0].value));
    assert.deepEqual(await f.get(), before);
    await f.owner("import-apply", { input: firstInput, token: preview.token });
    const mcp = await f.connect(),
      secondInput = inputFor(second);
    const beforeMCP = await f.get();
    const mp = decode(await mcp("preview_import", { input: secondInput }));
    assert.equal(typeof mp.token, "string");
    assert.ok(!JSON.stringify(mp).includes(second.values[0].value));
    assert.deepEqual(await f.get(), beforeMCP);
    decode(await mcp("apply_import", { input: secondInput, token: mp.token }));
    let saved = await f.get();
    const a = saved.environments.find((e) => e.name === "First"),
      b = saved.environments.find((e) => e.name === "Second");
    assert.equal(a.variables.who, first.values[0].value);
    assert.equal(b.variables.who, second.values[0].value);
    assert.equal(saved.currentEnvironmentId, "existing");
    assert.deepEqual(saved.environments[0], before.environments[0]);
    assert.deepEqual(f.seen, []);
    await f.owner("import", { document: rawDocument(first) });
    saved = await f.get();
    const duplicates = saved.environments.filter((e) => e.name === "First");
    assert.equal(duplicates.length, 2);
    assert.notEqual(duplicates[0].id, duplicates[1].id);
    assert.equal(saved.currentEnvironmentId, "existing");
    for (const env of [a, b]) {
      const result = await f.owner("execute", {
        request: saved.requests[0],
        environmentId: env.id,
      });
      assert.equal(result.outcome, "passed");
      assert.equal(f.seen.at(-1), "/" + env.variables.who);
      const run = decode(
        await mcp("execute_api", {
          apiId: saved.requests[0].id,
          environmentId: env.id,
        }),
      );
      assert.equal(run.status, "passed");
      assert.equal(f.seen.at(-1), "/" + env.variables.who);
    }
    const defaultRun = await f.owner("execute", { request: saved.requests[0] });
    assert.equal(defaultRun.outcome, "passed");
    assert.equal(f.seen.at(-1), "/existing");
    const plan = await f.owner("plans", {
      name: "Frozen environment route",
      environmentId: a.id,
      steps: [{ request: saved.requests[0] }],
    });
    const live = await f.get();
    live.requests[0].url = "http://127.0.0.1:1/wrong";
    live.environments.find((env) => env.id === a.id).variables.who =
      "updated-live-environment";
    await f.save(live);
    const backup = await f.owner("export");
    const restored = await f.owner("restore", { document: backup }, 201);
    await f.restart();
    assert.equal(f.seen.length, 5);
    const reopened = await f.get(restored.id);
    assert.equal(reopened.currentEnvironmentId, "existing");
    assert.deepEqual(reopened.environments, (await f.get()).environments);
    const run = await f.owner("run", { planId: plan.id }, 200, restored.id);
    assert.equal(run.status, "passed");
    assert.equal(
      f.seen.at(-1),
      "/updated-live-environment",
      "the request is frozen but its selected environment stays live",
    );
    assert.equal(f.seen.length, 6);
  },
);

test(
  "invalid Postman environment documents are atomic and inert through owner and MCP previews",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      mcp = await f.connect();
    const valid = documentFor("Invalid fixture", "must-not-leak-fixture");
    const bad = [
      {
        ...valid,
        values: [{ ...valid.values[0], value: "{{vault:fixture-key}}" }],
      },
      { ...valid, values: [...valid.values, { ...valid.values[0] }] },
      { ...valid, values: [{ ...valid.values[0], enabled: false }] },
      { ...valid, values: [{ ...valid.values[0], type: "secret" }] },
      { ...valid, values: [{ ...valid.values[0], unexpected: true }] },
      { ...valid, unexpected: true },
      { ...valid, item: [] },
      { ...valid, openapi: "3.0.0", paths: {} },
      { ...valid, values: [{ key: "who", value: "x" }] },
      { ...valid, values: [{ ...valid.values[0], value: 42 }] },
    ];
    const before = await f.get();
    for (const document of bad) {
      await f.owner("import", { document: rawDocument(document) }, 400);
      assert.deepEqual(await f.get(), before);
      const input = inputFor(document);
      const preview = await f.owner("import-preview", input, 400);
      assert.equal(preview.token, undefined);
      assert.ok(!JSON.stringify(preview).includes(valid.values[0].value));
      const result = await mcp("preview_import", { input });
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result).includes(valid.values[0].value));
      assert.deepEqual(await f.get(), before);
      assert.deepEqual(f.seen, []);
    }
  },
);

test(
  "environment previews cannot clear, bind or remap existing resources",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      mcp = await f.connect();
    const before = await f.get();
    const document = documentFor(
      "Guard fixture",
      "guard-private-fixture-value",
    );
    for (const options of [
      { clearScope: { folder: "" } },
      { policies: { api: "clear" } },
      { policies: { api: "clear" }, clearScope: { folder: "" } },
      { bindings: { "environment:fixture": "existing" } },
      { folderMap: { "": "Moved" } },
    ]) {
      const input = { ...inputFor(document), ...options };
      const owner = await f.owner("import-preview", input, 400);
      assert.equal(owner.token, undefined);
      assert.ok(!JSON.stringify(owner).includes(document.values[0].value));
      assert.deepEqual(await f.get(), before);
      const response = await mcp("preview_import", { input });
      assert.equal(response.isError, true, JSON.stringify(response));
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.token, undefined);
      assert.ok(!JSON.stringify(response).includes(document.values[0].value));
      assert.deepEqual(
        await f.get(),
        before,
        "requests, environments and selection must be unchanged",
      );
      assert.deepEqual(f.seen, []);
    }
  },
);

test(
  "text JSON environment imports reject duplicate keys before owner or MCP normalization",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      mcp = await f.connect();
    const before = await f.get();
    const row =
      '{"key":"who","value":"duplicate-private-fixture","enabled":true}';
    const wrap = (value) =>
      '{"_postman_variable_scope":"environment","name":"Duplicate JSON","values":[' +
      value +
      "]}";
    const documents = [
      wrap(
        '{"key":"who","value":"duplicate-private-fixture","enabled":true,"type":"secret","type":"default"}',
      ),
      wrap(
        '{"key":"who","value":"duplicate-private-fixture","enabled":false,"enabled":true}',
      ),
      wrap(
        '{"key":"who","value":"duplicate-private-fixture","enabled":true,"type":"secret","ty\\u0070e":"default"}',
      ),
      wrap(
        '{"key":"who","value":"first","value":"duplicate-private-fixture","enabled":true}',
      ),
      '{"_postman_variable_scope":"globals","_postman_variable_scope":"environment","name":"Duplicate JSON","values":[' +
        row +
        "]}",
      '{"_postman_variable_scope":"environment","name":"Duplicate JSON","values":[],"values":[' +
        row +
        "]}",
    ];
    for (const document of documents) {
      assert.equal(typeof document, "string");
      assert.doesNotThrow(
        () => JSON.parse(document),
        "fixture is valid JSON whose duplicate members must be checked before JSON.parse collapses them",
      );
      await f.owner("import", { document: rawDocument(document) }, 400);
      assert.deepEqual(await f.get(), before);
      const input = inputFor(document);
      const preview = await f.owner("import-preview", input, 400);
      assert.equal(preview.token, undefined);
      const result = await mcp("preview_import", { input });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(JSON.parse(result.content[0].text).token, undefined);
      assert.deepEqual(await f.get(), before);
      assert.deepEqual(f.seen, []);
    }
  },
);

test(
  "public environment import rejects objects including upstream-collapsed duplicate JSON while collection objects still import",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      mcp = await f.connect();
    const before = await f.get();
    const documents = [
      documentFor("Plain object", "object-fixture-value"),
      JSON.parse(
        '{"_postman_variable_scope":"environment","name":"Collapsed duplicate","values":[{"key":"who","value":"object-fixture-value","enabled":false,"enabled":true,"type":"secret","type":"default"}]}',
      ),
    ];
    for (const document of documents) {
      const direct = await f.owner("import", { document }, 400);
      assert.match(JSON.stringify(direct), /原始JSON文本/);
      assert.deepEqual(await f.get(), before);
      // Deliberately bypass inputFor: the object boundary itself is under test.
      const input = { format: "auto", document, selection: { mode: "all" } };
      const preview = await f.owner("import-preview", input, 400);
      assert.equal(preview.token, undefined);
      assert.match(JSON.stringify(preview), /原始JSON文本/);
      const result = await mcp("preview_import", { input });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(result.content[0].text, /原始JSON文本/);
      assert.equal(JSON.parse(result.content[0].text).token, undefined);
      assert.deepEqual(await f.get(), before);
      assert.deepEqual(f.seen, []);
    }
    const collection = {
      info: {
        name: "Object collection control",
        schema:
          "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "Still importable",
          request: { method: "GET", url: "http://127.0.0.1:1/not-executed" },
        },
      ],
    };
    await f.owner("import", { document: collection });
    assert.ok(
      (await f.get()).requests.some(
        (request) => request.name === "Still importable",
      ),
    );
    assert.deepEqual((await f.get()).environments, before.environments);
    assert.deepEqual(f.seen, []);
  },
);
