// Independent real-owner/official-SDK composition. Fictional definitions only;
// loopback peers detect accidental HTTP/database execution and never serve data.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, normalizeRequest } from "../src/core.mjs";
import { projectFingerprint } from "../src/project-files.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";
import { nativeSampleExportFixture } from "./fixtures/apipost-sample-export.mjs";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";

const formats = ["apipost", "apipost-directory"];
const rawMarker = { version: 1, language: "xml" };
const privateRaw = '<retained value="never export">雪</retained>\r\n';
const privateToken = "fictional-composition-native-token";
const select = (format, kind, id) => ({
  format,
  modelNameMode: "preserve",
  databaseMode: "rebind",
  selection: { mode: "explicit", resources: [{ kind, id }] },
});
const acceptance = (input, preview) => ({
  ...input,
  configRevision: preview.configRevision,
  scopeDigest: preview.scope.digest,
  acceptedDependencies: preview.scope.dependencies,
});
async function bytes(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await bytes(file)
      : (await readFile(file)).toString("base64");
  }
  return result;
}
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const call = (client, projectId, name, input) =>
  client.callTool({
    name: "localapi_" + name,
    arguments: { projectId, ...input },
  });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "scoped-import-composition-"));
  let httpEffects = 0,
    databaseEffects = 0;
  const wire = http.createServer((_req, res) => {
    httpEffects++;
    res.end("unexpected execution");
  });
  const database = net.createServer((socket) => {
    databaseEffects++;
    socket.destroy();
  });
  await Promise.all([
    new Promise((resolve) => wire.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => database.listen(0, "127.0.0.1", resolve)),
  ]);
  const origin = `http://127.0.0.1:${wire.address().port}`;
  let app = await createApp({ root, port: 0 });
  const clients = [],
    cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const client of clients) await client.close().catch(() => {});
    await app.close();
    wire.closeAllConnections();
    await Promise.all(
      [wire, database].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    await rm(root, { recursive: true, force: true });
  });
  async function owner(route, input, status = 200) {
    const response = await fetch(app.url + "/api" + route, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  let source = await app.store.create("Composition source");
  importIntoProject(source, nativeSampleExportFixture(origin));
  const sourceAPI = source.requests.find((item) =>
    item.url.endsWith("/api-two"),
  );
  sourceAPI.name = "Selected live API";
  sourceAPI.folder = "Parent/Selected";
  for (const sample of source.cases.filter(
    (item) => item.sourceRequestId === sourceAPI.id,
  ))
    sample.request.folder = sourceAPI.folder;
  sourceAPI.auth = {
    type: "basic",
    username: "fixture",
    password: "source-private-basic",
  };
  sourceAPI.schema = { $ref: "#/components/schemas/A" };
  sourceAPI.inheritSharedScripts = false;
  sourceAPI.scriptDialect = "apipost8";
  sourceAPI.nativeTasks = {
    version: 1,
    before: [
      {
        id: "inert-wait",
        name: "Stored wait",
        type: "wait",
        enabled: 1,
        data: 1,
      },
      {
        id: "never-run-script",
        name: "Inert definition",
        type: "customScript",
        enabled: 1,
        data: 'apt.globals.set("scriptHits", "1"); throw Error("definition operation executed script");',
      },
    ],
    after: [],
  };
  const databaseDocument = nativeDatabaseFixture(origin + "/inert-database");
  databaseDocument.global.db_link[0].config.default.db_config.host =
    "127.0.0.1";
  databaseDocument.global.db_link[0].config.default.db_config.port =
    database.address().port;
  const staging = {
    id: "database-staging",
    name: "Database staging",
    requests: [],
    environments: [],
    settings: {},
  };
  importIntoProject(staging, databaseDocument);
  source.settings.apipostDatabases = staging.settings.apipostDatabases;
  sourceAPI.nativeTasks.before.splice(
    1,
    0,
    staging.requests[0].nativeTasks.before.find(
      (task) => task.type === "database",
    ),
  );
  source.folders = ["Parent", "Parent/Selected", "Unselected"];
  source.requests.push(
    normalizeRequest({
      id: "unselected-source",
      name: "Unselected source API",
      folder: "Unselected",
      url: origin + "/unselected-source",
    }),
  );
  source.globalVariables.scriptHits = "0";
  const a = {
    type: "object",
    properties: { next: { $ref: "#/components/schemas/B" } },
    example: {
      $ref: "https://literal.invalid/not-a-dependency",
      value: "literal",
    },
  };
  const b = {
    type: "object",
    properties: { parent: { $ref: "#/components/schemas/A" } },
  };
  source.dictionary = [
    { id: "A", name: "A", folderId: "models", schema: a },
    { id: "B", name: "B", schema: b },
    { id: "unused", name: "Unused model", schema: { type: "string" } },
  ];
  source.modelFolders = [{ id: "models", name: "Selected models" }];
  source.openapiComponents = {
    schemas: { A: a, B: b, unused: { type: "string" } },
  };
  source = await app.store.save(source);
  const sample = source.cases.find((item) => item.name === "grouped");
  assert.notEqual(sample.sourceRequestId, sourceAPI.id);

  let target = await app.store.create("Composition target");
  target.folders = ["Existing", "Retained"];
  target.currentEnvironmentId = target.environments[0].id;
  target.requests = [
    normalizeRequest({
      id: "overwrite-target",
      name: "Previous live definition",
      method: sourceAPI.method,
      url: sourceAPI.url,
      folder: "Existing",
    }),
    normalizeRequest({
      id: "retained-raw",
      name: "Retained XML previous",
      method: "POST",
      url: origin + "/retained-raw",
      folder: "Retained",
      bodyType: "raw",
      body: privateRaw,
      postmanRawBody: rawMarker,
      beforeScript: 'throw Error("retained raw script must not execute");',
    }),
    normalizeRequest({
      id: "retained-native-auth",
      name: "Retained native OAuth2",
      url: origin + "/retained-oauth",
      folder: "Retained",
      auth: {
        type: "oauth2",
        nativeOAuth2: {
          addTokenTo: "header",
          headerPrefix: "Native",
          access_token: privateToken,
          grant_type: "client_credentials",
          authUrl: origin + "/must-not-authorize",
          accessTokenUrl: origin + "/must-not-acquire",
          refreshTokenUrl: origin + "/must-not-refresh",
          clientId: "fictional-client",
          clientSecret: "fictional-private-secret",
          client_authentication: "body",
          authRequestParams: [],
          tokenRequestParams: [],
          refreshRequestParams: [],
        },
      },
    }),
  ];
  target = await app.store.save(target);
  target.requests.find((item) => item.id === "retained-raw").name =
    "Retained XML current";
  target = await app.store.save(target);
  const route = "/projects/" + target.id;
  await owner(route + "/cases", {
    name: "Frozen unselected XML",
    sourceRequestId: "retained-raw",
    request: target.requests.find((item) => item.id === "retained-raw"),
  });
  await owner(route + "/plans", {
    name: "Frozen unselected raw and auth",
    environmentId: target.environments[0].id,
    steps: target.requests
      .filter((item) => item.id !== "overwrite-target")
      .map((request, index) => ({ id: "frozen-" + index, request })),
  });
  target = await app.store.get(target.id);
  const peer = await app.store.create("Never granted peer");
  return {
    root,
    source,
    sourceAPI: source.requests.find((item) => item.id === sourceAPI.id),
    sample,
    target,
    peer,
    owner,
    get app() {
      return app;
    },
    beforeClose(cleanup) {
      cleanups.push(cleanup);
    },
    async restart() {
      await app.close();
      app = await createApp({ root, port: 0 });
    },
    post: (project, action, input, status) =>
      owner("/projects/" + project.id + "/" + action, input, status),
    read: (id) => new Store(root).get(id),
    async connect(kind, write = true) {
      const client = new Client({
        name: "scoped-import-composition-sdk",
        version: "1",
      });
      clients.push(client);
      let transport;
      if (kind === "HTTP") {
        const config = await owner("/mcp/config", {
          enabled: true,
          remember: false,
          projects: [target.id],
          write,
          execute: false,
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
            target.id,
            ...(write ? ["--write"] : []),
          ],
          env: {
            LOCAL_API_DATA: root,
            ...(process.platform === "win32"
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
          },
          stderr: "pipe",
        });
      }
      await client.connect(transport);
      return { client, transport };
    },
    assertNoEffects() {
      assert.equal(
        httpEffects,
        0,
        "definition operations must not send requests or acquire tokens",
      );
      assert.equal(
        databaseEffects,
        0,
        "definition operations must not connect to databases",
      );
    },
  };
}

function assertMetadataPrivate(value) {
  const text = JSON.stringify(value);
  for (const secret of [
    privateRaw,
    privateToken,
    "source-private-basic",
    "fictional-private-secret",
    "apt.globals.set",
    "retained raw script",
  ])
    assert.equal(
      text.includes(JSON.stringify(secret).slice(1, -1)),
      false,
      "metadata leaked stored definition",
    );
}
function assertRetained(actual, before) {
  for (const id of ["retained-raw", "retained-native-auth"])
    assert.deepEqual(
      actual.requests.find((item) => item.id === id),
      before.requests.find((item) => item.id === id),
    );
  assert.deepEqual(actual.plans, before.plans);
  for (const item of before.cases)
    assert.deepEqual(
      actual.cases.find((saved) => saved.id === item.id),
      item,
    );
  for (const entry of before.requestDefinitionHistory.entries.filter(
    (item) => item.requestId !== "overwrite-target",
  ))
    assert.deepEqual(
      actual.requestDefinitionHistory.entries.find(
        (item) => item.requestId === entry.requestId,
      ),
      entry,
    );
  for (const field of ["history", "runs", "protocolRuns", "trash"])
    assert.deepEqual(actual[field], before[field], field);
  assert.deepEqual(
    actual.environments.find((env) => env.id === before.environments[0].id),
    before.environments[0],
  );
  assert.equal(typeof before.currentEnvironmentId, "string");
  assert.ok(before.currentEnvironmentId.length > 0);
  assert.equal(actual.currentEnvironmentId, before.currentEnvironmentId);
}
function assertSelectedSemantics(project, source, sample, apiId) {
  const request = project.requests.find((item) => item.id === apiId);
  assert.ok(request);
  for (const key of [
    "name",
    "url",
    "method",
    "folder",
    "auth",
    "bodyType",
    "body",
    "headers",
    "inheritSharedScripts",
    "scriptDialect",
  ])
    assert.deepEqual(request[key], source[key], key);
  const taskSemantics = (tasks) =>
    tasks.map(({ id, ...task }) =>
      task.type === "database"
        ? {
            ...task,
            data: {
              ...task.data,
              connectionId: "rebound",
              variables: task.data.variables.map(
                ({ param_id, ...variable }) => variable,
              ),
            },
          }
        : task,
    );
  assert.deepEqual(
    taskSemantics(request.nativeTasks.before),
    taskSemantics(source.nativeTasks.before),
  );
  const dbTask = request.nativeTasks.before.find(
    (task) => task.type === "database",
  );
  const database = project.settings.apipostDatabases.find(
    (item) => item.id === dbTask.data.connectionId,
  );
  assert.equal(database.name, "Fixture database");
  assert.equal(database.type, "postgres");
  assert.deepEqual(Object.keys(database).sort(), [
    "id",
    "name",
    "sort",
    "sourceId",
    "sourceProjectId",
    "type",
  ]);
  const modelA = project.dictionary.find((item) => item.name === "A"),
    modelB = project.dictionary.find((item) => item.name === "B");
  assert.ok(modelA && modelB);
  assert.equal(request.schema.$ref, "#/components/schemas/" + modelA.id);
  assert.equal(
    modelA.schema.properties.next.$ref,
    "#/components/schemas/" + modelB.id,
  );
  assert.equal(
    modelB.schema.properties.parent.$ref,
    "#/components/schemas/" + modelA.id,
  );
  assert.deepEqual(modelA.schema.example, {
    $ref: "https://literal.invalid/not-a-dependency",
    value: "literal",
  });
  assert.equal(
    project.modelFolders.find((item) => item.id === modelA.folderId)?.name,
    "Selected models",
  );
  assert.equal(
    project.dictionary.some((item) => item.name === "Unused model"),
    false,
  );
  const importedSample = project.cases.find(
    (item) => item.name === sample.name,
  );
  assert.ok(importedSample);
  const sampleOwner = project.requests.find((item) =>
    item.url.endsWith("/api-one"),
  );
  assert.ok(sampleOwner);
  assert.equal(importedSample.sourceRequestId, sampleOwner.id);
  assert.notEqual(importedSample.sourceRequestId, apiId);
  assert.notEqual(importedSample.id, sample.id);
  for (const key of [
    "url",
    "method",
    "body",
    "bodyType",
    "description",
    "headers",
    "auth",
    "name",
    "folder",
    "serviceSnapshot",
    "parametersSnapshot",
    "authSnapshot",
    "sharedScriptsSnapshot",
  ])
    assert.deepEqual(
      importedSample.request[key],
      sample.request[key],
      "sample " + key,
    );
  assert.equal(
    project.caseFolders.find((item) => item.id === importedSample.folderId)
      ?.name,
    "Group",
  );
  const sampleGroup = project.caseFolders.find(
    (item) => item.id === importedSample.folderId,
  );
  assert.equal(sampleGroup.sourceRequestId, sampleOwner.id);
  assert.equal(sampleGroup.parentId || "", "");
  assert.equal(project.globalVariables.scriptHits, "0");
  assert.equal(project.dictionary.length, 2);
  assert.equal(project.modelFolders.length, 1);
  assert.equal(project.caseFolders.length, 1);
  return importedSample;
}
async function sourceArtifact(f, format) {
  const input = select(format, "case", f.sample.id);
  input.selection.resources.push({ kind: "api", id: f.sourceAPI.id });
  const preview = await f.post(f.source, "export-preview", input);
  for (const [kind, id] of [
    ["api", f.sample.sourceRequestId],
    ["model", "A"],
    ["model", "B"],
    ["folder", "Parent"],
    ["folder", "Parent/Selected"],
    ["model-folder", "models"],
  ])
    assert.ok(
      preview.scope.dependencies.some(
        (item) => item.kind === kind && item.id === id,
      ),
      kind + ":" + id,
    );
  assert.equal(
    preview.scope.included.some((item) => item.id === "unused"),
    false,
  );
  assertMetadataPrivate(preview);
  const exported = await f.post(
    f.source,
    "export-selection",
    acceptance(input, preview),
  );
  for (const secret of [
    "discard-this-fictional-password",
    "private-host.invalid",
    "synthetic-user",
    "synthetic-db",
  ])
    assert.equal(
      JSON.stringify(exported.document).includes(secret),
      false,
      "database export is credential-free rebind only",
    );
  return {
    format,
    document: exported.document,
    selection: { mode: "all" },
    policies: { api: "url" },
    options: { modelNameMode: "preserve" },
  };
}

for (const format of formats)
  test(
    `owner ${format} scoped sample/model export composes two-step URL overwrite, reopen and selected re-export without loss`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      const sourceBytes = await bytes(f.app.store.directory(f.source.id)),
        peerBytes = await bytes(f.app.store.directory(f.peer.id));
      const input = await sourceArtifact(f, format);
      const before = await f.read(f.target.id),
        beforeBytes = await bytes(f.root),
        fingerprint = projectFingerprint(before);
      const preview = await f.post(f.target, "import-preview", input);
      assert.deepEqual(preview.blockers, []);
      assert.equal(typeof preview.token, "string");
      assertMetadataPrivate(preview);
      const plannedAPI = preview.items.filter((item) => item.kind === "api");
      assert.equal(plannedAPI.length, 2);
      assert.equal(
        plannedAPI.find((item) => item.targetId === "overwrite-target").action,
        "update",
      );
      assert.equal(
        plannedAPI.filter((item) => item.action === "create").length,
        1,
      );
      const oldScope = select(format, "api", "overwrite-target");
      const oldPreview = await f.post(f.target, "export-preview", oldScope);
      const oldAcceptance = acceptance(oldScope, oldPreview);
      await f.post(f.target, "export-selection", oldAcceptance);
      for (const unsupported of formats) {
        const refused = await f.post(
          f.target,
          "export-preview",
          select(unsupported, "api", "retained-raw"),
          400,
        );
        assertMetadataPrivate(refused);
        assert.equal(Object.hasOwn(refused, "document"), false);
      }
      assert.equal(projectFingerprint(await f.read(f.target.id)), fingerprint);
      assert.deepEqual(
        await bytes(f.root),
        beforeBytes,
        "all successful/refused previews and exports remain byte-inert",
      );
      const receipt = await f.post(f.target, "import-apply", {
        input,
        token: preview.token,
      });
      assert.equal(receipt.configRevision, before.configRevision + 1);
      assert.equal(receipt.noOp, false);
      assertMetadataPrivate(receipt);
      let saved = await f.read(f.target.id);
      assertRetained(saved, before);
      const selectedSample = assertSelectedSemantics(
        saved,
        f.sourceAPI,
        f.sample,
        "overwrite-target",
      );
      assert.deepEqual(
        saved.requests
          .filter((item) => before.requests.some((old) => old.id === item.id))
          .map((item) => item.id)
          .sort(),
        before.requests.map((item) => item.id).sort(),
      );
      assert.equal(saved.requests.length, before.requests.length + 1);
      assert.deepEqual(
        saved.cases.map((item) => item.id).sort(),
        [...before.cases.map((item) => item.id), selectedSample.id].sort(),
      );
      const prior = before.requests.find(
        (item) => item.id === "overwrite-target",
      );
      const entry = saved.requestDefinitionHistory.entries.find(
        (item) => item.requestId === prior.id,
      );
      assert.ok(
        entry.versions.some(
          (version) =>
            JSON.stringify(version.definition) === JSON.stringify(prior),
        ),
        "URL overwrite records exact prior identity and definition",
      );
      const committedBytes = await bytes(f.root);
      const stale = await f.post(
        f.target,
        "export-selection",
        oldAcceptance,
        400,
      );
      assertMetadataPrivate(stale);
      await f.post(
        f.target,
        "import-apply",
        { input, token: preview.token },
        400,
      );
      assert.deepEqual(await bytes(f.root), committedBytes);
      await f.restart();
      assert.deepEqual(await f.read(f.target.id), saved);
      const selected = select(format, "case", selectedSample.id);
      selected.selection.resources.push({
        kind: "api",
        id: "overwrite-target",
      });
      const targetPreview = await f.post(f.target, "export-preview", selected);
      const targetExport = await f.post(
        f.target,
        "export-selection",
        acceptance(selected, targetPreview),
      );
      const text = JSON.stringify(targetExport.document);
      for (const omitted of [
        privateToken,
        "Retained XML current",
        "Frozen unselected",
        "Unused model",
        "case-other",
        "case-root",
        "unselected-source",
      ])
        assert.equal(
          text.includes(omitted),
          false,
          "re-export leaks unselected " + omitted,
        );
      const copy = await f.app.store.create("Manual second-generation target");
      const copyInput = {
        format,
        document: targetExport.document,
        selection: { mode: "all" },
        options: { modelNameMode: "preserve" },
      };
      const copyPreview = await f.post(copy, "import-preview", copyInput);
      assert.deepEqual(copyPreview.blockers, []);
      await f.post(copy, "import-apply", {
        input: copyInput,
        token: copyPreview.token,
      });
      const reopenedCopy = await f.read(copy.id);
      assert.equal(reopenedCopy.requests.length, 2);
      assertSelectedSemantics(
        reopenedCopy,
        f.sourceAPI,
        selectedSample,
        reopenedCopy.requests.find((item) => item.url === f.sourceAPI.url).id,
      );
      assert.equal(reopenedCopy.cases.length, 1);
      assert.deepEqual(reopenedCopy.plans, []);
      assert.deepEqual(reopenedCopy.history, []);
      assert.deepEqual(reopenedCopy.runs, []);
      assert.deepEqual(await f.read(f.target.id), saved);
      assert.deepEqual(await f.read(f.source.id), f.source);
      assert.deepEqual(await f.read(f.peer.id), f.peer);
      assert.deepEqual(
        await bytes(f.app.store.directory(f.source.id)),
        sourceBytes,
      );
      assert.deepEqual(
        await bytes(f.app.store.directory(f.peer.id)),
        peerBytes,
      );
      f.assertNoEffects();
    },
  );

