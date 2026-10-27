import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { fixture, verify } from "./helpers/native-signing-fixture.mjs";
const decode = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
function cli(root, projectId, planId, environmentId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        projectId,
        "--plan",
        planId,
        ...(environmentId === undefined
          ? []
          : ["--environment", environmentId]),
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
      failure = Error("Signing CLI fixture timed out");
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
    `native signing ${transport}/${format} SDK and CLI preserve independently verified wire auth through frozen restore`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(
          path.join(tmpdir(), "native-signing-entrypoints-"),
        ),
        seen = [],
        errors = [];
      let base;
      const upstream = http.createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        try {
          seen.push(verify(req, body, base));
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        } catch (error) {
          errors.push(error.message);
          res.statusCode = 401;
          res.end("fixture signature rejected");
        }
      });
      await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${upstream.address().port}`;
      let app = await createApp({ root, port: 0 }),
        client;
      t.after(async () => {
        await client?.close().catch(() => {});
        await closeServer(app.server);
        await closeServer(upstream);
        await rm(root, { recursive: true, force: true });
      });
      const source = await app.store.create("Signed source"),
        target = await app.store.create("Signed target"),
        second = await app.store.create("Second generation"),
        other = await app.store.create("Outside allowlist");
      importIntoProject(source, fixture(base));
      delete source.requests[5].auth.algorithm;
      delete source.requests[5].auth.payloadHash;
      await app.store.save(source);
      const sourceBefore = await app.store.get(source.id),
        targetBefore = await app.store.get(target.id),
        otherBefore = await app.store.get(other.id);
      const expectedAuth = source.requests.map((r, i) =>
        i === 5
          ? { ...r.auth, algorithm: "sha256", payloadHash: "enabled" }
          : r.auth,
      );
      const connect = async (write, execute) => {
        await client?.close().catch(() => {});
        client = new Client(
          { name: "signing-roundtrip", version: "1" },
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
              projects: [source.id, target.id, second.id],
              write,
              execute,
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
              second.id,
              ...(write ? ["--write"] : []),
              ...(execute ? ["--execute"] : []),
            ],
            env: { LOCAL_API_DATA: root },
            stderr: "pipe",
          });
          stdio.stderr.resume();
          await client.connect(stdio);
        }
      };
      const raw = (name, args) =>
          client.callTool({ name: "localapi_" + name, arguments: args }),
        call = async (name, args) => decode(await raw(name, args));
      await connect(false, false);
      const exported = await call("export_project", {
        projectId: source.id,
        format,
      });
      assert.equal(
        (await raw("export_project", { projectId: other.id, format })).isError,
        true,
      );
      assert.equal(
        (
          await raw("import_project", {
            projectId: target.id,
            format,
            document: exported.document,
          })
        ).isError,
        true,
      );
      assert.deepEqual(await app.store.get(target.id), targetBefore);
      assert.deepEqual(seen, []);
      await connect(true, false);
      const imported = await call("import_project", {
        projectId: target.id,
        format,
        document: exported.document,
      });
      let saved = await app.store.get(target.id);
      const requests = imported.imported.requestIds.map((id) =>
        saved.requests.find((r) => r.id === id),
      );
      assert.deepEqual(
        requests.map((r) => r.auth),
        expectedAuth,
      );
      const exportedAgain = await call("export_project", {
        projectId: target.id,
        format,
      });
      const importedAgain = await call("import_project", {
        projectId: second.id,
        format,
        document: exportedAgain.document,
      });
      const secondSaved = await app.store.get(second.id);
      assert.deepEqual(
        importedAgain.imported.requestIds.map(
          (id) => secondSaved.requests.find((r) => r.id === id).auth,
        ),
        expectedAuth,
      );
      assert.deepEqual(seen, []);
      const environment = saved.environments.find((e) => e.name === "Imported");
      assert(environment);
      const plan = await call("create_execution_flow", {
        projectId: target.id,
        plan: {
          name: "Frozen signatures",
          statusPolicy: "strict200",
          environmentId: environment.id,
          steps: requests.map((request) => ({ request })),
        },
      });
      assert.equal(
        (await raw("execute_flow", { projectId: target.id, planId: plan.id }))
          .isError,
        true,
      );
      assert.deepEqual(seen, []);
      await client.close();
      client = null;
      saved = await app.store.get(target.id);
      for (const request of saved.requests)
        request.auth = { type: "bearer", token: "fictional-live-change" };
      saved.settings.globalAuth = {
        type: "bearer",
        token: "fictional-later-global",
      };
      await app.store.save(saved);
      const checkRun = (run) => {
        assert.equal(run.status, "passed", JSON.stringify({ run, errors }));
        assert.equal(run.recordSaved, true);
        assert.equal(run.environmentId, environment.id);
        assert.equal(run.snapshot.environmentId, environment.id);
        assert.equal(run.results.length, 6);
        assert.deepEqual(
          run.snapshot.steps.map((s) => s.request.auth),
          expectedAuth,
        );
        for (const result of run.results)
          assert.deepEqual(JSON.parse(result.response.body), { ok: true });
      };
      await connect(true, true);
      checkRun(
        await call("execute_flow", { projectId: target.id, planId: plan.id }),
      );
      assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]);
      assert.deepEqual(errors, []);
      await client.close();
      client = null;
      const executed = await cli(root, target.id, plan.id, environment.id);
      assert.equal(executed.code, 0, executed.stderr);
      checkRun(JSON.parse(executed.stdout));
      assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5]);
      const persisted = await app.store.get(target.id),
        restored = restoreProject(persisted);
      for (const project of [persisted, restored]) {
        const runs = project.runs.filter((r) => r.snapshot?.id === plan.id);
        assert.equal(
          runs.length,
          2,
          "MCP and CLI durable evidence must actually exist",
        );
        assert(runs.every((r) => r.environmentId === environment.id));
        assert.deepEqual(
          project.plans
            .find((p) => p.id === plan.id)
            .steps.map((s) => s.request.auth),
          expectedAuth,
        );
      }
      await app.store.save(restored);
      await closeServer(app.server);
      app = await createApp({ root, port: 0 });
      const afterRestart = await cli(
        root,
        restored.id,
        plan.id,
        environment.id,
      );
      assert.equal(afterRestart.code, 0, afterRestart.stderr);
      checkRun(JSON.parse(afterRestart.stdout));
      assert.deepEqual(
        seen,
        [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5],
      );
      assert.deepEqual(errors, []);
      assert.equal(
        (await app.store.get(restored.id)).runs.filter(
          (r) => r.snapshot?.id === plan.id,
        ).length,
        3,
      );
      assert.deepEqual(await app.store.get(source.id), sourceBefore);
      assert.deepEqual(await app.store.get(other.id), otherBefore);
    },
  );
