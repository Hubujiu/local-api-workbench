// Real SQL services are supplied by remote-database.mjs; importing this module
// starts nothing. Grants belong to individual transports, never the export.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";

async function diskText(directory) {
  const chunks = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) chunks.push(await diskText(filename));
    else if (entry.isFile()) chunks.push(await readFile(filename, "utf8"));
    else throw Error("Unexpected fixture data entry");
  }
  return chunks.join("\n");
}
const binding = (project) => project.settings.apipostDatabases[0].id;

export async function verifyNativeDatabaseExportTransports(config) {
  assert(["postgres", "mysql"].includes(config.type));
  const originalConfig = structuredClone(config);
  const root = await mkdtemp(path.join(tmpdir(), "native-export-transports-"));
  const data = path.join(root, "data"),
    grantsFile = path.join(root, "grants.json");
  const clients = [],
    surfaces = [],
    savedRuns = [],
    wire = [];
  let app;
  const peer = http.createServer((req, res) => {
    wire.push(req.headers["x-db-value"]);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value: req.headers["x-db-value"] }));
  });
  const noSecrets = (text) => {
    for (const secret of [
      config.password,
      config.user,
      config.ca,
      grantsFile,
      "discard-this-fictional-password",
      "private-host.invalid",
      "synthetic-user",
      "synthetic-db",
    ].filter(Boolean))
      for (const spelling of [secret, JSON.stringify(secret).slice(1, -1)])
        assert(
          !text.includes(spelling),
          "transport or persisted evidence retained a secret",
        );
  };
  try {
    await new Promise((resolve, reject) => {
      peer.once("error", reject);
      peer.listen(0, "127.0.0.1", resolve);
    });
    app = await createApp({ root: data, port: 0 });
    const owner = async (route, body, method = "POST", status = 200) => {
      const response = await fetch(app.url + "/api/" + route, {
        method,
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      // Do not print a body that might contain an accidental connection leak.
      assert.equal(response.status, status, "owner fixture request status");
      return value;
    };
    const source = nativeDatabaseFixture(
      `http://127.0.0.1:${peer.address().port}/`,
      config.type === "mysql" ? "mysql" : "pg",
    );
    const sourceProject = await app.store.create("Export source");
    await owner(`projects/${sourceProject.id}/import`, { document: source });
    const sourceBefore = await app.store.get(sourceProject.id);
    const document = await owner(
      `projects/${sourceProject.id}/export?format=apipost&databaseMode=rebind`,
      undefined,
      "GET",
    );
    noSecrets(JSON.stringify(document));
    const imported = [];
    for (const name of ["HTTP", "stdio", "CLI", "ungranted"]) {
      const empty = await app.store.create(name);
      const project = await owner(`projects/${empty.id}/import`, { document });
      const plan = await owner(`projects/${project.id}/plans`, {
        name: "Native export",
        environmentId: project.environments[0].id,
        steps: [{ request: project.requests[0] }],
      });
      imported.push({ ...project, testPlanId: plan.id });
    }
    const [httpProject, stdioProject, cliProject, other] = imported;
    // Identical exported binding IDs must not imply project authority.
    for (const project of imported)
      assert.equal(binding(project), binding(other));
    const checkRun = (project, result, passed) => {
      assert.equal(result.status, passed ? "passed" : "failed");
      assert.equal(result.recordSaved, true);
      if (passed)
        assert.equal(result.results[0].databaseQueries[0].status, "completed");
      savedRuns.push({
        projectId: project.id,
        id: result.id,
        status: result.status,
      });
      surfaces.push(JSON.stringify(result));
      return result;
    };
    const mcpRun = async (client, project, passed) => {
      const result = await client.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: project.id, planId: project.testPlanId },
      });
      surfaces.push(JSON.stringify(result));
      assert.notEqual(result.isError, true, "allowed project tool response");
      return checkRun(project, JSON.parse(result.content[0].text), passed);
    };
    const noWire = async (action) => {
      const count = wire.length;
      await action();
      assert.equal(
        wire.length,
        count,
        "denied execution must not reach HTTP peer",
      );
    };
    const withWire = async (action) => {
      const count = wire.length;
      await action();
      assert.equal(wire.length, count + 1);
      assert.equal(wire.at(-1), "prefix-from-database");
    };
    const policy = await owner("mcp/config", {
      enabled: true,
      projects: [httpProject.id, other.id],
      write: true,
      execute: true,
      remember: false,
    });
    const httpClient = new Client({ name: "native-export-http", version: "1" });
    clients.push({ client: httpClient, stderr: "" });
    await httpClient.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + policy.token } },
      }),
    );
    await noWire(() => mcpRun(httpClient, httpProject, false));
    // Owner-local authority is not MCP authority, even for the same project.
    const localGrant = await owner(
      `projects/${httpProject.id}/database-connections`,
      { ...config, bindingId: binding(httpProject), name: "Owner only" },
    );
    await noWire(() => mcpRun(httpClient, httpProject, false));
    await owner(
      `projects/${httpProject.id}/database-connections`,
      { id: localGrant.id },
      "DELETE",
    );
    const grant = await owner(
      `projects/${httpProject.id}/mcp-database-connections`,
      { ...config, bindingId: binding(httpProject), name: "MCP only" },
    );
    await withWire(() => mcpRun(httpClient, httpProject, true));
    await noWire(() => mcpRun(httpClient, other, false));
    await noWire(async () => {
      const response = await httpClient.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: cliProject.id, planId: cliProject.testPlanId },
      });
      surfaces.push(JSON.stringify(response));
      assert.equal(response.isError, true);
    });
    await owner(
      `projects/${httpProject.id}/mcp-database-connections`,
      { id: grant.id },
      "DELETE",
    );
    await noWire(() => mcpRun(httpClient, httpProject, false));
    await httpClient.close();

    const grantText = JSON.stringify({
      version: 1,
      projects: [
        {
          projectId: stdioProject.id,
          databaseConnections: { [binding(stdioProject)]: config },
        },
      ],
    });
    await writeFile(grantsFile, grantText, { mode: 0o600 });
    const stdio = async (withGrant) => {
      const client = new Client({ name: "native-export-stdio", version: "1" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
          "--project",
          stdioProject.id,
          "--project",
          other.id,
          "--write",
          "--execute",
          ...(withGrant ? ["--database-grants-file", grantsFile] : []),
        ],
        env: { LOCAL_API_DATA: data },
        stderr: "pipe",
      });
      const connection = { client, stderr: "" };
      clients.push(connection);
      transport.stderr?.on("data", (chunk) => {
        connection.stderr += chunk.toString();
      });
      await client.connect(transport);
      return client;
    };
    let client = await stdio(false);
    await noWire(() => mcpRun(client, stdioProject, false));
    await client.close();
    client = await stdio(true);
    await withWire(() => mcpRun(client, stdioProject, true));
    await noWire(() => mcpRun(client, other, false));
    await client.close();
    client = await stdio(false);
    await noWire(() => mcpRun(client, stdioProject, false));
    await client.close();
    assert.equal(await readFile(grantsFile, "utf8"), grantText);

    const cli = (project, connections) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
            "--project",
            project.id,
            "--plan",
            project.testPlanId,
            ...(connections === undefined ? [] : ["--database-stdin"]),
          ],
          {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: { ...process.env, LOCAL_API_DATA: data },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(Error("Native export CLI fixture deadline"));
        }, 15000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.stdin.on("error", () => {});
        child.stdin.end(
          connections === undefined
            ? undefined
            : JSON.stringify({ databaseConnections: connections }),
        );
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          surfaces.push(stdout, stderr);
          resolve({ code, stdout });
        });
      });
    const cliRun = async (project, connections, passed) => {
      const result = await cli(project, connections);
      assert.equal(result.code, passed ? 0 : 1);
      return checkRun(project, JSON.parse(result.stdout), passed);
    };
    await noWire(() => cliRun(cliProject, undefined, false));
    await withWire(() =>
      cliRun(cliProject, { [binding(cliProject)]: config }, true),
    );
    await noWire(() => cliRun(other, undefined, false));
    await noWire(() => cliRun(cliProject, undefined, false));
    await noWire(async () => {
      const result = await cli(cliProject, { "not-a-plan-binding": config });
      assert.equal(result.code, 2);
      assert.equal(result.stdout, "");
    });

    for (const project of imported) {
      const disk = await new Store(data).get(project.id);
      const expectedRuns = savedRuns.filter(
        (run) => run.projectId === project.id,
      );
      for (const expected of expectedRuns) {
        const persisted = disk.runs.find((run) => run.id === expected.id);
        assert(
          persisted,
          "transport run ID must be present after reopening Store",
        );
        assert.equal(persisted.status, expected.status);
        if (expected.status === "passed")
          assert.equal(
            persisted.results[0].databaseQueries[0].status,
            "completed",
          );
      }
      if (project.id !== other.id)
        assert.equal(
          disk.environments[0].variables.native_value,
          "from-database",
        );
      else
        assert.notEqual(
          disk.environments[0].variables.native_value,
          "from-database",
        );
      assert.deepEqual(
        await owner(
          `projects/${project.id}/database-connections`,
          undefined,
          "GET",
        ),
        [],
      );
    }
    assert.deepEqual(await new Store(data).get(sourceProject.id), sourceBefore);
    for (const connection of clients) surfaces.push(connection.stderr);
    surfaces.push(await diskText(data));
    for (const surface of surfaces) noSecrets(surface);
    assert.deepEqual(config, originalConfig);
    for (const transport of ["HTTP", "STDIO", "CLI"])
      console.log(
        `REAL_NATIVE_EXPORT_${config.type.toUpperCase()}_${transport}_PASS`,
      );
  } finally {
    await Promise.all(
      clients.map(({ client }) => client.close().catch(() => {})),
    );
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    peer.closeAllConnections();
    if (peer.listening) await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