for (const kind of ["HTTP", "stdio"])
  test(
    `official ${kind} SDK manual preview, scoped export and apply retain session/grant boundaries`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      const input = await sourceArtifact(
        f,
        kind === "HTTP" ? "apipost" : "apipost-directory",
      );
      const first = await f.connect(kind),
        second = await f.connect(kind);
      const catalogue = (await first.client.listTools()).tools.map(
        (item) => item.name,
      );
      for (const tool of [
        "preview_import",
        "apply_import",
        "preview_project_export",
        "export_project_selection",
      ])
        assert.ok(catalogue.includes("localapi_" + tool));
      assert.equal(catalogue.includes("localapi_execute_api"), false);
      if (kind === "HTTP")
        assert.notEqual(first.transport.sessionId, second.transport.sessionId);
      const firstSession = first.transport.sessionId;
      const before = await f.read(f.target.id),
        beforeBytes = await bytes(f.app.store.directory(f.target.id)),
        fingerprint = projectFingerprint(before);
      const preview = decode(
        await call(first.client, f.target.id, "preview_import", { input }),
      );
      assert.deepEqual(preview.blockers, []);
      assertMetadataPrivate(preview);
      const scope = select(input.format, "api", "overwrite-target");
      const scoped = decode(
        await call(first.client, f.target.id, "preview_project_export", scope),
      );
      const approved = acceptance(scope, scoped);
      decode(
        await call(
          first.client,
          f.target.id,
          "export_project_selection",
          approved,
        ),
      );
      assert.equal(first.transport.sessionId, firstSession);
      for (const [client, projectId, args] of [
        [second.client, f.target.id, { input, token: preview.token }],
        [first.client, f.peer.id, { input, token: preview.token }],
        [
          first.client,
          f.target.id,
          {
            input: { ...input, policies: { api: "both" } },
            token: preview.token,
          },
        ],
      ])
        assert.equal(
          (await call(client, projectId, "apply_import", args)).isError,
          true,
        );
      for (const name of ["preview_project_export", "export_project_selection"])
        assert.equal(
          (
            await call(
              first.client,
              f.peer.id,
              name,
              name === "preview_project_export" ? scope : approved,
            )
          ).isError,
          true,
        );
      assert.equal(projectFingerprint(await f.read(f.target.id)), fingerprint);
      assert.deepEqual(
        await bytes(f.app.store.directory(f.target.id)),
        beforeBytes,
      );
      const applied = decode(
        await call(first.client, f.target.id, "apply_import", {
          input,
          token: preview.token,
        }),
      );
      assert.equal(applied.configRevision, before.configRevision + 1);
      assertMetadataPrivate(applied);
      const saved = await f.read(f.target.id);
      assertRetained(saved, before);
      assertSelectedSemantics(saved, f.sourceAPI, f.sample, "overwrite-target");
      assert.equal(
        (
          await call(
            first.client,
            f.target.id,
            "export_project_selection",
            approved,
          )
        ).isError,
        true,
      );
      assert.equal(
        (
          await call(first.client, f.target.id, "apply_import", {
            input,
            token: preview.token,
          })
        ).isError,
        true,
      );
      const reader = await f.connect(kind, false);
      const readerTools = (await reader.client.listTools()).tools.map(
        (item) => item.name,
      );
      assert.equal(readerTools.includes("localapi_apply_import"), false);
      assert.equal(readerTools.includes("localapi_execute_api"), false);
      const noOpInput = { ...input, selection: { mode: "explicit", keys: [] } };
      const noOp = decode(
        await call(reader.client, f.target.id, "preview_import", {
          input: noOpInput,
        }),
      );
      const readScope = decode(
        await call(reader.client, f.target.id, "preview_project_export", scope),
      );
      decode(
        await call(
          reader.client,
          f.target.id,
          "export_project_selection",
          acceptance(scope, readScope),
        ),
      );
      assert.equal(
        (
          await call(reader.client, f.target.id, "apply_import", {
            input: noOpInput,
            token: noOp.token,
          })
        ).isError,
        true,
        "export never upgrades read-only grant to writer",
      );
      assert.deepEqual(await f.read(f.target.id), saved);
      assert.deepEqual(await f.read(f.source.id), f.source);
      assert.deepEqual(await f.read(f.peer.id), f.peer);
      assert.deepEqual(await readMCPActivities(f.root), []);
      f.assertNoEffects();
    },
  );

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error("Composition writer-gate observation timed out");
}

