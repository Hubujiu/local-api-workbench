// CI-only root intersections. Real owned loopback resource verifier; no OAuth
// provider, acquisition, external credentials, vendor runtime, or local execution.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import {
  importDocument,
  normalizeRequest,
  snapshotPlan,
  restoreProject,
  exportOpenAPI,
} from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";

const raw =
  "access_token=old&flag&%61ccess_token=encoded&ACCESS_TOKEN=upper&access_token&dup=1&dup=2";
const clean = "flag&%61ccess_token=encoded&ACCESS_TOKEN=upper&dup=1&dup=2";
const token = "owned-fake-token";
const marked = (fields = {}) => ({
  type: "oauth2",
  postmanOAuth2: { version: 1, accessToken: token, ...fields },
});
const oauth = (fields) => ({
  type: "oauth2",
  oauth2: Object.entries(fields).map(([key, value]) => ({
    key,
    value,
    type: "string",
  })),
});
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function bytes(directory) {
  const result = {};
  async function visit(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await visit(path.join(dir, entry.name), name + "/");
      else
        result[name] = (await readFile(path.join(dir, entry.name))).toString(
          "base64",
        );
    }
  }
  await visit(directory);
  return result;
}
function inertMetadata(base) {
  return {
    callBackUrl: "not a URL {{unusedCallback}}",
    authUrl: base + "/must-not-acquire",
    accessTokenUrl: base + "/must-not-acquire-token",
    clientId: "{{unusedClient}}",
    clientSecret: "{{unusedSecret}}",
    scope: "{{$randomUUID}}",
    requestAccessTokenLocally: "1.0",
  };
}
function document(base) {
  return {
    info: { name: "Scoped saved OAuth2" },
    variable: [{ key: "savedToken", value: token }],
    auth: oauth({ ...inertMetadata(base), accessToken: "{{savedToken}}" }),
    item: [
      {
        name: "outer",
        item: [
          {
            name: "inner",
            item: [
              {
                name: "header",
                request: {
                  method: "GET",
                  url: base + "/postman-default?" + raw,
                },
              },
            ],
          },
          {
            name: "query-folder",
            auth: oauth({
              ...inertMetadata(base),
              accessToken: "{{savedToken}}",
              addTokenTo: "queryParams",
              headerPrefix: "{{unusedPrefix}}",
            }),
            item: [
              {
                name: "query",
                request: {
                  method: "GET",
                  url: base + "/postman-query?" + raw,
                  header: [{ key: "Authorization", value: "Caller unchanged" }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
const expected = {
  "/postman-default": [clean, "Bearer " + token],
  "/postman-query": [clean + "&access_token=" + token, undefined],
  "/postman-bare": [clean, token],
  "/native-query": [raw + "&access_token=" + token, "Caller unchanged"],
  "/native-inert": [raw, "Caller unchanged"],
  "/native-empty-prefix": [raw, "Bearer " + token],
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "postman-oauth2-root-"));
  const seen = [],
    errors = [],
    clients = [];
  const peer = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    try {
      const at = req.url.indexOf("?"),
        name = req.url.slice(0, at);
      assert(
        Object.hasOwn(expected, name),
        "only resource endpoints are permitted; no token/grant route",
      );
      assert.equal(req.method, "GET");
      assert.equal(req.url.slice(at + 1), expected[name][0]);
      assert.equal(req.headers.authorization, expected[name][1]);
      res.setHeader("content-type", "application/json");
      res.end('{"authorized":true}');
    } catch (error) {
      errors.push(error.message);
      res.statusCode = 401;
      res.end("independent token verifier rejected wire request");
    }
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    for (const client of clients.splice(0))
      await client.close().catch(() => {});
    app.server.closeAllConnections();
    await app.close();
  };
  t.after(async () => {
    await stop();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const owner = async (route, method = "GET", body, status = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  return {
    root,
    seen,
    errors,
    owner,
    base: "http://127.0.0.1:" + peer.address().port,
    get store() {
      return app.store;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    async connect(projectId, mode, execute = true) {
      const client = new Client(
        { name: "postman-oauth2-root", version: "1" },
        { capabilities: {} },
      );
      clients.push(client);
      let transport;
      if (mode === "http") {
        const config = await owner("/api/mcp/config", "POST", {
          enabled: true,
          projects: [projectId],
          write: execute,
          execute,
          remember: false,
        });
        transport = new StreamableHTTPClientTransport(
          new URL(app.url + "/mcp"),
          {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          },
        );
      } else {
        transport = new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            projectId,
            ...(execute ? ["--write", "--execute"] : []),
          ],
          env: { LOCAL_API_DATA: root },
          stderr: "pipe",
        });
        transport.stderr.resume();
      }
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert(
        !names.some((name) => /oauth/i.test(name)),
        "saved-token support does not grant OAuth acquisition",
      );
      assert.equal(names.includes("localapi_execute_flow"), execute);
      return (name, args = {}) =>
        client.callTool({
          name: "localapi_" + name,
          arguments: { projectId, ...args },
        });
    },
  };
}
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
    const timer = setTimeout(() => {
      failure = Error("Postman OAuth2 CLI fixture timed out");
      child.kill();
    }, 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
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
function checkRun(run) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.equal(run.recordId, run.id);
  assert.equal(run.results.length, 2);
  assert(run.results.every((result) => result.response.status === 200));
}

test(
  "Postman collection opt-in + inherited saved tokens freeze through HTTP/stdio SDK, CLI, backup/restart and project grants",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      project = await f.store.create("Scoped Postman OAuth2"),
      foreign = await f.store.create("Foreign grant denied");
    const foreignBytes = await bytes(f.store.directory(foreign.id));
    const donor = document(f.base),
      donorBefore = structuredClone(donor);
    await f.owner(`/api/projects/${project.id}/import`, "POST", {
      document: donor,
      postmanVariableMode: "collection",
    });
    const imported = await f.store.get(project.id);
    assert.deepEqual(donor, donorBefore);
    assert.equal(imported.postmanCollections.items.length, 1);
    const collectionId = imported.postmanCollections.items[0].id;
    assert(
      imported.requests.every(
        (request) => request.postmanCollectionId === collectionId,
      ),
    );
    assert.deepEqual(
      imported.requests.map((request) => request.folder),
      ["outer/inner", "outer/query-folder"],
    );
    assert.equal(
      imported.requests[0].auth.postmanOAuth2.accessToken,
      "{{savedToken}}",
    );
    assert.equal(
      imported.requests[1].auth.postmanOAuth2.addTokenTo,
      "queryParams",
    );
    const plan = await f.owner(`/api/projects/${project.id}/plans`, "POST", {
      name: "Frozen inherited token policy",
      statusPolicy: "strict200",
      environmentId: imported.environments[0].id,
      steps: imported.requests.map((request) => ({ request })),
    });
    const changed = await f.store.get(project.id);
    for (const request of changed.requests) {
      request.url = f.base + "/live-must-not-send";
      request.auth.postmanOAuth2.accessToken = "live-token-must-not-send";
    }
    await f.owner(`/api/projects/${project.id}`, "PUT", changed);
    const snapshots = [];
    for (const mode of ["http", "stdio"]) {
      const call = await f.connect(project.id, mode);
      assert.equal(
        (await call("execute_flow", { projectId: foreign.id, planId: plan.id }))
          .isError,
        true,
      );
      assert.equal((await call("oauth_token", {})).isError, true);
      const run = decode(await call("execute_flow", { planId: plan.id }));
      checkRun(run);
      snapshots.push(run.snapshot);
      const detail = decode(
        await call("get_execution_result", { runId: run.id }),
      );
      assert.deepEqual(detail.snapshot, run.snapshot);
      assert.equal(detail.planHash, run.planHash);
    }
    assert.deepEqual(snapshots[0], snapshots[1]);
    const command = await cli(f.root, project.id, plan.id);
    assert.equal(command.code, 0, command.stderr);
    assert.equal(command.signal, null);
    const commandRun = JSON.parse(command.stdout);
    checkRun(commandRun);
    assert.deepEqual(commandRun.snapshot, snapshots[0]);
    assert.equal(f.seen.length, 6);
    const backup = await f.owner(`/api/projects/${project.id}/export`);
    assert.equal(backup.runs.length, 3);
    assert.deepEqual(backup.plans[0].steps, plan.steps);
    assert.deepEqual(backup.postmanCollections, imported.postmanCollections);
    const sourceBytes = await bytes(f.store.directory(project.id));
    const restored = await f.owner(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    assert.notEqual(restored.id, project.id);
    await f.restart();
    const recovered = await new Store(f.root).get(restored.id);
    assert.deepEqual(recovered.runs, backup.runs);
    assert.deepEqual(recovered.plans, backup.plans);
    for (const request of [
      ...recovered.requests,
      ...recovered.plans[0].steps.map((step) => step.request),
    ])
      for (const [key, value] of Object.entries(inertMetadata(f.base)))
        assert.equal(request.auth.postmanOAuth2[key], value);
    assert.equal(
      f.seen.length,
      6,
      "restore/restart never acquire tokens or replay resources",
    );
    const read = await f.connect(restored.id, "http", false);
    assert.equal(
      (await read("execute_flow", { planId: plan.id })).isError,
      true,
    );
    assert.equal(
      (
        await read("get_execution_flow", {
          projectId: project.id,
          planId: plan.id,
        })
      ).isError,
      true,
    );
    assert.equal(f.seen.length, 6);
    const replay = await cli(f.root, restored.id, plan.id);
    assert.equal(replay.code, 0, replay.stderr);
    checkRun(JSON.parse(replay.stdout));
    assert.equal((await new Store(f.root).get(restored.id)).runs.length, 4);
    assert.equal(f.seen.length, 8);
    assert.deepEqual(await bytes(f.store.directory(project.id)), sourceBytes);
    assert.deepEqual(await bytes(f.store.directory(foreign.id)), foreignBytes);
  },
);

test(
  "root native and Postman OAuth2 remain distinct on real wire, and unrepresentable exports/redirects are inert",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      project = await f.store.create("Distinct saved-token dialects");
    const imported = importDocument(document(f.base));
    const definitions = [
      ["postman-default", marked()],
      ["postman-query", marked({ addTokenTo: "queryParams" })],
      ["postman-bare", marked({ headerPrefix: "" })],
      [
        "native-query",
        {
          type: "oauth2",
          nativeOAuth2: { access_token: token, addTokenTo: "queryParams" },
        },
      ],
      [
        "native-inert",
        { type: "oauth2", nativeOAuth2: { access_token: token } },
      ],
      [
        "native-empty-prefix",
        {
          type: "oauth2",
          nativeOAuth2: {
            access_token: token,
            addTokenTo: "header",
            headerPrefix: "",
          },
        },
      ],
    ];
    project.requests = definitions.map(([name, auth]) =>
      normalizeRequest({
        name,
        method: "GET",
        url: f.base + "/" + name + "?" + raw,
        headers: [{ key: "Authorization", value: "Caller unchanged" }],
        auth,
      }),
    );
    await f.store.save(project);
    for (const request of project.requests)
      assert.equal(
        (await executeRequest(request)).status,
        200,
        JSON.stringify(f.errors),
      );
    assert.equal(f.seen.length, 6);
    // Keep all six collision-heavy wire probes above unchanged. Export and
    // redirect admission use independent plain URLs so existing URL-query
    // fidelity guards cannot mask rejection of the Postman marker itself.
    project.requests = project.requests.slice(0, 3).map((request) =>
      normalizeRequest({
        id: request.id,
        name: request.name,
        method: "GET",
        url: f.base + "/export-" + request.name,
        headers: [],
        auth: structuredClone(request.auth),
      }),
    );
    await f.store.save(project);
    // No collection marker: these export failures must be about OAuth2 policy,
    // not accidentally masked by the independent collection-scope export guard.
    assert.equal(project.postmanCollections, undefined);
    const before = structuredClone(project),
      diskBefore = await bytes(f.store.directory(project.id)),
      control = structuredClone(project);
    for (const request of control.requests) request.auth = { type: "none" };
    const controlBefore = structuredClone(control);
    for (const exporter of [
      exportApipost,
      exportApipostDirectory,
      exportOpenAPI,
    ]) {
      assert.doesNotThrow(() => exporter(control));
      assert.deepEqual(control, controlBefore);
      assert.throws(() => exporter(project), /Postman OAuth2/);
      assert.deepEqual(project, before);
    }
    for (const format of ["apipost", "apipost-directory", "openapi"]) {
      const rejected = await f.owner(
        `/api/projects/${project.id}/export?format=${format}`,
        "GET",
        undefined,
        400,
      );
      assert.match(JSON.stringify(rejected), /Postman OAuth2/);
    }
    for (const mode of ["http", "stdio"]) {
      const call = await f.connect(project.id, mode, false);
      // MCP project interchange deliberately exposes only native formats.
      for (const format of ["apipost", "apipost-directory"]) {
        const rejected = await call("export_project", { format });
        assert.equal(rejected.isError, true);
        assert.match(rejected.content[0].text, /Postman OAuth2/);
      }
    }
    for (const request of project.requests.slice(0, 3)) {
      const redirect = {
        ...request,
        redirect: { mode: "same-origin", maxHops: 2 },
      };
      await assert.rejects(executeRequest(redirect), /redirect/);
    }
    assert.equal(
      f.seen.length,
      6,
      "redirect admission fails before first HTTP hop",
    );
    assert.deepEqual(await bytes(f.store.directory(project.id)), diskBefore);
    assert.deepEqual(project, before);
    assert(
      imported.every((request) => request.auth.postmanOAuth2),
      "legacy import still preserves the policy without collection opt-in",
    );
  },
);

test(
  "root invalid markers and accessor-bearing disabled frozen leaves reject before cloning or saving",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      project = await f.store.create("Preflight atomicity"),
      before = await bytes(f.store.directory(project.id));
    for (const auth of [
      { ...marked(), nativeOAuth2: { access_token: token } },
      { ...marked(), type: "bearer" },
      { ...marked(), token: "mixed-legacy" },
    ]) {
      const request = {
        id: "invalid",
        name: "invalid",
        method: "GET",
        url: f.base + "/must-not-send",
        auth,
      };
      const plan = {
        id: "disabled",
        name: "Disabled invalid",
        steps: [
          {
            type: "repeat",
            id: "repeat",
            count: 1,
            enabled: false,
            steps: [{ id: "leaf", enabled: false, request }],
          },
        ],
      };
      assert.throws(() => snapshotPlan(plan), /Postman OAuth2/);
      const candidate = { ...structuredClone(project), plans: [plan] };
      await assert.rejects(f.store.save(candidate), /Postman OAuth2/);
      assert.throws(() => restoreProject(candidate), /Postman OAuth2/);
      await f.owner(`/api/projects/${project.id}`, "PUT", candidate, 400);
      assert.deepEqual(await bytes(f.store.directory(project.id)), before);
    }
    let reads = 0;
    const request = {
      id: "getter",
      method: "GET",
      url: f.base + "/must-not-send",
    };
    Object.defineProperty(request, "auth", {
      enumerable: true,
      get() {
        reads++;
        return marked();
      },
    });
    const plan = {
      id: "getter-plan",
      steps: [
        {
          type: "repeat",
          id: "outer",
          count: 1,
          enabled: false,
          steps: [{ id: "leaf", enabled: false, request }],
        },
      ],
    };
    assert.throws(() => snapshotPlan(plan), /Postman OAuth2/);
    await assert.rejects(
      f.store.save({ ...project, plans: [plan] }),
      /Postman OAuth2/,
    );
    assert.throws(
      () => restoreProject({ ...project, plans: [plan] }),
      /Postman OAuth2/,
    );
    assert.equal(
      reads,
      0,
      "preflight must inspect descriptors, not execute getters before cloning",
    );
    assert.deepEqual(await bytes(f.store.directory(project.id)), before);
    assert.equal(f.seen.length, 0);
  },
);
