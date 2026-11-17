// Application/network/SDK workflows run in ordinary CI; local authoring checks syntax.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { projectOwnerResponse } from "../src/project-owner-projection.mjs";
import {
  objectVariants,
  mixedObjectDocument,
  scalarHeaderCookieDocument,
} from "./fixtures/openapi-object-parameters.mjs";

async function files(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await files(file)
      : (await readFile(file)).toString("base64");
  }
  return result;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "object-parameter-"));
  const seen = [],
    clients = [];
  const peer = http.createServer((req, res) => {
    const entry = {
      url: req.url,
      zero: req.headers["x-zero"],
      literal: req.headers["x-literal"],
      cookie: req.headers.cookie,
    };
    seen.push(entry);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(entry));
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${peer.address().port}`;
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const server of [app.server, peer]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  const call = async (url, method = "GET", body, status = 200) => {
    const response = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const connect = async (projectId) => {
    const config = await call("/api/mcp/config", "POST", {
      enabled: true,
      projects: [projectId],
      write: true,
      execute: false,
      remember: false,
    });
    const client = new Client(
      { name: "object-parameter-admission", version: "1" },
      { capabilities: {} },
    );
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    assert(
      (await client.listTools()).tools.some(
        ({ name }) => name === "localapi_sync_openapi",
      ),
    );
    return client;
  };
  return { root, origin, app, seen, call, connect };
}

for (const version of ["3.0.3", "3.1.0"])
  for (const location of ["header", "cookie"])
    for (const route of ["owner", "SDK"])
      test(
        `${version} ${route} object ${location} refusal preserves complete Store and HTTP views without effects`,
        { timeout: 30000 },
        async (t) => {
          const f = await fixture(t);
          const project = await f.call(
            "/api/projects",
            "POST",
            { name: "Object refusal" },
            201,
          );
          const other = await f.call(
            "/api/projects",
            "POST",
            { name: "Unrelated" },
            201,
          );
          const url = `/api/projects/${project.id}`;
          await f.call(url + "/import", "POST", {
            document: scalarHeaderCookieDocument(version, f.origin),
          });
          const client = route === "SDK" ? await f.connect(project.id) : null;
          const before = await f.call(url);
          const beforeStore = await f.app.store.get(project.id);
          assert.equal(beforeStore.requestDefinitionHistory.entries.length, 1);
          assert.deepEqual(projectOwnerResponse(beforeStore), before);
          const otherBefore = await f.call(`/api/projects/${other.id}`);
          const disk = await files(f.app.store.directory(project.id));
          for (const parameter of objectVariants(location)) {
            const document = mixedObjectDocument(version, parameter, f.origin);
            const beforeSource = structuredClone(document);
            if (route === "owner") {
              const result = await f.call(
                url + "/import",
                "POST",
                { document },
                400,
              );
              assert.match(result.error, /OpenAPI.*(对象|content|复合)/);
            } else {
              for (const coverMode of [
                "url_and_folder",
                "url",
                "ignore",
                "both",
              ]) {
                const result = await client.callTool({
                  name: "localapi_sync_openapi",
                  arguments: { projectId: project.id, document, coverMode },
                });
                assert.equal(result.isError, true, JSON.stringify(result));
                assert.match(
                  result.content[0].text,
                  /OpenAPI.*(对象|content|复合)/,
                );
                assert.deepEqual(await f.call(url), before);
                assert.deepEqual(
                  await files(f.app.store.directory(project.id)),
                  disk,
                );
              }
            }
            assert.deepEqual(document, beforeSource);
            assert.deepEqual(await f.call(url), before);
            assert.deepEqual(
              await files(f.app.store.directory(project.id)),
              disk,
            );
            assert.deepEqual(
              await f.call(`/api/projects/${other.id}`),
              otherBefore,
            );
            assert.equal(f.seen.length, 0);
          }
          assert.deepEqual(
            await new Store(f.root).get(project.id),
            beforeStore,
          );
        },
      );

for (const version of ["3.0.3", "3.1.0"])
  test(
    `${version} scalar Header/Cookie values retain real wire after export reimport and Store reopen`,
    { timeout: 25000 },
    async (t) => {
      const f = await fixture(t);
      const project = await f.call(
        "/api/projects",
        "POST",
        { name: "Scalar original" },
        201,
      );
      const url = `/api/projects/${project.id}`;
      await f.call(url + "/import", "POST", {
        document: scalarHeaderCookieDocument(version, f.origin),
      });
      const original = await new Store(f.root).get(project.id);
      const exported = await f.call(url + "/export?format=openapi");
      const fresh = await f.call(
        "/api/projects",
        "POST",
        { name: "Scalar reimport" },
        201,
      );
      await f.call(`/api/projects/${fresh.id}/import`, "POST", {
        document: exported,
      });
      const roundtrip = await new Store(f.root).get(fresh.id);
      for (const group of ["headers", "cookies", "query"])
        assert.deepEqual(
          roundtrip.requests[0][group],
          original.requests[0][group],
        );
      const expected = {
        url: "/check?q=a%2Cb&q=c%26d",
        zero: "0",
        literal: '{"role":"admin"}',
        cookie: "flag=false; text=kept",
      };
      for (const target of [original, roundtrip]) {
        const result = await f.call(
          `/api/projects/${target.id}/execute`,
          "POST",
          { request: target.requests[0] },
        );
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.deepEqual(JSON.parse(result.body), expected);
        const { curl } = await f.call(
          `/api/projects/${target.id}/curl`,
          "POST",
          { request: target.requests[0] },
        );
        assert(curl.includes("'x-zero: 0'"));
        assert(curl.includes("'cookie: flag=false; text=kept'"));
        assert(curl.includes(f.origin + expected.url));
      }
      assert.deepEqual(f.seen, [expected, expected]);
    },
  );