test(
  "official HTTP scoped export cannot carry a manual-import grant past real journal-publication revocation",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      input = await sourceArtifact(f, "apipost"),
      { client } = await f.connect("HTTP");
    const before = await f.read(f.target.id),
      directory = f.app.store.directory(f.target.id),
      beforeBytes = await bytes(directory);
    const preview = decode(
      await call(client, f.target.id, "preview_import", { input }),
    );
    const scope = select("apipost", "api", "overwrite-target");
    const scoped = decode(
      await call(client, f.target.id, "preview_project_export", scope),
    );
    decode(
      await call(
        client,
        f.target.id,
        "export_project_selection",
        acceptance(scope, scoped),
      ),
    );
    const entered = deferred(),
      release = deferred();
    let signal,
      intercepted = false;
    const realApply = f.app.store.applyManualImport;
    t.mock.method(f.app.store, "applyManualImport", function (...args) {
      signal = args[2].signal;
      return Reflect.apply(realApply, this, args);
    });
    // The real journal temporary has reached disk; only publication is held.
    // Neither Store data nor the result of the real writer is substituted.
    const realWrite = fs.promises.writeFile;
    const gate = t.mock.method(
      fs.promises,
      "writeFile",
      async function (file, ...args) {
        const result = await Reflect.apply(realWrite, this, [file, ...args]);
        if (
          !intercepted &&
          typeof file === "string" &&
          path.dirname(file) === directory &&
          /^\.transaction\.json\.[a-f0-9-]{36}\.tmp$/i.test(path.basename(file))
        ) {
          intercepted = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      release.resolve();
      gate.mock.restore();
      syncBuiltinESMExports();
    });
    f.beforeClose(() => release.resolve());
    const applying = call(client, f.target.id, "apply_import", {
      input,
      token: preview.token,
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    await assert.rejects(readFile(path.join(directory, ".transaction.json")), {
      code: "ENOENT",
    });
    const revoked = f.owner("/mcp/config", {
      enabled: true,
      remember: false,
      projects: [f.target.id],
      write: false,
      execute: false,
    });
    await waitFor(() => signal?.aborted);
    release.resolve();
    const result = await applying;
    await revoked;
    assert.ok(result.error || result.value?.isError === true);
    assertMetadataPrivate(result.value ?? { error: result.error.message });
    assert.deepEqual(await bytes(directory), beforeBytes);
    assert.deepEqual(await f.read(f.target.id), before);
    assert.deepEqual(await f.read(f.source.id), f.source);
    assert.deepEqual(await f.read(f.peer.id), f.peer);
    assert.deepEqual(await readMCPActivities(f.root), []);
    f.assertNoEffects();
  },
);
