import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { importIntoProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";

// Synthetic definitions and loopback only; no original client or remote service.
for (const format of ["raw", "structured"])
  for (const suffix of ["", ".json"])
    test(
      `Postman ${format} whole hyphenated path name${suffix} survives owner/MCP, frozen restore and exports`,
      { timeout: 30000 },
      async (t) => {
        const seen = [];
        const peer = http.createServer((req, res) => {
          seen.push(req.url);
          res.end('{"ok":true}');
        });
        await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${peer.address().port}`;
        const expected = `/users/alice${suffix}`;
        const root = await mkdtemp(path.join(tmpdir(), "postman-segments-"));
        let app = await createApp({ root, port: 0 });
        const stop = async () => {
          app.server.closeAllConnections();
          await new Promise((resolve) => app.server.close(resolve));
        };
        t.after(async () => {
          await stop();
          peer.closeAllConnections();
          await new Promise((resolve) => peer.close(resolve));
          await rm(root, { recursive: true, force: true });
        });
        const call = async (route, body, status = 200) => {
          const response = await fetch(app.url + route, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              "content-type": "application/json",
              "x-local-token": app.token,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const result = await response.json();
          assert.equal(response.status, status, JSON.stringify(result));
          return result;
        };
        const p = await app.store.create("Synthetic segment workflow");
        const variable = [
          { key: "user-id", value: "alice" },
          { key: "user", value: "wrong" },
        ];
        const url =
          format === "raw"
            ? { raw: `${base}/users/:user-id${suffix}`, variable }
            : {
                protocol: "http",
                host: "127.0.0.1",
                port: String(peer.address().port),
                path: ["users", `:user-id${suffix}`],
                variable,
              };
        await call(`/api/projects/${p.id}/import`, {
          document: {
            info: {
              name: "Segments",
              schema:
                "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
            },
            item: [{ name: "Get user", request: { method: "GET", url } }],
          },
        });
        let saved = await app.store.get(p.id);
        const request = saved.requests[0];
        assert.equal(request.url, `${base}/users/{user-id}${suffix}`);
        assert.equal(seen.length, 0);
        const curl = await call(`/api/projects/${p.id}/curl`, { request });
        assert.ok(curl.curl.includes(base + expected), curl.curl);
        assert.ok(!curl.curl.includes("wrong"), curl.curl);
        const owner = await call(`/api/projects/${p.id}/execute`, { request });
        assert.equal(owner.outcome, "passed", JSON.stringify(owner));
        assert.deepEqual(seen, [expected]);
        const client = new Client(
          { name: "segment-workflow", version: "1.0.0" },
          { capabilities: {} },
        );
        try {
          await client.connect(
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
          const result = await client.callTool({
            name: "localapi_execute_api",
            arguments: { projectId: p.id, apiId: request.id },
          });
          assert.notEqual(result.isError, true, JSON.stringify(result));
          assert.equal(JSON.parse(result.content[0].text).status, "passed");
        } finally {
          await client.close();
        }
        assert.deepEqual(seen, [expected, expected]);
        // Native export/reimport must preserve the complete path key, not truncate at '-'.
        saved = await app.store.get(p.id);
        const target = await app.store.create("Native roundtrip");
        importIntoProject(target, exportApipost(saved));
        await app.store.save(target);
        const nativeRequest = (await app.store.get(target.id)).requests[0];
        const native = await call(`/api/projects/${target.id}/execute`, {
          request: nativeRequest,
        });
        assert.equal(native.outcome, "passed", JSON.stringify(native));
        assert.deepEqual(seen, [expected, expected, expected]);
        const plan = await call(`/api/projects/${p.id}/plans`, {
          name: "Frozen segments",
          steps: [{ request }],
        });
        const live = await app.store.get(p.id);
        live.requests[0].url = base + "/wrong-live-edit";
        await app.store.save(live);
        const backup = await call(`/api/projects/${p.id}/export`);
        const restored = await call("/api/restore", { document: backup }, 201);
        await stop();
        app = await createApp({ root, port: 0 });
        assert.equal(seen.length, 3, "backup and restart are inert");
        const run = await call(`/api/projects/${restored.id}/run`, {
          planId: plan.id,
        });
        assert.equal(run.status, "passed", JSON.stringify(run));
        assert.deepEqual(seen, [expected, expected, expected, expected]);
        const restoredProject = await app.store.get(restored.id);
        assert.equal(
          restoredProject.plans[0].steps[0].request.url,
          request.url,
        );
      },
    );

test(
  "owner and MCP mixed path imports reject ambiguity atomically while identical enabled duplicates are accepted",
  { timeout: 30000 },
  async (t) => {
    const seen = [];
    const peer = http.createServer((req, res) => {
      seen.push(req.url);
      res.end("{}");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${peer.address().port}`;
    const root = await mkdtemp(path.join(tmpdir(), "segments-atomic-"));
    const app = await createApp({ root, port: 0 });
    const client = new Client(
      { name: "segments-atomic", version: "1.0.0" },
      { capabilities: {} },
    );
    t.after(async () => {
      await client.close();
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("Atomic segment imports");
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.resolve(import.meta.dirname, "../src/mcp.mjs"),
          "--project",
          p.id,
          "--write",
        ],
        env: { ...process.env, LOCAL_API_DATA: root },
        stderr: "pipe",
      }),
    );
    const owner = async (action, body, expected) => {
      const response = await fetch(
        `${app.url}/api/projects/${p.id}/${action}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-local-token": app.token,
          },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    };
    const documentFor = (url) => ({
      info: {
        name: "Atomic synthetic batch",
        schema:
          "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        { name: "Valid first", request: { url: base + "/must-not-be-saved" } },
        { name: "Second", request: { url } },
      ],
    });
    const first = { key: "user-id", value: "alice" };
    for (const format of ["raw", "structured"]) {
      const makeURL = (segment, variable = []) =>
        format === "raw"
          ? { raw: `${base}/users/${segment}`, variable }
          : {
              protocol: "http",
              host: "127.0.0.1",
              port: String(peer.address().port),
              path: ["users", segment],
              variable,
            };
      for (const url of [
        makeURL(":id:action"),
        makeURL(":user-id.json", [first, { ...first, value: "different" }]),
        makeURL(":user-id.json", [first, { ...first, disabled: true }]),
      ]) {
        const document = documentFor(url);
        const input = {
          format: "auto",
          document,
          selection: { mode: "all" },
        };
        const before = await app.store.get(p.id);
        const unchanged = async () => {
          assert.deepEqual(
            await app.store.get(p.id),
            before,
            "failed mixed import must not write any project state",
          );
          assert.deepEqual(
            seen,
            [],
            "definition import must never send requests",
          );
        };
        const direct = await owner("import", { document }, 400);
        assert.match(JSON.stringify(direct), /路径变量名称|重复/);
        await unchanged();
        const preview = await owner("import-preview", input, 400);
        assert.equal(preview.token, undefined);
        await unchanged();
        const result = await client.callTool({
          name: "localapi_preview_import",
          arguments: { projectId: p.id, input },
        });
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.match(result.content[0].text, /MANUAL_IMPORT_INVALID/);
        assert.equal(JSON.parse(result.content[0].text).token, undefined);
        await unchanged();
      }
      const document = documentFor(
        makeURL(":user-id.json", [first, { ...first, disabled: false }]),
      );
      const input = { format: "auto", document, selection: { mode: "all" } };
      // A successful control ensures rejection above reaches real Postman validation,
      // rather than failing because the MCP tool or format is unavailable.
      const control = await client.callTool({
        name: "localapi_preview_import",
        arguments: { projectId: p.id, input },
      });
      assert.notEqual(control.isError, true, JSON.stringify(control));
      await owner("import", { document }, 200);
      assert.deepEqual(seen, []);
      assert.ok(
        (await app.store.get(p.id)).requests.some(
          (r) => r.url === `${base}/users/{user-id}.json`,
        ),
      );
    }
  },
);
