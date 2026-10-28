import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
const invalidURLs = [
  { protocol: "ftp", host: "example.test" },
  { protocol: "https", host: "user:secret@example.test" },
  { protocol: "https", host: "example.test:8443" },
  { protocol: "https", host: "[bad:ipv6]" },
  { protocol: "https", host: ["ok", 1] },
  {
    protocol: "https",
    host: "example.test",
    path: [{ type: "variable", value: "id" }],
  },
  { protocol: "https", host: "example.test", path: ["a/b"] },
  { protocol: "https", host: "example.test", path: "a?hidden=1" },
  { protocol: "https", host: "example.test", port: 443 },
  { protocol: "https", host: "example.test", port: "65536" },
  { protocol: "https", host: "example.test", hash: 5 },
  { protocol: "https", host: "example.test", hash: "bad\nfragment" },
  {
    protocol: "https",
    host: "example.test",
    auth: { user: "hidden", password: "secret" },
  },
  { host: "example.test" },
  { raw: null },
];
const bearer = {
  type: "bearer",
  bearer: [{ key: "token", value: "fixture-token" }],
};

for (const format of ["structured", "raw"])
  test(`owner ${format} Postman URL import persists, restarts, executes and restores frozen HTTP plans`, async (t) => {
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
    const root = await mkdtemp(path.join(tmpdir(), "postman-structured-"));
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
          item: [
            {
              name: "Leaf",
              request: {
                url: {
                  protocol: "http",
                  host: "{{host}}",
                  port: "{{port}}",
                  path: ["wire", ":id", "%2F"],
                  hash: "fragment?detail/:keep",
                  variable: [{ key: "id", value: "42" }],
                  query: [
                    { key: "x", value: "1" },
                    { key: "x", value: "2" },
                    { key: "empty", value: "" },
                    { key: "literal", value: "/:keep" },
                    { key: "off", value: "hidden", disabled: true },
                  ],
                },
              },
            },
          ],
        },
      ],
      {
        auth: bearer,
        variable: [
          { key: "host", value: "127.0.0.1" },
          { key: "port", value: String(upstream.address().port) },
        ],
      },
    );
    if (format === "raw")
      document.item[0].item[0].request.url.raw =
        "http://{{host}}:{{port}}/wire/:id/%2F?old=discarded#fragment?detail/:keep";
    await call(`/api/projects/${p.id}/import`, { document });
    await stop();
    app = await createApp({ root, port: 0 });
    const persisted = await app.store.get(p.id);
    const curl = await call(`/api/projects/${p.id}/curl`, {
      request: persisted.requests[0],
      environmentId: persisted.environments.find(
        (env) => env.variables.host === "127.0.0.1",
      ).id,
    });
    assert.ok(
      curl.curl.includes(
        base + "/wire/42/%2F?x=1&x=2&empty=&literal=%2F%3Akeep",
      ),
      curl.curl,
    );
    assert.ok(curl.curl.includes("Bearer fixture-token"));
    const plan = await call(`/api/projects/${p.id}/plans`, {
      name: "Frozen shorthand",
      environmentId: persisted.environments.find(
        (env) => env.variables.host === "127.0.0.1",
      ).id,
      steps: [{ request: persisted.requests[0] }],
    });
    const run = await call(`/api/projects/${p.id}/run`, { planId: plan.id });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.deepEqual(seen.at(-1), {
      method: "GET",
      url: "/wire/42/%2F?x=1&x=2&empty=&literal=%2F%3Akeep",
      auth: "Bearer fixture-token",
    });
    assert.equal(
      persisted.requests[0].url,
      "http://{{host}}:{{port}}/wire/{id}/%2F#fragment?detail/:keep",
    );
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
    assert.equal(
      seen.at(-1).url,
      "/wire/42/%2F?x=1&x=2&empty=&literal=%2F%3Akeep",
    );
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
    assert.equal(
      seen.at(-1).url,
      "/wire/42/%2F?x=1&x=2&empty=&literal=%2F%3Akeep",
    );
    const cliSaved = await app.store.get(restored.id);
    assert.ok(
      cliSaved.runs.some(
        (run) => run.source === "cli" && run.status === "passed",
      ),
    );
    for (const url of invalidURLs) {
      const beforeBad = await app.store.get(p.id);
      await call(
        `/api/projects/${p.id}/import`,
        {
          document: collection([
            {
              name: "Valid first",
              request: {
                url: {
                  protocol: "http",
                  host: "127.0.0.1",
                  port: String(upstream.address().port),
                  path: ["not-saved"],
                },
              },
            },
            { name: "Bad second", request: { url } },
          ]),
        },
        400,
      );
      assert.deepEqual(
        await app.store.get(p.id),
        beforeBad,
        "invalid mixed batch must be atomic",
      );
    }
    const config = await call("/api/mcp/config", {
      enabled: true,
      projects: [restored.id],
      write: false,
      execute: false,
      remember: false,
    });
    for (const transport of [
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.resolve(import.meta.dirname, "../src/mcp.mjs"),
          "--project",
          restored.id,
        ],
        env: { LOCAL_API_DATA: root },
        stderr: "pipe",
      }),
    ]) {
      const sdk = new Client(
        { name: "postman-url-readback", version: "1.0.0" },
        { capabilities: {} },
      );
      try {
        await sdk.connect(transport);
        const read = async (name, args) => {
          const result = await sdk.callTool({ name, arguments: args });
          assert.notEqual(result.isError, true, JSON.stringify(result));
          return JSON.parse(result.content[0].text);
        };
        assert.deepEqual(
          await read("localapi_get_api_detail", {
            projectId: restored.id,
            apiId: cliSaved.requests[0].id,
          }),
          cliSaved.requests[0],
        );
        assert.deepEqual(
          (await read("localapi_list_plans", { projectId: restored.id })).plans,
          cliSaved.plans,
          "read-only SDK preserves frozen imported definitions despite live edits",
        );
        const savedRun = cliSaved.runs.find((entry) => entry.source === "cli");
        assert.deepEqual(
          await read("localapi_get_run", {
            projectId: restored.id,
            runId: savedRun.id,
          }),
          savedRun,
        );
        const deniedRequest = (await app.store.get(p.id)).requests.find(
          (request) => request.id === cliSaved.requests[0].id,
        );
        assert.ok(deniedRequest, "denied project and record must really exist");
        const denied = await sdk.callTool({
          name: "localapi_get_api_detail",
          arguments: { projectId: p.id, apiId: deniedRequest.id },
        });
        assert.equal(denied.isError, true);
        assert.equal(denied.content[0].text, "项目未授权");
      } finally {
        await sdk.close();
      }
    }
    assert.deepEqual(await app.store.get(other.id), untouched);
  });

