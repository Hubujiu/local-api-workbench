// Independent combined acceptance: real storage failures, not fabricated Store
// errors. Native import/export are definition-only even with project write access.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const documentBytes = 4 * 1024 * 1024;
const frameBytes = 8 * 1024 * 1024;
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

async function fixture(t, kind) {
  const directory = await mkdtemp(path.join(tmpdir(), "mcp-project-storage-"));
  const root = path.join(directory, "data"),
    wire = [];
  const upstream = http.createServer((req, res) => {
    wire.push(req.url);
    res.end("unexpected execution");
  });
  let app, client, transport;
  const stderr = [];
  t.after(async () => {
    await client?.close().catch(() => {});
    if (app) await closeServer(app.server);
    await closeServer(upstream);
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  if (kind === "http") app = await createApp({ root, port: 0 });
  const store = app?.store || new Store(root);
  await store.init();
  const target = await store.create("Existing import destination");
  const other = await store.create("Unrelated project must remain unchanged");
  target.requests = [
    normalizeRequest({
      id: "keep-existing",
      name: "Keep",
      url: `http://127.0.0.1:${upstream.address().port}/keep`,
    }),
  ];
  await store.save(target);
  const connect = async (nodeArgs = []) => {
    await client?.close();
    client = new Client(
      { name: "project-storage-acceptance", version: "1.0.0" },
      { capabilities: {} },
    );
    if (kind === "http") {
      const response = await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          projects: [target.id, other.id],
          write: true,
          execute: false,
          remember: false,
        }),
      });
      assert.equal(response.status, 200);
      const { token } = await response.json();
      transport = new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      });
    } else {
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          ...nodeArgs,
          fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
          "--project",
          target.id,
          "--project",
          other.id,
          "--write",
        ],
        env: { LOCAL_API_DATA: root },
        stderr: "pipe",
      });
      transport.stderr.setEncoding("utf8");
      transport.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert(names.includes("localapi_import_project"));
    assert(names.includes("localapi_export_project"));
    assert(!names.includes("localapi_run_plan"));
    assert(!names.includes("localapi_execute_api"));
  };
  return {
    directory,
    root,
    store,
    target,
    other,
    wire,
    stderr,
    base: `http://127.0.0.1:${upstream.address().port}`,
    connect,
    get client() {
      return client;
    },
    get transport() {
      return transport;
    },
    call: (name, args) =>
      client.callTool({ name: "localapi_" + name, arguments: args }),
    async restart() {
      await client.close();
      client = undefined;
      if (app) {
        await closeServer(app.server);
        app = await createApp({ root, port: 0 });
      }
      await connect();
    },
  };
}

// Serialized into a test-owned preload for the real stdio child, or installed on
// only the HTTP fixture's Store instance. The original save/read/locking and
// journal code still run. One unique project + request marker arms one disk fault.
function installBoundaryFault(store, config) {
  const originalSave = store.save;
  let armed = true,
    attempts = 0,
    readBarriers = 0;
  store.save = async function (value, options) {
    if (
      value.id !== config.projectId ||
      !value.requests?.some((request) => request.name === config.marker)
    )
      return originalSave.call(this, value, options);
    attempts++;
    const originalRead = this.readUnlocked;
    let oldRevision;
    if (armed) {
      armed = false;
      this.readUnlocked = async function (id) {
        const previous = await originalRead.call(this, id);
        readBarriers++;
        oldRevision = previous.revision;
        await rename(config.history, config.keptHistory);
        await writeFile(
          config.history,
          "test-owned ordinary file obstructs apply",
        );
        return previous;
      };
    }
    try {
      return await originalSave.call(this, value, options);
    } catch (error) {
      await writeFile(
        config.observation,
        JSON.stringify({
          attempts,
          readBarriers,
          oldRevision,
          typed: error instanceof ProjectCommitUncertain,
          code: error.code,
          projectId: error.projectId,
          causeCode: error.cause?.code,
        }),
      );
      throw error;
    } finally {
      this.readUnlocked = originalRead;
    }
  };
  return () => {
    store.save = originalSave;
  };
}

function nativeDocument(base, marker) {
  const document = modernApipostFixture();
  document.global.envs = [];
  document.global.servers = [];
  document.global.global_vars = {};
  document.apis = [document.apis[1]];
  const api = document.apis[0];
  Object.assign(api, {
    name: marker,
    parent_id: "0",
    url: base + "/never-execute",
  });
  api.request.auth = {
    type: "basic",
    basic: { username: "fictional-user", password: "fictional-import-secret" },
  };
  api.request.header.parameter = [];
  api.request.query.parameter = [];
  api.request.pre_tasks = [
    {
      type: "customScript",
      id: "must-not-execute",
      name: "Definition only",
      enabled: 1,
      data: 'pm.environment.set("mustNotExecute","yes");',
    },
  ];
  return document;
}

