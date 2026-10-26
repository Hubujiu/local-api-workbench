import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/runtime.mjs";
import {
  importIntoProject,
  restoreProject,
  snapshotPlan,
} from "../src/core.mjs";
import { nativeRedisFixture } from "./fixtures/apipost-redis.mjs";

// Cross-feature acceptance: native database import + invocation-only CLI grants.
export async function verifyNativeRedisCLIFlow(config) {
  return verifyNativeDatabaseCLIFlow(config);
}
export async function verifyNativeDatabaseCLIFlow(
  config,
  {
    sourceFactory = nativeRedisFixture,
    expectedValue = "hello",
    requiresSSH = false,
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-db-cli-"));
  let calls = 0;
  const echo = http.createServer((req, res) => {
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value: req.headers["x-db-value"] }));
  });
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const invoke = (projectId, planId, connections) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "scripts/run-plan.mjs",
          "--project",
          projectId,
          "--plan",
          planId,
          ...(connections === undefined ? [] : ["--database-stdin"]),
        ],
        {
          cwd: path.resolve(import.meta.dirname, ".."),
          env: { ...process.env, LOCAL_API_DATA: root },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Native database CLI fixture deadline"));
      }, 15000);
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.stdin.on("error", () => {});
      child.stdin.end(
        connections === undefined
          ? undefined
          : JSON.stringify({ databaseConnections: connections }),
      );
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  try {
    const store = new Store(root),
      p = await store.create("Native database CLI");
    const source = sourceFactory(
        `http://127.0.0.1:${echo.address().port}/echo`,
      ),
      before = structuredClone(source);
    importIntoProject(p, source);
    p.plans = [
      snapshotPlan({
        id: "native",
        name: "Native",
        environmentId: p.environments[0].id,
        steps: [{ request: p.requests[0] }],
      }),
      snapshotPlan({
        id: "preflight",
        steps: [
          {
            request: {
              url: `http://127.0.0.1:${echo.address().port}/must-not-send`,
            },
          },
          { request: p.requests[0] },
        ],
      }),
    ];
    await store.save(p);
    const binding = p.settings.apipostDatabases[0].id;
    const denied = await invoke(p.id, "native");
    assert.equal(denied.code, 1);
    assert.equal(calls, 0);
    for (const connections of [
      {},
      {
        [binding]: {
          ...config,
          type: config.type === "postgres" ? "mysql" : "postgres",
        },
      },
      { [binding]: config, foreign: config },
    ]) {
      const failed = await invoke(p.id, "preflight", connections);
      assert.equal(failed.code, 2, failed.stdout + failed.stderr);
      assert.equal(calls, 0);
    }
    if (requiresSSH) {
      assert.equal(p.settings.apipostDatabases[0].requiresSSH, true);
      const { ssh, ...direct } = config;
      const noPin = { ...config, ssh: { ...ssh } };
      delete noPin.ssh.hostKeySHA256;
      for (const candidate of [direct, noPin]) {
        const invalid = await invoke(p.id, "preflight", {
          [binding]: candidate,
        });
        assert.equal(invalid.code, 2, invalid.stdout + invalid.stderr);
        assert.equal(calls, 0);
      }
      const wrongPin = {
        ...config,
        ssh: {
          ...ssh,
          hostKeySHA256:
            "SHA256:" +
            Buffer.alloc(32, 1).toString("base64").replace(/=$/, ""),
        },
      };
      const rejected = await invoke(p.id, "native", { [binding]: wrongPin });
      assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
      assert.match(rejected.stdout, /SSH|指纹/);
      assert.equal(calls, 0);
    }
    const allowed = await invoke(p.id, "native", { [binding]: config });
    assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
    const result = JSON.parse(allowed.stdout);
    assert.equal(result.status, "passed");
    assert.equal(result.recordSaved, true);
    assert.equal(calls, 1);
    const saved = await new Store(root).get(p.id);
    assert.equal(saved.environments[0].variables.native_value, expectedValue);
    assert(
      saved.runs.some(
        (r) =>
          r.id === result.id &&
          r.results[0].databaseQueries[0].status === "completed",
      ),
    );
    assert(!JSON.stringify(saved).includes('"databaseConnections"'));
    assert(!JSON.stringify(saved).includes("discard-this-fictional-password"));
    assert.equal((await invoke(p.id, "native")).code, 1);
    assert.equal(calls, 1);
    const restored = restoreProject(saved);
    await store.save(restored);
    assert.equal((await invoke(restored.id, "native")).code, 1);
    assert.equal(calls, 1);
    const restoredRun = await invoke(restored.id, "native", {
      [binding]: config,
    });
    assert.equal(restoredRun.code, 0, restoredRun.stdout + restoredRun.stderr);
    assert.equal(calls, 2);
    assert.deepEqual(source, before);
    console.log(
      requiresSSH
        ? "REAL_NATIVE_REQUIRED_SSH_" +
            config.type.toUpperCase() +
            "_CLI_PREFLIGHT_RESTORE_PASS"
        : config.type === "mongodb"
          ? "REAL_DECLARED_MONGODB_CLI_PREFLIGHT_RESTORE_PASS"
          : "REAL_NATIVE_REDIS_CLI_INPUT_ENGINE_PREFLIGHT_RESTORE_PASS",
    );
  } finally {
    echo.closeAllConnections();
    await new Promise((r) => echo.close(r));
    await rm(root, { recursive: true, force: true });
  }
}
