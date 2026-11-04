import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";

// Actual owner/SDK/storage lifecycle fixtures for ordinary CI. No execution
// tools are granted; this does not cancel already-dispatched work.
async function closeApp(app) {
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archive-grants-"));
  const c = { root, app: await createApp({ root, port: 0 }), clients: [] };
  c.closeClients = async () => {
    await Promise.all(
      c.clients.map((client) => client.close().catch(() => {})),
    );
    c.clients = [];
  };
  c.restart = async () => {
    await c.closeClients();
    await closeApp(c.app);
    c.app = await createApp({ root, port: 0 });
  };
  t.after(async () => {
    await c.closeClients();
    await closeApp(c.app);
    await rm(root, { recursive: true, force: true });
  });
  c.p = await owner(
    c,
    "/api/projects",
    "POST",
    { name: "Archive target" },
    201,
  );
  c.other = await owner(
    c,
    "/api/projects",
    "POST",
    { name: "Other allowed" },
    201,
  );
  c.denied = await owner(
    c,
    "/api/projects",
    "POST",
    { name: "Never allowed" },
    201,
  );
  return c;
}
async function owner(c, url, method = "GET", data, status = 200) {
  const response = await fetch(c.app.url + url, {
    method,
    headers: {
      "x-local-token": c.app.token,
      "content-type": "application/json",
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}
const configPath = (c) => path.join(c.root, ".mcp-config.json");
const projectPath = (id) => `/api/projects/${id}`;
const configuration = ({
  enabled,
  remember,
  projects,
  write,
  execute,
  token,
}) => ({ enabled, remember, projects, write, execute, token });
async function configure(c, remember, projects = [c.p.id, c.other.id]) {
  return owner(c, "/api/mcp/config", "POST", {
    enabled: true,
    remember,
    projects,
    write: false,
    execute: false,
  });
}
async function connect(c, kind, token) {
  const client = new Client(
    { name: "archive-grant-lifecycle", version: "1" },
    { capabilities: {} },
  );
  c.clients.push(client);
  await client.connect(
    kind === "http"
      ? new StreamableHTTPClientTransport(new URL(c.app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + token } },
        })
      : new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            c.p.id,
          ],
          env: { LOCAL_API_DATA: c.root },
          stderr: "pipe",
        }),
  );
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === "localapi_list_apis"));
  assert(
    !tools.tools.some((tool) =>
      /execute|save_plan|create_project/.test(tool.name),
    ),
  );
  return client;
}
async function read(client, projectId, error) {
  const result = await client.callTool({
    name: "localapi_list_apis",
    arguments: { projectId },
  });
  if (error) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, error);
  } else {
    assert.notEqual(result.isError, true, result.content[0]?.text);
    assert.deepEqual(JSON.parse(result.content[0].text), []);
  }
  return result;
}
async function bytes(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, value] of Object.entries(await bytes(file)))
        result[entry.name + "/" + name] = value;
    } else result[entry.name] = (await readFile(file)).toString("base64");
  }
  return result;
}
async function noExecution(c) {
  for (const id of [c.p.id, c.other.id, c.denied.id]) {
    const p = await owner(c, projectPath(id));
    for (const key of ["history", "runs", "protocolRuns"])
      assert.deepEqual(p[key] || [], []);
  }
}

for (const remember of [false, true])
  test(
    `failed archive preserves owner project and SDK grants; successful archive persists revocation with remember=${remember}`,
    { timeout: 30000 },
    async (t) => {
      const c = await fixture(t);
      const initialConfig = await configure(c, remember);
      let http = await connect(c, "http", initialConfig.token);
      const stdio = await connect(c, "stdio");
      const other = await owner(c, projectPath(c.other.id));
      for (const client of [http, stdio]) {
        await read(client, c.p.id);
        await read(client, c.denied.id, /项目未授权/);
      }
      const stale = await owner(c, projectPath(c.p.id));
      await owner(c, projectPath(c.p.id), "PUT", {
        ...stale,
        name: "Current owner change",
      });
      const current = await owner(c, projectPath(c.p.id));
      const malformed = structuredClone(current);
      malformed.archived = true;
      malformed.environments[0].name = "";
      for (const [candidate, expected] of [
        [malformed, /名称不能为空/],
        [{ ...stale, archived: true }, /其他窗口|Git/],
      ]) {
        const before = await owner(c, projectPath(c.p.id));
        const disk = await bytes(c.app.store.directory(c.p.id));
        const remembered = await readFile(configPath(c));
        const failure = await owner(
          c,
          projectPath(c.p.id),
          "PUT",
          candidate,
          400,
        );
        assert.match(failure.error, expected);
        assert.equal(failure.code, undefined);
        assert.deepEqual(await owner(c, projectPath(c.p.id)), before);
        assert.deepEqual(await bytes(c.app.store.directory(c.p.id)), disk);
        assert.deepEqual(await readFile(configPath(c)), remembered);
        assert.deepEqual(
          configuration(await owner(c, "/api/mcp/config")),
          configuration(initialConfig),
        );
        for (const client of [http, stdio]) await read(client, c.p.id);
        await read(http, c.other.id);
      }
      // Valid archive still removes future HTTP authority; explicit stdio grants
      // are separate but must reject the now-archived project on every read.
      const archived = await owner(c, projectPath(c.p.id), "PUT", {
        ...current,
        archived: true,
      });
      assert.equal(archived.archived, true);
      await read(http, c.p.id, /项目未授权/);
      await read(stdio, c.p.id, /项目已归档/);
      await read(http, c.other.id);
      assert.deepEqual((await owner(c, "/api/mcp/config")).projects, [
        c.other.id,
      ]);
      const savedConfig = JSON.parse(await readFile(configPath(c), "utf8"));
      assert.deepEqual(savedConfig.projects, remember ? [c.other.id] : []);
      assert.equal(savedConfig.remember, remember);
      const unarchived = await owner(c, projectPath(c.p.id), "PUT", {
        ...archived,
        archived: false,
      });
      assert.equal(unarchived.archived, false);
      await read(http, c.p.id, /项目未授权/);
      await read(stdio, c.p.id);
      await c.restart();
      let afterRestart = await owner(c, "/api/mcp/config");
      if (remember) {
        assert.equal(afterRestart.token, initialConfig.token);
        assert.deepEqual(afterRestart.projects, [c.other.id]);
      } else {
        assert.equal(afterRestart.enabled, false);
        assert.equal(afterRestart.token, "");
        afterRestart = await configure(c, false, [c.other.id]);
      }
      http = await connect(c, "http", afterRestart.token);
      await read(http, c.p.id, /项目未授权/);
      await read(http, c.other.id);
      await read(http, c.denied.id, /项目未授权/);
      await configure(c, remember);
      await read(http, c.p.id);
      assert.deepEqual(await owner(c, projectPath(c.other.id)), other);
      await noExecution(c);
    },
  );