for (const kind of ["http", "stdio"])
  test(
    `official SDK ${kind} import reports real published-journal uncertainty without retry or execution`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t, kind);
      const before = await f.store.get(f.target.id),
        otherBefore = await f.store.get(f.other.id);
      const marker = "only-this-import-" + randomUUID();
      const directory = f.store.directory(f.target.id);
      const config = {
        projectId: f.target.id,
        marker,
        history: path.join(directory, "history"),
        keptHistory: path.join(directory, "history-kept"),
        observation: path.join(f.directory, "fault-observation.json"),
      };
      let restore = () => {};
      t.after(() => restore());
      if (kind === "http") {
        await f.connect();
        restore = installBoundaryFault(f.store, config);
      } else {
        const preload = path.join(f.directory, "owned-fault-preload.mjs");
        await writeFile(
          preload,
          [
            'import { rename, writeFile } from "node:fs/promises";',
            `import { Store } from ${JSON.stringify(new URL("../src/runtime.mjs", import.meta.url).href)};`,
            `import { ProjectCommitUncertain } from ${JSON.stringify(new URL("../src/project-commit-outcome.mjs", import.meta.url).href)};`,
            installBoundaryFault.toString(),
            `installBoundaryFault(Store.prototype, ${JSON.stringify(config)});`,
          ].join("\n"),
        );
        await f.connect(["--import", pathToFileURL(preload).href]);
      }
      const source = nativeDocument(f.base, marker),
        sourceBefore = structuredClone(source);
      const reply = await f.call("import_project", {
        projectId: f.target.id,
        format: "apipost",
        document: source,
      });
      assert.equal(reply.isError, true, JSON.stringify(reply));
      const outcome = JSON.parse(reply.content[0].text);
      assert.deepEqual(outcome, {
        error: "项目提交结果不确定；恢复并读取现有项目后再决定是否重试",
        code: "PROJECT_COMMIT_UNCERTAIN",
        project_id: f.target.id,
        commit_outcome: "unknown",
        retry_safe: false,
      });
      const serialized = JSON.stringify(reply);
      assert(Buffer.byteLength(serialized) < 2048);
      for (const secret of [
        f.directory,
        JSON.stringify(f.directory).slice(1, -1),
        "fictional-import-secret",
        "cause",
        "ENOTDIR",
        "EEXIST",
      ])
        assert(!serialized.includes(secret), secret);
      assert.deepEqual(source, sourceBefore);
      const observed = JSON.parse(await readFile(config.observation, "utf8"));
      assert.equal(observed.attempts, 1);
      assert.equal(observed.readBarriers, 1);
      assert.equal(observed.oldRevision, before.revision);
      assert.equal(observed.typed, true);
      assert.equal(observed.code, "PROJECT_COMMIT_UNCERTAIN");
      assert.equal(observed.projectId, f.target.id);
      assert.equal(typeof observed.causeCode, "string");
      restore();

      // The operation did not roll back: the real journal and imported API file
      // exist while final metadata still references the old project revision.
      assert.equal((await stat(config.history)).isFile(), true);
      const journalFile = path.join(directory, ".transaction.json");
      const journal = JSON.parse(await readFile(journalFile, "utf8"));
      assert.equal(journal.revision, before.revision + 1);
      const imported = journal.requests.filter(
        (request) => request.name === marker,
      );
      assert.equal(imported.length, 1);
      assert.equal(imported[0].auth.password, "fictional-import-secret");
      const apiFiles = await Promise.all(
        (await readdir(path.join(directory, "apis")))
          .filter((name) => name.endsWith(".json"))
          .map(async (name) =>
            JSON.parse(
              await readFile(path.join(directory, "apis", name), "utf8"),
            ),
          ),
      );
      assert.equal(
        apiFiles.filter((request) => request.id === imported[0].id).length,
        1,
      );
      assert.equal(
        JSON.parse(await readFile(path.join(directory, "project.json"), "utf8"))
          .revision,
        before.revision,
      );
      await assert.rejects(
        new Store(f.root).get(f.target.id),
        (error) => error instanceof ProjectCommitUncertain,
      );
      await f.client.ping();
      assert.deepEqual(f.wire, []);
      assert.deepEqual(await f.store.get(f.other.id), otherBefore);

      // Repair only this test's ordinary-file obstacle. Recovery applies the same
      // transaction; never call import again to "retry" this uncertain result.
      await rm(config.history);
      await rename(config.keptHistory, config.history);
      const recovered = await new Store(f.root).get(f.target.id);
      assert.equal(recovered.revision, journal.revision);
      assert.equal(recovered.configRevision, journal.configRevision);
      assert.equal(recovered.requests.length, before.requests.length + 1);
      assert.deepEqual(
        recovered.requests.find((request) => request.id === "keep-existing"),
        before.requests[0],
      );
      assert.deepEqual(
        recovered.requests.find((request) => request.id === imported[0].id),
        imported[0],
      );
      assert.deepEqual(recovered.history, before.history);
      assert.deepEqual(recovered.runs, before.runs);
      assert(
        recovered.environments.every(
          (env) => env.variables.mustNotExecute === undefined,
        ),
      );
      await assert.rejects(readFile(journalFile), { code: "ENOENT" });
      await f.restart();
      const exported = decode(
        await f.call("export_project", {
          projectId: f.target.id,
          format: "apipost",
        }),
      );
      assert.equal(
        exported.document.apis.filter((api) => api.name === marker).length,
        1,
      );
      assert.deepEqual(await new Store(f.root).get(f.target.id), recovered);
      assert.deepEqual(await f.store.get(f.other.id), otherBefore);
      assert.deepEqual(
        JSON.parse(await readFile(config.observation, "utf8")),
        observed,
      );
      assert.deepEqual(f.wire, []);
      assert(!f.stderr.join("").includes("fictional-import-secret"));
    },
  );

