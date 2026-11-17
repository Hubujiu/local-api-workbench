import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";

// Commands are parsed as input data, never executed by a shell or real curl.
async function fixture(t) {
  const seen = [];
  const peer = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    seen.push({
      method: req.method,
      url: req.url,
      header: req.headers["x-fixture"],
      body,
    });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${peer.address().port}`;
  const root = await mkdtemp(path.join(tmpdir(), "curl-attached-"));
  let app = await createApp({ root, port: 0 });
  const project = await app.store.create("Attached curl");
  const clients = [];
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    for (const client of clients) await client.close();
    await stop();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    project,
    base,
    seen,
    get: (id) => app.store.get(id || project.id),
    save: (p) => app.store.save(p),
    restart: async () => {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    owner: async (action, body, expected = 200, id = project.id) => {
      const route =
        action === "restore" ? "/api/restore" : `/api/projects/${id}/${action}`;
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
      const client = new Client({
        name: "curl-attached-workflow",
        version: "1",
      });
      clients.push(client);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            path.resolve(import.meta.dirname, "../src/mcp.mjs"),
            "--project",
            project.id,
            "--write",
            "--execute",
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        }),
      );
      return (name, args) =>
        client.callTool({
          name: "localapi_" + name,
          arguments: { projectId: project.id, ...args },
        });
    },
  };
}
const decode = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};

test(
  "owner imports attached curl options and owner/MCP send exact payloads through frozen backup/restart",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const document = `curl -XPOST -H'X-Fixture: attached header' -d'first=one' -d'second=two words' '${f.base}/attached'`;
    await f.owner("import", { document });
    const saved = await f.get(),
      request = saved.requests[0];
    assert.equal(request.method, "POST");
    assert.equal(request.body, "first=one&second=two words");
    assert.equal(request.url, f.base + "/attached");
    assert.deepEqual(f.seen, []);
    const expected = {
      method: "POST",
      url: "/attached",
      header: "attached header",
      body: "first=one&second=two words",
    };
    const owner = await f.owner("execute", { request });
    assert.equal(owner.outcome, "passed");
    assert.deepEqual(f.seen, [expected]);
    const mcp = await f.connect();
    const run = decode(await mcp("execute_api", { apiId: request.id }));
    assert.equal(run.status, "passed");
    assert.deepEqual(f.seen, [expected, expected]);
    const plan = await f.owner("plans", {
      name: "Frozen attached",
      steps: [{ request }],
    });
    const live = await f.get();
    live.requests[0].body = "wrong";
    live.requests[0].url = f.base + "/wrong";
    await f.save(live);
    const backup = await f.owner("export"),
      restored = await f.owner("restore", { document: backup }, 201);
    await f.restart();
    assert.equal(f.seen.length, 2);
    const frozen = await f.owner("run", { planId: plan.id }, 200, restored.id);
    assert.equal(frozen.status, "passed");
    assert.deepEqual(f.seen, [expected, expected, expected]);
    const restoredRequest = (await f.get(restored.id)).plans[0].steps[0]
      .request;
    assert.equal(restoredRequest.body, request.body);
    assert.deepEqual(restoredRequest.headers, request.headers);
    // A separate option's consumed value must not be split again as an option.
    await f.owner("import", {
      document: `curl -XPOST -H 'X-Fixture: literal' -d '-dnot-an-option' '${f.base}/literal'`,
    });
    const literal = (await f.get()).requests.find((r) =>
      r.url.endsWith("/literal"),
    );
    assert.equal(literal.body, "-dnot-an-option");
    assert.equal(
      (await f.owner("execute", { request: literal })).outcome,
      "passed",
    );
    assert.deepEqual(f.seen.at(-1), {
      method: "POST",
      url: "/literal",
      header: "literal",
      body: "-dnot-an-option",
    });
  },
);

test(
  "unsafe curl file and shell inputs are rejected without writes or sends; MCP rejects unsupported curl import",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      mcp = await f.connect();
    const before = await f.get();
    const unsupported = await mcp("preview_import", {
      input: {
        format: "auto",
        document: `curl -XPOST -H'X-Fixture: safe' -d'value' '${f.base}/safe-but-unsupported'`,
        selection: { mode: "all" },
      },
    });
    assert.equal(unsupported.isError, true, JSON.stringify(unsupported));
    assert.equal(JSON.parse(unsupported.content[0].text).token, undefined);
    assert.deepEqual(await f.get(), before);
    assert.deepEqual(f.seen, []);
    const bad = [
      `curl -d@/fixture/not-read '${f.base}/unsafe'`,
      `curl -H@/fixture/not-read '${f.base}/unsafe'`,
      `curl -XPOST '${f.base}/unsafe' --config /fixture/not-read`,
      `curl -XPOST '${f.base}/unsafe' ; echo forbidden`,
      `curl -d$(echo forbidden) '${f.base}/unsafe'`,
      `curl -d\`echo forbidden\` '${f.base}/unsafe'`,
    ];
    for (const document of bad) {
      await f.owner("import", { document }, 400);
      assert.deepEqual(await f.get(), before);
      assert.deepEqual(f.seen, []);
      const input = { format: "auto", document, selection: { mode: "all" } };
      const response = await mcp("preview_import", { input });
      assert.equal(response.isError, true, JSON.stringify(response));
      assert.equal(JSON.parse(response.content[0].text).token, undefined);
      assert.deepEqual(await f.get(), before);
      assert.deepEqual(f.seen, []);
    }
  },
);
