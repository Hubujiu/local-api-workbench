import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../src/server.mjs";
import { snapshotPlan } from "../src/core.mjs";

test("plan CLI returns machine-readable evidence and truthful pass/fail exit codes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-cli-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("CLI fixture");
  const request = {
    id: "echo",
    name: "Echo",
    method: "GET",
    url: app.url + "/mock/" + project.id + "/echo",
    examples: [{ status: 200, body: '{"ok":true}' }],
  };
  project.requests = [request];
  project.plans = [
    snapshotPlan({
      id: "pass",
      name: "Pass",
      steps: [
        {
          request: {
            ...request,
            beforeScript: 'pm.environment.set("cliScope","persisted");',
          },
        },
      ],
    }),
    snapshotPlan({
      id: "fail",
      name: "Fail",
      steps: [
        {
          request: {
            ...request,
            assertions: [{ target: "status", op: "eq", value: 201 }],
          },
        },
      ],
    }),
  ];
  await app.store.save(project);
  const invoke = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/run-plan.mjs", ...args], {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => (stdout += data));
      child.stderr.on("data", (data) => (stderr += data));
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("CLI deadline exceeded"));
      }, 10000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  const output = path.join(root, "evidence.json");
  const passed = await invoke([
    "--project",
    project.id,
    "--plan",
    "pass",
    "--output",
    output,
  ]);
  assert.equal(passed.code, 0, passed.stderr + "\n" + passed.stdout);
  assert.equal(JSON.parse(passed.stdout).status, "passed");
  assert.equal(
    (await app.store.get(project.id)).environments[0].variables.cliScope,
    "persisted",
  );
  assert.deepEqual(
    JSON.parse(await readFile(output, "utf8")),
    JSON.parse(passed.stdout),
  );
  const failed = await invoke(["--project", project.id, "--plan", "fail"]);
  assert.equal(failed.code, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).status, "failed");
  const invalid = await invoke(["--project", project.id]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Usage/);
  assert.equal((await app.store.get(project.id)).runs.length, 2);
});
