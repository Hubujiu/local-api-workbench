// Reusable real-service acceptance, not an original-process parity fixture.
// Callers supply an already running disposable database; this module starts no
// database service and performs no work merely by being imported.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";

async function diskText(directory) {
  const chunks = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) chunks.push(await diskText(filename));
    else if (entry.isFile()) chunks.push(await readFile(filename, "utf8"));
    else throw Error("Unexpected non-file entry in isolated MCP fixture data");
  }
  return chunks.join("\n");
}

export async function verifyMCPStdioNativeDatabaseFlow(
  config,
  { sourceFactory } = {},
) {
  assert(["postgres", "mysql", "mongodb"].includes(config.type));
  assert(!Object.hasOwn(config, "name"));
  assert(!Object.hasOwn(config, "bindingId"));
  if (config.type === "mongodb")
    assert.equal(
      typeof sourceFactory,
      "function",
      "Mongo requires its independent native source factory",
    );
  const originalConfig = structuredClone(config);
  const root = await mkdtemp(path.join(tmpdir(), "mcp-stdio-native-db-"));
  const data = path.join(root, "project-data"),
    grantsFile = path.join(root, "private-process-grants.json"),
    clients = [],
    protocolResults = [],
    wireValues = [];
  const echo = http.createServer((req, res) => {
    wireValues.push(req.headers["x-db-value"]);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value: req.headers["x-db-value"] }));
  });
  try {
    await new Promise((resolve, reject) => {
      echo.once("error", reject);
      echo.listen(0, "127.0.0.1", resolve);
    });
    const store = new Store(data);
    await store.init();
    const allowed = await store.create("MCP stdio native granted"),
      ungranted = await store.create(
        "MCP stdio allowed project without DB grant",
      ),
      denied = await store.create("MCP stdio project outside allowlist");
    const endpoint = `http://127.0.0.1:${echo.address().port}/echo`;
    const source = sourceFactory
      ? sourceFactory(endpoint)
      : nativeDatabaseFixture(
          endpoint,
          config.type === "mysql" ? "mysql" : "pg",
        );
    const originalSource = structuredClone(source),
      planId = "stdio-native-db";
    for (const project of [allowed, ungranted, denied]) {
      importIntoProject(project, source);
      assert.equal(project.settings.apipostDatabases[0].type, config.type);
      assert(project.environments[0]?.id);
      project.plans = [
        snapshotPlan({
          id: planId,
          environmentId: project.environments[0].id,
          steps: [{ request: project.requests[0] }],
        }),
      ];
      await store.save(project);
    }
    const bindingId = allowed.settings.apipostDatabases[0].id;
    // A shared source ID deliberately produces the same binding in both
    // projects: denial must come from project-scoped authority, not a typo.
    assert.equal(ungranted.settings.apipostDatabases[0].id, bindingId);
    const grantText = JSON.stringify({
      version: 1,
      projects: [
        {
          projectId: allowed.id,
          databaseConnections: { [bindingId]: config },
        },
      ],
    });
    await writeFile(grantsFile, grantText, { mode: 0o600 });
    const connect = async (withFile) => {
      const client = new Client({
        name: "native-stdio-db-fixture",
        version: "1",
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
          "--project",
          allowed.id,
          "--project",
          ungranted.id,
          "--write",
          "--execute",
          ...(withFile ? ["--database-grants-file", grantsFile] : []),
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
      assert.equal(client.getServerVersion().name, "local-api-workbench");
      return connection;
    };
    const invoke = async (connection, project) => {
      const response = await connection.client.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: project.id, planId },
      });
      protocolResults.push(response);
      return response;
    };
    const run = async (connection, project) => {
      const response = await invoke(connection, project);
      assert.notEqual(
        response.isError,
        true,
        "Authorized project tool invocation failed",
      );
      assert.equal(response.content?.[0]?.type, "text");
      return JSON.parse(response.content[0].text);
    };
    const expected = config.type === "mongodb" ? "one" : "from-database";
    const first = await connect(true);
    const passed = await run(first, allowed);
    assert.equal(passed.status, "passed");
    assert.equal(passed.recordSaved, true);
    assert.equal(passed.results[0].databaseQueries[0].status, "completed");
    assert.deepEqual(wireValues, ["prefix-" + expected]);
    assert.equal((await run(first, ungranted)).status, "failed");
    assert.equal(wireValues.length, 1);
    assert.equal((await invoke(first, denied)).isError, true);
    assert.equal(wireValues.length, 1);
    await first.client.close();

    // The same stored plan is insufficient authority in a fresh subprocess.
    const second = await connect(false);
    assert.equal((await run(second, allowed)).status, "failed");
    assert.equal(wireValues.length, 1);
    await second.client.close();
    const third = await connect(true);
    const regranted = await run(third, allowed);
    assert.equal(regranted.status, "passed");
    assert.equal(regranted.recordSaved, true);
    assert.equal(regranted.results[0].databaseQueries[0].status, "completed");
    assert.deepEqual(wireValues, ["prefix-" + expected, "prefix-" + expected]);
    await third.client.close();

    const saved = await new Store(data).get(allowed.id);
    assert.equal(saved.environments[0].variables.native_value, expected);
    for (const completed of [passed, regranted])
      assert(
        saved.runs.some(
          (run) =>
            run.id === completed.id &&
            run.status === "passed" &&
            run.results[0].databaseQueries[0].status === "completed",
        ),
      );
    assert(saved.runs.some((run) => run.status === "failed"));
    const other = await new Store(data).get(ungranted.id);
    assert(other.runs.some((run) => run.status === "failed"));
    assert.notEqual(other.environments[0].variables.native_value, expected);
    assert.equal(await readFile(grantsFile, "utf8"), grantText);
    const secrets = [
      grantsFile,
      config.filename,
      config.user,
      config.password,
      config.ca,
      config.ssh?.password,
      config.ssh?.privateKey,
      config.ssh?.passphrase,
      "discard-this-fictional-password",
      "private-host.invalid",
      "source-auth-not-inherited",
    ].filter((value) => typeof value === "string" && value.length);
    const surfaces = [
      ["project/history files", await diskText(data)],
      [
        "MCP tool responses",
        protocolResults
          .flatMap((response) =>
            (response.content || [])
              .filter((item) => item.type === "text")
              .map((item) => item.text),
          )
          .join("\n"),
      ],
      ...clients.map((connection, index) => [
        "subprocess stderr " + index,
        connection.stderr,
      ]),
    ];
    for (const [label, text] of surfaces)
      for (const secret of secrets)
        for (const spelling of [secret, JSON.stringify(secret).slice(1, -1)])
          assert.equal(
            text.includes(spelling),
            false,
            label + " retained a connection secret or grants-file path",
          );
    assert.deepEqual(source, originalSource);
    assert.deepEqual(config, originalConfig);
    console.log(
      config.type === "mongodb"
        ? "REAL_MCP_STDIO_DECLARED_MONGODB_GRANTS_HTTP_RESTART_PASS"
        : "REAL_MCP_STDIO_NATIVE_" +
            config.type.toUpperCase() +
            "_GRANTS_HTTP_RESTART_PASS",
    );
  } finally {
    await Promise.all(
      clients.map(({ client }) => client.close().catch(() => {})),
    );
    echo.closeAllConnections();
    if (echo.listening) await new Promise((resolve) => echo.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
