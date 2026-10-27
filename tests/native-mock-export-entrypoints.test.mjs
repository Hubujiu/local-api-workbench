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
import { Store } from "../src/runtime.mjs";
import {
  importIntoProject,
  normalizeRequest,
  snapshotPlan,
  restoreProject,
} from "../src/core.mjs";
import { nativeMockFixture } from "./fixtures/apipost-native-mock.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";

const rawFallback = " {kind:'雪😀', /*keep*/ literal:'{{unresolved}}',} \n";
const scalarSchema = {
  type: "boolean",
  const: false,
  description: "Retain the schema, not a sampled response literal",
};

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
    `conditional Mock object/scalar/raw ${transport} SDK ${format} roundtrip reaches real CLI and isolated durable results`,
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
        secondTarget = await app.store.create("Mock second generation"),
        denied = await app.store.create("Denied");
      const { doc, config } = nativeMockFixture();
      const scalar = structuredClone(doc.apis[1].response.example[1]);
      scalar.example_id = "scalar";
      scalar.expect.schema = structuredClone(scalarSchema);
      scalar.headers[0].value = "scalar";
      config.ai_expect.list.push({
        id: "scalar-rule",
        desc: "scalar schema condition",
        enable: 1,
        expect_id: "0",
        example: scalar,
        conditions: [
          {
            conditionId: "scalar-mode",
            location: "query",
            name: "mode",
            compareType: "eq",
            value: "scalar",
          },
        ],
      });
      config.ai_expect.none_math_expect_id = "0";
      config.ai_expect.none_math_example = {
        ...structuredClone(doc.apis[1].response.example[0]),
        raw: rawFallback,
        expect: {
          ...structuredClone(doc.apis[1].response.example[0].expect),
          schema: {},
        },
      };
      const document = nativeDirectoryFixture(doc);
      document.files.push({
        path: "settings/mock_api.json",
        text: JSON.stringify(config),
      });
      const inputBefore = structuredClone(document);
      importIntoProject(source, document);
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
              projects: [source.id, target.id, secondTarget.id],
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
              "--project",
              secondTarget.id,
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
      let request = saved.requests.find(
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
        assert.deepEqual(r.nativeMock.rules[1].response.schema, scalarSchema);
        assert.equal(
          r.nativeMock.rules[1].response.serialization,
          "scalar-text",
        );
        assert.equal(r.nativeMock.rules[1].response.sourceStatus, 404);
        assert.equal(r.nativeMock.fallback.body, rawFallback);
        assert.equal(r.nativeMock.fallback.schema, undefined);
        for (const [query, expected, body, media] of [
          [
            "?mode=fail",
            "matched",
            '{"kind":"matched"}',
            "application/json;charset=utf-8",
          ],
          ["?mode=scalar", "scalar", "false", "text/plain"],
          [
            "?mode=other",
            "fallback",
            rawFallback,
            "application/json;charset=utf-8",
          ],
          [
            "?mode=other&mode=fail",
            "matched",
            '{"kind":"matched"}',
            "application/json;charset=utf-8",
          ],
          [
            "?mode=fail&mode=other",
            "fallback",
            rawFallback,
            "application/json;charset=utf-8",
          ],
        ]) {
          const response = await fetch(
            `${app.url}/mock/${project.id}/${r.id}${query}`,
          );
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("x-native-rule"), expected);
          assert.equal(response.headers.get("content-type"), media, query);
          assert.equal(await response.text(), body);
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
      const firstGenerationBefore = await app.store.get(target.id);
      const secondImported = decode(
        await call("import_project", {
          projectId: secondTarget.id,
          format,
          document: again.document,
        }),
      );
      assert.equal(secondImported.imported.requestIds.length, 1);
      saved = await app.store.get(secondTarget.id);
      request = saved.requests.find(
        (r) => r.id === secondImported.imported.requestIds[0],
      );
      assert.deepEqual(
        withoutIdentity(request.nativeMock),
        withoutIdentity(sourceBefore.requests[0].nativeMock),
      );
      await mockCheck(saved);
      const invalid = structuredClone(saved);
      invalid.settings.mockEnabled = false;
      await app.store.save(invalid);
      assert.equal(
        (await call("export_project", { projectId: secondTarget.id, format }))
          .isError,
        true,
      );
      assert.equal(
        (await fetch(`${app.url}/mock/${secondTarget.id}/${request.id}`))
          .status,
        503,
      );
      assert.deepEqual(await app.store.get(secondTarget.id), invalid);
      saved = await app.store.get(secondTarget.id);
      delete saved.settings.mockEnabled;
      await app.store.save(saved);
      // Close the MCP client before owner-controlled plan creation; no execute
      // capability is granted merely to exercise project interchange.
      await client.close();
      client = null;
      const plan = snapshotPlan({
        name: "Mock consumer",
        environmentId: saved.environments[0].id,
        steps: ["fail", "scalar", "other"].map((mode) => ({
          request: normalizeRequest({
            name: "Query restored Mock " + mode,
            url: `${app.url}/mock/${secondTarget.id}/${request.id}?mode=${mode}`,
            inheritSharedScripts: false,
          }),
        })),
      });
      saved = await app.store.get(secondTarget.id);
      saved.plans.push(plan);
      await app.store.save(saved);
      const result = await cli(root, secondTarget.id, plan.id);
      assert.equal(result.code, 0, result.stderr);
      const run = JSON.parse(result.stdout);
      assert.equal(run.status, "passed");
      assert.equal(run.recordSaved, true);
      assert.deepEqual(
        run.results.map((item) => item.response.status),
        [200, 200, 200],
      );
      assert.deepEqual(
        run.results.map((item) => item.response.body),
        ['{"kind":"matched"}', "false", rawFallback],
      );
      assert.equal(run.attemptedRecordId, run.id);
      assert.equal(run.recordId, run.id);
      const persisted = await new Store(root).get(secondTarget.id);
      assert.deepEqual(
        persisted.runs.find((item) => item.id === run.id).results,
        run.results,
      );
      const restored = restoreProject(persisted);
      await app.store.save(restored);
      assert(restored.runs.some((item) => item.id === run.id));
      await stop(app);
      app = await createApp({ root, port: 0 });
      await mockCheck(await app.store.get(secondTarget.id));
      await mockCheck(await app.store.get(restored.id));
      const restoredDisk = await new Store(root).get(restored.id);
      assert.deepEqual(
        restoredDisk.runs.find((item) => item.id === run.id).results,
        run.results,
      );
      assert.deepEqual(await app.store.get(target.id), firstGenerationBefore);
      assert.deepEqual(await app.store.get(source.id), sourceBefore);
      assert.deepEqual(await app.store.get(denied.id), deniedBefore);
      assert.deepEqual(document, inputBefore);
    },
  );