test("structured URL components preserve percent escapes, IPv6, variables and fragment delimiters", () => {
  const imported = (url) =>
    importDocument(collection([{ name: "URL", request: { url } }]))[0];
  for (const [url, expected] of [
    [
      {
        protocol: "https",
        host: ["api", "example", "test"],
        port: "8443",
        path: ["a%2Fb", ":id", "%23"],
        hash: "x?y/:keep",
        query: [{ key: "q", value: "1" }],
      },
      "https://api.example.test:8443/a%2Fb/{id}/%23#x?y/:keep",
    ],
    [
      {
        protocol: "http",
        host: "[::1]",
        port: "8080",
        path: "/a//b/",
        hash: "",
      },
      "http://[::1]:8080/a//b/#",
    ],
    [{ host: "{{baseURL}}", path: ["a", ""] }, "{{baseURL}}/a/"],
    [
      { protocol: "https", host: "example.test", path: "", port: "" },
      "https://example.test",
    ],
    [{}, ""],
    [{ host: [], path: [], query: [{ key: "q", value: "draft" }] }, ""],
    [{ path: [] }, ""],
    [{ raw: "", host: [], path: ["ignored"] }, ""],
    [{ raw: "", protocol: "https", host: "ignored.test" }, ""],
    [
      { raw: "https://raw.test", protocol: "https", host: "ignored.test" },
      "https://raw.test",
    ],
  ])
    assert.equal(imported(url).url, expected);
});

test("raw Postman query and fragment text is never rewritten as path variables", () => {
  const imported = (url) =>
    importDocument(collection([{ name: "URL", request: { url } }]))[0].url;
  for (const prefix of [
    "https://:fixture-secret@example.test",
    "{{scheme}}://:fixture-secret@example.test",
    "https://normal.test",
  ]) {
    assert.equal(
      imported(prefix + "/:id?q=/:literal#/:fragment"),
      prefix + "/{id}?q=/:literal#/:fragment",
    );
    assert.equal(
      imported({
        raw: prefix + "/:id?old=1#/:fragment",
        query: [{ key: "q", value: "/:literal" }],
      }),
      prefix + "/{id}#/:fragment",
    );
  }
  for (const raw of [
    "https://example.test/:id?q=/:literal#part?detail/:keep",
    "{{base}}/:id?q=/:literal#part?detail/:keep",
  ]) {
    const expected = raw.replace("/:id", "/{id}");
    assert.equal(imported(raw), expected);
    assert.equal(imported({ raw }), expected);
    assert.equal(
      imported({ raw, query: [{ key: "q", value: "/:literal" }] }),
      expected.slice(0, expected.indexOf("?")) + "#part?detail/:keep",
    );
  }
  assert.equal(
    imported({
      raw: "https://example.test/%23/:id#part?detail/:keep",
      query: [{ key: "q", value: "x" }],
    }),
    "https://example.test/%23/{id}#part?detail/:keep",
  );
});
