import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
export async function verifyCLIDatabaseFlow(
  config,
  sql,
  parameters = [],
  { native = false } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "cli-db-flow-"));
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        value: new URL(req.url, "http://local").searchParams.get("value"),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const store = new Store(root),
      project = await store.create("CLI database fixture");
    const op = {
      type: "database",
      connectionId: "fixture",
      sql,
      parameters,
      name: "dbValue",
      path: "$.rows[0].value",
    };
    const url = `http://127.0.0.1:${server.address().port}/?value={{dbValue}}`;
    project.plans = [
      snapshotPlan({
        id: "db",
        steps: [
          {
            request: {
              url,
              before: [op],
              after: [{ ...op, name: "afterValue" }],
              afterScript:
                'pm.test("database response matches",()=>pm.expect(pm.response.json().value).to.equal(apt.getVar("afterValue")));',
            },
          },
        ],
      }),
      snapshotPlan({
        id: "preflight",
        steps: [
          { request: { url: `http://127.0.0.1:${server.address().port}/` } },
          { request: { url, before: [op] } },
        ],
      }),
    ];
    if (native) {
      assert.equal(
        parameters.length,
        0,
        "native task SQL is static, never interpolated",
      );
      for (const plan of project.plans)
        for (const step of plan.steps) {
          if (!step.request.before?.length) continue;
          const request = step.request;
          const task = (operation) => ({
            type: "database",
            enabled: 1,
            data: {
              connectionId: operation.connectionId,
              query: operation.sql,
              ...(config.type === "redis"
                ? { resultShape: "redis-value" }
                : {}),
              isConsoleOutput: -1,
              variables: [
                {
                  name: operation.name,
                  type: "environment",
                  pattern: config.type === "redis" ? "$" : "$[0].value",
                },
              ],
            },
          });
          request.nativeTasks = {
            version: 1,
            before: [
              {
                type: "customScript",
                enabled: 1,
                data: 'const lexical="same-scope";',
              },
              ...request.before.map(task),
              {
                type: "customScript",
                enabled: 1,
                data: 'pm.test("lexical",()=>pm.expect(lexical).to.equal("same-scope"));',
              },
            ],
            after: [
              ...request.after.map(task),
              ...(request.afterScript
                ? [
                    {
                      type: "customScript",
                      enabled: 1,
                      data: request.afterScript,
                    },
                  ]
                : []),
            ],
          };
          request.before = [];
          request.after = [];
          request.beforeScript = "";
          request.afterScript = "";
          request.inheritSharedScripts = false;
        }
    }
    await store.save(project);
    if (native)
      assert.ok(
        (await store.get(project.id)).plans[0].steps[0].request.nativeTasks,
        "native tasks require the separate native execution feature, not silent fallback",
      );
    const invoke = (plan, flag, input) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "scripts/run-plan.mjs",
            "--project",
            project.id,
            "--plan",
            plan,
            ...(flag ? [flag] : []),
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
          reject(Error("CLI database fixture deadline"));
        }, 15000);
        child.stdout.on("data", (b) => (stdout += b));
        child.stderr.on("data", (b) => (stderr += b));
        child.stdin.on("error", () => {});
        child.stdin.end(input ? JSON.stringify(input) : undefined);
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
    const envelope = { databaseConnections: { fixture: config } };
    const passed = await invoke("db", "--database-stdin", envelope);
    assert.equal(passed.code, 0, passed.stdout + passed.stderr);
    const result = JSON.parse(passed.stdout);
    assert.equal(result.status, "passed");
    assert.equal(result.variables.dbValue, "fixture-value");
    assert.equal(requests, 1);
    const persisted = await new Store(root).get(project.id);
    assert.equal(persisted.runs.length, 1);
    assert.equal(persisted.runs[0].variables.afterValue, "fixture-value");
    assert(!JSON.stringify(persisted).includes('"databaseConnections"'));
    if (config.password)
      assert(!JSON.stringify(persisted).includes(config.password));
    if (config.filename)
      assert(!JSON.stringify(persisted).includes(config.filename));
    const denied = await invoke("db", null);
    assert.equal(denied.code, 1);
    assert.match(denied.stdout, /未授权/);
    assert.equal(requests, 1);
    for (const [flag, input] of [
      ["--credentials-stdin", envelope],
      ["--database-stdin", {}],
      [
        "--database-stdin",
        { databaseConnections: { fixture: { ...config, allowWrite: true } } },
      ],
      [
        "--database-stdin",
        { databaseConnections: { fixture: config, foreign: config } },
      ],
    ]) {
      const bad = await invoke("preflight", flag, input);
      assert.equal(bad.code, 2, bad.stdout + bad.stderr);
      assert.equal(
        requests,
        1,
        "invalid grants must fail before earlier HTTP step",
      );
    }
    if (native && config.type === "redis") {
      const wrongEngine = await invoke("preflight", "--database-stdin", {
        databaseConnections: { fixture: { ...config, type: "postgres" } },
      });
      assert.equal(wrongEngine.code, 2);
      assert.match(wrongEngine.stderr, /引擎/);
      assert.equal(requests, 1, "engine mismatch fails before earlier HTTP");
    }
    const repeat = await invoke("db", "--database-stdin", envelope);
    assert.equal(repeat.code, 0, repeat.stdout + repeat.stderr);
    assert.equal(requests, 2);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
}
