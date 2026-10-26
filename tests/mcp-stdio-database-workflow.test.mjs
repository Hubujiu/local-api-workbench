import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { parseMCPStdioArguments } from "../src/mcp-stdio-bootstrap.mjs";
const main = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
async function diskText(dir) {
  let output = "";
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name);
    output += item.isDirectory()
      ? await diskText(p)
      : await readFile(p, "utf8");
  }
  return output;
}
test("stdio argument parsing requires explicit file authority and rejects ambiguous arguments", () => {
  for (const argv of [
    ["--database-grants-file"],
    ["--database-grants-file", "private"],
    ["--project"],
    ["--project", "--write"],
    ["--unknown"],
    [
      "--project",
      "p",
      "--write",
      "--execute",
      "--database-grants-file",
      "one",
      "--database-grants-file",
      "two",
    ],
  ])
    assert.throws(() => parseMCPStdioArguments(argv));
  assert.deepEqual(
    parseMCPStdioArguments(["--project", "p", "--project", "p", "--write"]),
    { projects: ["p"], write: true, execute: false, filename: undefined },
  );
});
test(
  "official SDK stdio explicit SQLite grant runs through HTTP and persistence without leaking or crossing projects",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "stdio-db-workflow-"));
    const data = path.join(root, "data"),
      filename = path.join(root, "private-fixture.db"),
      grantsFile = path.join(root, "private-grants.json");
    const db = new DatabaseSync(filename);
    db.exec(
      "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('wire-value')",
    );
    db.close();
    let calls = 0;
    const echo = http.createServer((req, res) => {
      calls++;
      res.end(JSON.stringify({ value: req.headers["x-db-value"] }));
    });
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const clients = [];
    t.after(async () => {
      for (const c of clients) await c.close();
      echo.closeAllConnections();
      await new Promise((r) => echo.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const store = new Store(data);
    await store.init();
    const a = await store.create("allowed"),
      b = await store.create("not granted");
    const request = {
      name: "database wire",
      url: `http://127.0.0.1:${echo.address().port}/`,
      inheritSharedScripts: false,
      nativeTasks: {
        version: 1,
        before: [
          {
            type: "database",
            enabled: 1,
            data: {
              connectionId: "private-alias",
              query: "SELECT value FROM records",
              isConsoleOutput: -1,
              variables: [
                { name: "value", type: "environment", pattern: "$[0].value" },
              ],
            },
          },
          {
            type: "customScript",
            enabled: 1,
            data: 'apt.setRequestHeader("x-db-value",pm.environment.get("value"));',
          },
        ],
        after: [
          {
            type: "customScript",
            enabled: 1,
            data: 'pm.test("wire",()=>pm.expect(pm.response.json().value).to.equal("wire-value"));',
          },
        ],
      },
    };
    for (const p of [a, b]) {
      p.plans = [snapshotPlan({ id: "db-flow", steps: [{ request }] })];
      await store.save(p);
    }
    const grantText = JSON.stringify({
      version: 1,
      projects: [
        {
          projectId: a.id,
          databaseConnections: {
            "private-alias": { type: "sqlite", filename },
          },
        },
      ],
    });
    await writeFile(grantsFile, grantText, { mode: 0o600 });
    const connect = async (withFile) => {
      const client = new Client({ name: "stdio-db-owner", version: "1" });
      clients.push(client);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          main,
          "--project",
          a.id,
          "--project",
          b.id,
          "--write",
          "--execute",
          ...(withFile ? ["--database-grants-file", grantsFile] : []),
        ],
        env: { LOCAL_API_DATA: data },
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
      await client.connect(transport);
      return { client, stderr: () => stderr };
    };
    const run = async (c, p) =>
      decode(
        await c.callTool({
          name: "localapi_run_plan",
          arguments: { projectId: p.id, planId: "db-flow" },
        }),
      );
    const first = await connect(true);
    assert.equal((await run(first.client, a)).status, "passed");
    assert.equal(calls, 1);
    assert.equal((await run(first.client, b)).status, "failed");
    assert.equal(calls, 1);
    // Editing the file does not alter the already explicit, process-local snapshot.
    await writeFile(grantsFile, "invalid-after-start");
    assert.equal((await run(first.client, a)).status, "passed");
    assert.equal(calls, 2);
    await first.client.close();
    const second = await connect(false);
    assert.equal((await run(second.client, a)).status, "failed");
    assert.equal(calls, 2);
    await second.client.close();
    await writeFile(grantsFile, grantText);
    const third = await connect(true);
    assert.equal((await run(third.client, a)).status, "passed");
    assert.equal(calls, 3);
    await third.client.close();
    const saved = await new Store(data).get(a.id);
    assert.ok(saved.runs.length >= 4);
    assert.equal(await readFile(grantsFile, "utf8"), grantText);
    const persisted = await diskText(data);
    assert.equal(persisted.includes(filename), false);
    assert.equal(persisted.includes(grantsFile), false);
    assert.equal(first.stderr().includes(filename), false);
    assert.equal(third.stderr().includes(filename), false);
  },
);
test(
  "stdio startup grant failure exits with only redacted stderr before reading protocol",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "stdio-db-invalid-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "SECRET_PATH.json");
    await writeFile(file, '{"password":"SECRET_INPUT"}', { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [
        main,
        "--project",
        "p",
        "--write",
        "--execute",
        "--database-grants-file",
        file,
      ],
      {
        env: { LOCAL_API_DATA: path.join(root, "data") },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.stdin.on("error", () => {});
    child.stdin.end(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    );
    const code = await new Promise((r) => child.once("close", r));
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /MCP stdio/);
    assert.doesNotMatch(stderr, /SECRET_PATH|SECRET_INPUT/);
  },
);
