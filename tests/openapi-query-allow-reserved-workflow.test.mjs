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
  invalidReservedValues,
  versions,
  reservedDocument,
  mixedReservedDocument,
} from "./fixtures/openapi-allow-reserved.mjs";

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
  const root = await mkdtemp(join(tmpdir(), "reserved-query-"));
  const seen = [],
    clients = [];
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url }));
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
      { name: "reserved-query-regression", version: "1" },
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
  for (const route of ["owner", "SDK"])
    test(
      `${version} ${route} rejects scalar allowReserved mixed batches without durable or network effects`,
      { timeout: 25000 },
      async (t) => {
        const f = await fixture(t);
        const project = await f.call(
          "/api/projects",
          "POST",
          { name: "Reserved target" },
          201,
        );
        const other = await f.call(
          "/api/projects",
          "POST",
          { name: "Unrelated project" },
          201,
        );
        const url = `/api/projects/${project.id}`;
        await f.call(url + "/import", "POST", {
          document: reservedDocument(version, false, f.origin),
        });
        const client = route === "SDK" ? await f.connect(project.id) : null;
        const before = await f.call(url);
        // HTTP omits private definition history; compare reopened Store data
        // with the complete Store baseline, not with that public projection.
        const beforeStore = await f.app.store.get(project.id);
        assert.equal(beforeStore.requestDefinitionHistory.entries.length, 1);
        assert.deepEqual(projectOwnerResponse(beforeStore), before);
        const otherBefore = await f.call(`/api/projects/${other.id}`);
        const disk = await files(f.app.store.directory(project.id));
        for (const value of invalidReservedValues) {
          const document = mixedReservedDocument(version, value, f.origin);
          const sourceBefore = structuredClone(document);
          if (route === "owner") {
            const error = await f.call(
              url + "/import",
              "POST",
              { document },
              400,
            );
            assert.match(error.error, /allowReserved/);
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
              assert.equal(result.isError, true);
              assert.match(result.content[0].text, /allowReserved/);
              assert.deepEqual(await f.call(url), before);
              assert.deepEqual(
                await files(f.app.store.directory(project.id)),
                disk,
              );
            }
          }
          assert.deepEqual(document, sourceBefore);
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
        assert.deepEqual(await new Store(f.root).get(project.id), beforeStore);
        assert.equal(before.requests.length, 1);
      },
    );

test(
  "absent and false scalar allowReserved keep exact encoded wire after import and Store reopen",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t);
    for (const version of versions)
      for (const value of [undefined, false]) {
        const project = await f.call(
          "/api/projects",
          "POST",
          { name: `Allowed ${version}` },
          201,
        );
        const url = `/api/projects/${project.id}`;
        await f.call(url + "/import", "POST", {
          document: reservedDocument(version, value, f.origin),
        });
        const reopened = await new Store(f.root).get(project.id);
        const request = reopened.requests[0];
        assert.equal(reopened.requests.length, 1);
        assert.equal(request.query[0].value, "a/b:c");
        const result = await f.call(url + "/execute", "POST", { request });
        assert.equal(result.status, 200);
        assert.equal(JSON.parse(result.body).url, "/search?filter=a%2Fb%3Ac");
        assert.equal(f.seen.at(-1), "/search?filter=a%2Fb%3Ac");
        const { curl } = await f.call(url + "/curl", "POST", { request });
        assert(curl.includes(f.origin + "/search?filter=a%2Fb%3Ac"));
      }
    assert.equal(f.seen.length, 6);
  },
);