test(
  "real journaled archive failure revokes conservatively and recovers once without replay or a rollback claim",
  { timeout: 30000 },
  async (t) => {
    const c = await fixture(t);
    const config = await configure(c, true);
    const http = await connect(c, "http", config.token);
    const stdio = await connect(c, "stdio");
    const before = await owner(c, projectPath(c.p.id));
    const remembered = await readFile(configPath(c));
    const directory = c.app.store.directory(c.p.id),
      blocked = path.join(directory, "plans");
    // Empty plan collection is readable; actual apply reaches this obstruction
    // only after publishing the real transaction journal.
    await rm(blocked, { recursive: true });
    await writeFile(blocked, "test-owned obstruction");
    const failure = await owner(
      c,
      projectPath(c.p.id),
      "PUT",
      { ...before, archived: true },
      400,
    );
    assert.equal(failure.code, "PROJECT_COMMIT_UNCERTAIN");
    assert.equal(failure.project_id, c.p.id);
    assert.equal(failure.commit_outcome, "unknown");
    assert.equal(failure.retry_safe, false);
    assert(!JSON.stringify(failure).includes(c.root));
    const journal = JSON.parse(
      await readFile(path.join(directory, ".transaction.json"), "utf8"),
    );
    assert.equal(journal.archived, true);
    assert.equal(journal.revision, before.revision + 1);
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "project.json"), "utf8"))
        .archived,
      before.archived,
    );
    assert.deepEqual((await owner(c, "/api/mcp/config")).projects, [
      c.other.id,
    ]);
    assert.deepEqual(
      await readFile(configPath(c)),
      remembered,
      "uncertainty does not claim durable grant cleanup",
    );
    await read(http, c.p.id, /项目未授权/);
    await read(http, c.other.id);
    await rm(blocked);
    const recovered = await owner(c, projectPath(c.p.id));
    assert.equal(recovered.archived, true);
    assert.equal(recovered.revision, journal.revision);
    assert.deepEqual(await owner(c, projectPath(c.p.id)), recovered);
    await assert.rejects(readFile(path.join(directory, ".transaction.json")), {
      code: "ENOENT",
    });
    await read(stdio, c.p.id, /项目已归档/);
    await c.restart();
    const reloadedConfig = await owner(c, "/api/mcp/config");
    // Existing remembered grant bytes are unchanged, but recovered archived state
    // still denies both independently initialized transports after restart.
    assert.deepEqual(reloadedConfig.projects, config.projects);
    await read(
      await connect(c, "http", reloadedConfig.token),
      c.p.id,
      /项目已归档/,
    );
    await read(await connect(c, "stdio"), c.p.id, /项目已归档/);
    assert.deepEqual(await owner(c, projectPath(c.p.id)), recovered);
    await noExecution(c);
  },
);

test(
  "remembered-config failure after archive commit cannot restore grants or pretend the project rolled back",
  { timeout: 30000 },
  async (t) => {
    const c = await fixture(t);
    const config = await configure(c, true);
    const http = await connect(c, "http", config.token);
    const stdio = await connect(c, "stdio");
    const before = await owner(c, projectPath(c.p.id));
    const remembered = await readFile(configPath(c));
    await rm(configPath(c));
    await mkdir(configPath(c));
    const failure = await owner(
      c,
      projectPath(c.p.id),
      "PUT",
      { ...before, archived: true },
      400,
    );
    assert.equal(typeof failure.error, "string");
    assert.equal(
      failure.code,
      undefined,
      "config failure is not a Store uncertain commit",
    );
    const committed = await owner(c, projectPath(c.p.id));
    assert.equal(committed.archived, true);
    assert.equal(committed.revision, before.revision + 1);
    assert.deepEqual((await owner(c, "/api/mcp/config")).projects, [
      c.other.id,
    ]);
    await read(http, c.p.id, /项目未授权/);
    await read(stdio, c.p.id, /项目已归档/);
    await read(http, c.other.id);
    // Repair only the test-owned obstruction. Do not pretend the failed config
    // write succeeded: the original remembered bytes are restored explicitly.
    await rm(configPath(c), { recursive: true });
    await writeFile(configPath(c), remembered);
    await c.restart();
    const reloaded = await owner(c, "/api/mcp/config");
    await read(await connect(c, "http", reloaded.token), c.p.id, /项目已归档/);
    assert.deepEqual(await owner(c, projectPath(c.p.id)), committed);
    await noExecution(c);
  },
);
