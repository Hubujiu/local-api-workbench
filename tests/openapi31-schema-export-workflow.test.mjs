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

import {
  payload,
  schemaDocument,
} from "./fixtures/openapi31-schema-export.mjs";

async function disk(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await disk(path)
      : (await readFile(path)).toString("base64");
  }
  return result;
}

function checkExport(out) {
  assert.equal(out.openapi, "3.0.3");
  const operation = out.paths["/item"].post;
  const schema = operation.requestBody.content["application/json"].schema;
  assert.deepEqual(schema.properties.state, {
    type: "string",
    enum: ["active", "other"],
    allOf: [{ enum: ["active"] }],
  });
  assert.deepEqual(schema.properties.score, {
    type: "number",
    minimum: 2,
    exclusiveMinimum: true,
    maximum: 8,
    exclusiveMaximum: true,
  });
  assert.deepEqual(schema.properties.floor, { type: "number", minimum: 5 });
  assert.deepEqual(schema.properties.fixed, {
    enum: [{ flags: [false, null] }],
  });
  assert.deepEqual(operation.parameters[0].schema, {
    type: "integer",
    minimum: 2,
    exclusiveMinimum: true,
  });
  assert.deepEqual(
    operation.responses[200].content["application/json"].schema,
    schema,
  );
  assert.deepEqual(out.components.schemas.State, { enum: ["active"] });
  assert.deepEqual(
    operation.requestBody.content["application/json"].example,
    payload,
  );
  return schema;
}

for (const route of ["owner", "official SDK HTTP"])
  test(
    `${route} imports 3.1 schemas, exports 3.0, restarts and executes reimported definitions without changing the source`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "schema-export-"));
      const seen = [];
      const peer = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const entry = {
          url: req.url,
          method: req.method,
          contentType: req.headers["content-type"],
          body: JSON.parse(Buffer.concat(chunks).toString()),
        };
        seen.push(entry);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(entry.body));
      });
      await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
      let app = await createApp({ root, port: 0 }),
        client;
      const close = async () => {
        await client?.close();
        client = undefined;
        app.server.closeAllConnections();
        await app.close();
      };
      t.after(async () => {
        await close();
        peer.closeAllConnections();
        await new Promise((resolve) => peer.close(resolve));
        await rm(root, { recursive: true, force: true });
      });
      const call = async (path, method = "GET", body, expected = 200) => {
        const response = await fetch(app.url + path, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const value = await response.json();
        assert.equal(response.status, expected, JSON.stringify(value));
        return value;
      };
      const source = await call(
        "/api/projects",
        "POST",
        { name: "3.1 schema source" },
        201,
      );
      const other = await call(
        "/api/projects",
        "POST",
        { name: "Unrelated project" },
        201,
      );
      const otherBefore = await app.store.get(other.id);
      const input = schemaDocument(`http://127.0.0.1:${peer.address().port}`),
        inputBefore = structuredClone(input);
      const url = `/api/projects/${source.id}`;
      if (route === "owner")
        await call(url + "/import", "POST", { document: input });
      else {
        const config = await call("/api/mcp/config", "POST", {
          enabled: true,
          projects: [source.id],
          write: true,
          execute: false,
          remember: false,
        });
        client = new Client(
          { name: "schema-export", version: "1" },
          { capabilities: {} },
        );
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          }),
        );
        const result = await client.callTool({
          name: "localapi_sync_openapi",
          arguments: {
            projectId: source.id,
            document: input,
            coverMode: "url_and_folder",
          },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        await client.close();
        client = undefined;
      }
      const saved = await app.store.get(source.id),
        savedDisk = await disk(app.store.directory(source.id));
      assert.equal(saved.requests[0].schema.properties.state.const, "active");
      assert.equal(
        saved.requests[0].schema.properties.score.exclusiveMinimum,
        2,
      );
      const out = await call(url + "/export?format=openapi"),
        expectedSchema = checkExport(out);
      assert.deepEqual(await app.store.get(source.id), saved);
      assert.deepEqual(await disk(app.store.directory(source.id)), savedDisk);
      assert.deepEqual(input, inputBefore);
      assert.equal(seen.length, 0);
      await close();
      app = await createApp({ root, port: 0 });
      assert.deepEqual(await call(url + "/export?format=openapi"), out);
      assert.deepEqual(await new Store(root).get(source.id), saved);
      const fresh = await call(
        "/api/projects",
        "POST",
        { name: "3.0 reimport" },
        201,
      );
      await call(`/api/projects/${fresh.id}/import`, "POST", { document: out });
      const reimported = await new Store(root).get(fresh.id);
      assert.deepEqual(reimported.requests[0].schema, expectedSchema);
      assert.deepEqual(
        checkExport(
          await call(`/api/projects/${fresh.id}/export?format=openapi`),
        ),
        expectedSchema,
      );
      for (const project of [saved, reimported]) {
        const result = await call(
          `/api/projects/${project.id}/execute`,
          "POST",
          { request: project.requests[0] },
        );
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.deepEqual(JSON.parse(result.body), payload);
      }
      assert.deepEqual(
        seen,
        Array.from({ length: 2 }, () => ({
          url: "/item?limit=3",
          method: "POST",
          contentType: "application/json",
          body: payload,
        })),
      );
      assert.deepEqual(await app.store.get(other.id), otherBefore);
    },
  );
