import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import {
  importIntoProject,
  normalizeRequest,
  snapshotPlan,
  restoreProject,
} from "../src/core.mjs";
import { nativeMockFixture } from "./fixtures/apipost-native-mock.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
const stop = async (app) => {
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
};
function cli(root, projectId, planId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        projectId,
        "--plan",
        planId,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = setTimeout(() => {
      failure = Error("Mock CLI fixture timed out");
      child.kill();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        failure = Error("CLI output exceeds bound");
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      failure ? reject(failure) : resolve({ code, signal, stdout, stderr });
    });
  });
}

for (const [transport, format] of [
  ["http", "apipost"],
  ["stdio", "apipost-directory"],
])
  test(
    `conditional Mock ${transport} SDK ${format} roundtrip reaches real CLI and isolated durable results`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "mock-export-sdk-"));
      let app = await createApp({ root, port: 0 }),
        client;
      t.after(async () => {
        await client?.close().catch(() => {});
        await stop(app);
        await rm(root, { recursive: true, force: true });
      });
      const source = await app.store.create("Mock source"),
        target = await app.store.create("Mock target"),
        denied = await app.store.create("Denied");
      importIntoProject(source, nativeMockFixture().directory);
      source.requests[0].inheritSharedScripts = false;
      source.requests[0].scriptDialect = "apipost8";
      source.requests[0].beforeScript =
        'throw Error("MOCK_EXPORT_MUST_NOT_EXECUTE_API_SCRIPT")';
      await app.store.save(source);
      const sourceBefore = await app.store.get(source.id),
        targetBefore = await app.store.get(target.id),
        deniedBefore = await app.store.get(denied.id);
      const connect = async (write) => {
        await client?.close().catch(() => {});
        client = new Client(
          { name: "native-mock-roundtrip", version: "1" },
          { capabilities: {} },
        );
        if (transport === "http") {
          const response = await fetch(app.url + "/api/mcp/config", {
            method: "POST",
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              enabled: true,
              projects: [source.id, target.id],
              write,
              execute: false,
              remember: false,
            }),
          });
          assert.equal(response.status, 200);
          const { token } = await response.json();
          await client.connect(
            new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
              requestInit: { headers: { Authorization: "Bearer " + token } },
            }),
          );
        } else {
          const stdio = new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
              "--project",
              source.id,
              "--project",
              target.id,
              ...(write ? ["--write"] : []),
            ],
            env: { LOCAL_API_DATA: root },
            stderr: "pipe",
          });
          stdio.stderr.resume();
          await client.connect(stdio);
        }
      };
      const call = (name, args) =>
        client.callTool({ name: "localapi_" + name, arguments: args });
      await connect(false);
      const exported = decode(
        await call("export_project", { projectId: source.id, format }),
      );
      assert.equal(
        (
          await call("import_project", {
            projectId: target.id,
            format,
            document: exported.document,
          })
        ).isError,
        true,
      );
      assert.equal(
        (await call("export_project", { projectId: denied.id, format }))
          .isError,
        true,
      );
      assert.deepEqual(await app.store.get(target.id), targetBefore);
      assert.deepEqual(await app.store.get(source.id), sourceBefore);
      await connect(true);
      const imported = decode(
        await call("import_project", {
          projectId: target.id,
          format,
          document: exported.document,
        }),
      );
      assert.equal(imported.imported.requestIds.length, 1);
      let saved = await app.store.get(target.id);
      const request = saved.requests.find(
        (r) => r.id === imported.imported.requestIds[0],
      );
      assert(request.nativeMock);
      assert.equal(request.beforeScript, sourceBefore.requests[0].beforeScript);
      const withoutIdentity = (value) => {
        const clone = structuredClone(value);
        delete clone.sourceTargetId;
        return clone;
      };
      assert.deepEqual(
        withoutIdentity(request.nativeMock),
        withoutIdentity(sourceBefore.requests[0].nativeMock),
      );
      assert.deepEqual(request.responses, sourceBefore.requests[0].responses);
      assert.deepEqual(request.examples, sourceBefore.requests[0].examples);
      const mockCheck = async (project) => {
        const r = project.requests.find((r) => r.nativeMock);
        for (const [query, expected] of [
          ["?mode=fail", "matched"],
          ["?mode=other", "fallback"],
          ["?mode=other&mode=fail", "matched"],
          ["?mode=fail&mode=other", "fallback"],
        ]) {
          const response = await fetch(
            `${app.url}/mock/${project.id}/${r.id}${query}`,
          );
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("x-native-rule"), expected);
          assert.deepEqual(await response.json(), { kind: expected });
        }
        assert.equal(
          r.nativeMockRoute.sourceTargetId,
          r.nativeMock.sourceTargetId,
        );
        for (const suffix of [
          "/items/123?mode=fail",
          "/absent?target_id=" +
            encodeURIComponent(r.nativeMock.sourceTargetId) +
            "&mode=fail",
        ]) {
          const routed = await fetch(
            app.url + "/app/mock/project/" + project.id + suffix,
          );
          assert.equal(routed.status, 200);
          assert.equal(routed.headers.get("x-native-rule"), "matched");
          assert.deepEqual(await routed.json(), { kind: "matched" });
        }
      };
      await mockCheck(sourceBefore);
      await mockCheck(saved);
      const again = decode(
        await call("export_project", { projectId: target.id, format }),
      );
      assert(again.document);
      const invalid = structuredClone(saved);
      invalid.settings.mockEnabled = false;
      await app.store.save(invalid);
      assert.equal(
        (await call("export_project", { projectId: target.id, format }))
          .isError,
        true,
      );
      assert.equal(
        (await fetch(`${app.url}/mock/${target.id}/${request.id}`)).status,
        503,
      );
      assert.deepEqual(await app.store.get(target.id), invalid);
      saved = await app.store.get(target.id);
      delete saved.settings.mockEnabled;
      await app.store.save(saved);
      // Close the MCP client before owner-controlled plan creation; no execute
      // capability is granted merely to exercise project interchange.
      await client.close();
      client = null;
      const runRequest = normalizeRequest({
        name: "Query restored Mock",
        url: `${app.url}/mock/${target.id}/${request.id}?mode=fail`,
        inheritSharedScripts: false,
      });
      const plan = snapshotPlan({
        name: "Mock consumer",
        environmentId: saved.environments[0].id,
        steps: [{ request: runRequest }],
      });
      saved = await app.store.get(target.id);
      saved.plans.push(plan);
      await app.store.save(saved);
      const result = await cli(root, target.id, plan.id);
      assert.equal(result.code, 0, result.stderr);
      const run = JSON.parse(result.stdout);
      assert.equal(run.status, "passed");
      assert.equal(run.recordSaved, true);
      assert.equal(run.results[0].response.status, 200);
      assert.deepEqual(JSON.parse(run.results[0].response.body), {
        kind: "matched",
      });
      const persisted = await app.store.get(target.id);
      assert(persisted.runs.some((item) => item.id === run.id));
      const restored = restoreProject(persisted);
      await app.store.save(restored);
      assert(restored.runs.some((item) => item.id === run.id));
      await stop(app);
      app = await createApp({ root, port: 0 });
      await mockCheck(await app.store.get(target.id));
      await mockCheck(await app.store.get(restored.id));
      assert.deepEqual(await app.store.get(source.id), sourceBefore);
      assert.deepEqual(await app.store.get(denied.id), deniedBefore);
    },
  );