// SDK Client assigns numeric IDs. This deliberate boundary request instead uses
// its public stdio transport.send/onmessage to send a real frame with a legal
// 256-byte string ID; it is not described as Client.callTool's default ID path.
async function sendWithStringId(transport, message) {
  const original = transport.onmessage;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Error("bounded export reply missing")),
        10000,
      );
      transport.onmessage = (reply) => {
        if (reply.id === message.id) resolve(reply);
        else original?.(reply);
      };
      transport.send(message).catch(reject);
    });
  } finally {
    clearTimeout(timer);
    transport.onmessage = original;
  }
}

test(
  "real SDK stdio rejects the doubled-JSON 8 MiB export frame and remains usable without changing projects",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, "stdio");
    await f.connect();
    const exportArgs = { projectId: f.target.id, format: "apipost" };
    const baseline = decode(await f.call("export_project", exportArgs));
    const native = structuredClone(baseline.document);
    native.intro = "\\".repeat(
      Math.floor(
        (documentBytes - Buffer.byteLength(JSON.stringify(native))) / 2,
      ),
    );
    const bytes = Buffer.byteLength(JSON.stringify(native));
    assert(bytes <= documentBytes && bytes >= documentBytes - 1);
    const project = await f.store.get(f.target.id);
    project.description = native.intro;
    await f.store.save(project);
    const before = await f.store.get(f.target.id),
      otherBefore = await f.store.get(f.other.id);
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...baseline, document: native }),
        },
      ],
    };
    const requestId = "\0".repeat(256);
    assert.equal(Buffer.byteLength(requestId), 256);
    const size = (id) =>
      Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result })) + 1;
    assert(
      size(1) <= frameBytes,
      "the document must not already overflow with an ordinary ID",
    );
    assert(
      size(requestId) > frameBytes,
      "both escaping layers and the legal ID must exceed the actual frame budget",
    );
    const reply = await sendWithStringId(f.transport, {
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name: "localapi_export_project", arguments: exportArgs },
    });
    assert.equal(reply.id, requestId);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /完整帧.*8MiB/);
    assert(Buffer.byteLength(JSON.stringify(reply)) < 4096);
    await f.client.ping();
    assert.deepEqual(await f.store.get(f.target.id), before);
    assert.deepEqual(await f.store.get(f.other.id), otherBefore);
    const otherExport = decode(
      await f.call("export_project", {
        projectId: f.other.id,
        format: "apipost",
      }),
    );
    assert.equal(otherExport.projectId, f.other.id);
    // The same document is legal with the SDK's ordinary numeric ID. This checks
    // a real near-limit reply and proves the prior rejection did not kill stdout.
    const accepted = decode(await f.call("export_project", exportArgs));
    assert.deepEqual(accepted.document, native);
    await f.client.ping();
    assert.deepEqual(await new Store(f.root).get(f.target.id), before);
    assert.deepEqual(await new Store(f.root).get(f.other.id), otherBefore);
    assert.deepEqual(f.wire, []);
  },
);
