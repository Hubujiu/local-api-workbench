// Root composition only: real owner/Store, official SDK and independent wire
// verification. No vendor runtime, replacement dependency or mocked signer.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { verifyOAuth1Policy } from "./fixtures/oauth1-policy-oracle.mjs";
import { observeToolCall } from "./helpers/mcp-cancellation-observation.mjs";
import { storedJSON } from "./helpers/stored-json.mjs";

const MiB = 1024 * 1024;
const xml = '<history value="quote">雪 + &amp; =</history>\r\n';
const beforeScript =
  'pm.request.headers.upsert({key:"X-History-Script",value:"original-script"});';
const marker = { version: 1, language: "xml" };
const consumerSecret = "fictional-history-raw-consumer-secret";
const tokenSecret = "fictional-history-raw-token-secret";
// Expected policy is explicit, not derived from the importer or signer.
const expectedAuth = {
  type: "oauth1",
  consumerKey: "history-raw-consumer",
  consumerSecret,
  accessToken: "history/raw+token%",
  tokenSecret,
  signatureMethod: "HMAC-SHA1",
  nonce: "history-raw-fixed-nonce",
  timestamp: "1700000000",
  version: "1.0",
  realm: "history raw realm",
  parameterPolicy: {
    placement: "header",
    includeBodyHash: true,
    includeEmptyParams: true,
    headerEncoding: "percent",
  },
};
function collection(origin, body = xml) {
  return {
    info: {
      name: "Raw history integration",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: "Signed raw XML",
        event: [
          {
            listen: "prerequest",
            script: { type: "text/javascript", exec: [beforeScript] },
          },
        ],
        request: {
          method: "POST",
          url: origin + "/signed?dup=one&dup=two&text=a%2Bb",
          header: [],
          auth: {
            type: "oauth1",
            oauth1: Object.entries({
              consumerKey: "history-raw-consumer",
              consumerSecret,
              token: "history/raw+token%",
              tokenSecret,
              signatureMethod: "HMAC-SHA1",
              nonce: "history-raw-fixed-nonce",
              timestamp: "1700000000",
              version: "1.0",
              realm: "history raw realm",
              addParamsToHeader: true,
              includeBodyHash: true,
              addEmptyParamsToSign: true,
              disableHeaderEncoding: false,
            }).map(([key, value]) => ({ key, value, type: typeof value })),
          },
          body: {
            mode: "raw",
            raw: body,
            options: { raw: { language: "xml" } },
          },
        },
      },
    ],
  };
}
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function diskBytes(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const filename = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await diskBytes(filename)
      : (await readFile(filename)).toString("base64");
  }
  return result;
}
async function noJournal(store, projectId) {
  await assert.rejects(
    readFile(path.join(store.directory(projectId), ".transaction.json")),
    { code: "ENOENT" },
  );
}
async function waitFor(predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error("Raw definition history observation did not arrive");
}
function assertMetadataOnly(value) {
  const text = JSON.stringify(value);
  for (const secret of [
    consumerSecret,
    tokenSecret,
    "history-raw-consumer",
    '"consumerSecret"',
    '"tokenSecret"',
    "original-script",
    "edited-script",
  ])
    assert.equal(
      text.includes(secret),
      false,
      "metadata must not include private definitions",
    );
  for (const version of value.versions || [])
    assert.equal(version.definition, undefined);
}
function assertRawDefinition(request, body = xml) {
  assert.equal(request.bodyType, "raw");
  assert.equal(request.body, body);
  assert.deepEqual(request.postmanRawBody, marker);
  assert.deepEqual(request.auth, expectedAuth);
  assert.equal(request.beforeScript, beforeScript);
}
async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function fixture(t) {
  const root = await mkdtemp(
    path.join(tmpdir(), "definition-history-raw-root-"),
  );
  const seen = [],
    errors = [],
    clients = new Set(),
    cleanups = [];
  let origin, app;
  const peer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const contentTypes = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2)
      if (request.rawHeaders[index].toLowerCase() === "content-type")
        contentTypes.push(request.rawHeaders[index + 1]);
    const observed = {
      method: request.method,
      url: request.url,
      bytes: bytes.toString("base64"),
      contentTypes,
      script: request.headers["x-history-script"],
    };
    seen.push(observed);
    try {
      assert.equal(new URL(request.url, origin).pathname, "/signed");
      assert.equal(request.method, "POST");
      assert.equal(bytes.toString(), xml);
      assert.equal(observed.bytes, Buffer.from(xml).toString("base64"));
      assert.deepEqual(contentTypes, ["application/xml"]);
      assert.equal(observed.script, "original-script");
      const verified = verifyOAuth1Policy({
        url: new URL(request.url, origin).href,
        method: request.method,
        headers: request.headers,
        body: bytes,
        auth: expectedAuth,
        bodyType: "raw",
      });
      assert.deepEqual(verified.ordinaryQuery, [
        ["dup", "one"],
        ["dup", "two"],
        ["text", "a+b"],
      ]);
      assert.equal(verified.placement, "header");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ verified: true, ...observed }));
    } catch (error) {
      errors.push(error.message);
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"verified":false}');
    }
  });
  t.after(async () => {
    // Join actual saves before closing transports or removing the owned root.
    for (const cleanup of cleanups.toReversed()) await cleanup();
    await Promise.all(
      [...clients].map((client) => client.close().catch(() => {})),
    );
    if (app?.server.listening) await closeServer(app.server);
    if (peer.listening) await closeServer(peer);
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + peer.address().port;
  app = await createApp({ root, port: 0 });
  const api = async (
    route,
    data,
    method = data === undefined ? "GET" : "POST",
    status = 200,
  ) => {
    const response = await fetch(app.url + "/api" + route, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const project = await api(
    "/projects",
    { name: "Raw history source" },
    "POST",
    201,
  );
  const untouched = await api(
    "/projects",
    { name: "Raw history untouched peer" },
    "POST",
    201,
  );
  const configure = (projects, write = true, execute = false) =>
    api("/mcp/config", {
      enabled: true,
      remember: false,
      projects,
      write,
      execute,
    });
  return {
    root,
    origin,
    seen,
    errors,
    project,
    untouched,
    api,
    get app() {
      return app;
    },
    read: (projectId) => new Store(root).get(projectId),
    cleanup: (fn) => cleanups.push(fn),
    configure,
    async connect(projectId, { write = true, execute = false } = {}) {
      const config = await configure([projectId], write, execute);
      const client = new Client({
        name: "raw-history-integration",
        version: "1",
      });
      clients.add(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
      );
      return client;
    },
    async restart() {
      await Promise.all([...clients].map((client) => client.close()));
      clients.clear();
      await closeServer(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}
const route = (projectId) => "/projects/" + projectId;
const historyRoute = (projectId) => route(projectId) + "/definition-history";
const call = (client, name, args, options) =>
  client.callTool(
    { name: "localapi_" + name, arguments: args },
    undefined,
    options,
  );
async function importedAndEdited(f) {
  const imported = await f.api(route(f.project.id) + "/import", {
    document: collection(f.origin),
  });
  assert.equal(imported.requests.length, 1);
  const original = storedJSON(imported.requests[0]);
  assertRawDefinition(original);
  assert.equal(
    original.headers.some((row) => row.key.toLowerCase() === "content-type"),
    false,
  );
  const edit = await f.api(route(imported.id));
  edit.requests[0] = {
    ...edit.requests[0],
    body: "edited opaque raw data",
    description: "edited definition",
    postmanRawBody: { version: 1, language: "text" },
    beforeScript:
      'pm.request.headers.upsert({key:"X-History-Script",value:"edited-script"});',
    auth: {
      ...edit.requests[0].auth,
      consumerSecret: "fictional-edited-secret",
      parameterPolicy: {
        ...edit.requests[0].auth.parameterPolicy,
        includeBodyHash: false,
      },
    },
  };
  await f.api(route(imported.id), edit, "PUT");
  const list = await f.api(
    historyRoute(imported.id) + "?requestId=" + encodeURIComponent(original.id),
  );
  assert.equal(list.total, 1);
  assertMetadataOnly(list);
  return {
    original,
    requestId: original.id,
    lineageId: list.lineageId,
    historyId: list.versions[0].id,
    list,
  };
}
async function assertExportsRefuse(f, client, projectId, request) {
  const before = await f.read(projectId);
  const bytes = await diskBytes(f.app.store.directory(projectId));
  const count = f.seen.length;
  for (const format of ["openapi", "apipost", "apipost-directory"]) {
    const error = await f.api(
      route(projectId) + "/export?format=" + format,
      undefined,
      "GET",
      400,
    );
    assert.match(error.error, /Postman|raw|OAuth1|脚本|前置/);
  }
  const curl = await f.api(
    route(projectId) + "/curl",
    {
      request,
      environmentId: before.environments[0].id,
    },
    "POST",
    400,
  );
  assert.match(curl.error, /Postman|raw|OAuth1|脚本|前置/);
  for (const format of ["apipost", "apipost-directory"]) {
    const result = await call(client, "export_project", { projectId, format });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Postman raw/);
  }
  assert.deepEqual(await f.read(projectId), before);
  assert.deepEqual(await diskBytes(f.app.store.directory(projectId)), bytes);
  assert.equal(
    f.seen.length,
    count,
    "exports never evaluate scripts or send traffic",
  );
}

test(
  "raw XML history preserves full static OAuth1/script snapshots across owner and SDK restore, backup identity and restart",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const peerBefore = await f.read(f.untouched.id);
    const peerBytes = await diskBytes(f.app.store.directory(f.untouched.id));
    const { original, requestId, lineageId, historyId, list } =
      await importedAndEdited(f);
    const projectId = f.project.id;
    const client = await f.connect(projectId, { execute: true });
    const target = { projectId, requestId, lineageId };
    const sdkList = decode(
      await call(client, "list_api_definition_history", target),
    );
    assertMetadataOnly(sdkList);
    assert.deepEqual(sdkList, list);
    const version = decode(
      await call(client, "get_api_definition_version", {
        ...target,
        historyId,
      }),
    );
    assert.deepEqual(version.definition, original);
    assertRawDefinition(version.definition);
    const tagged = await f.api(historyRoute(projectId), {
      kind: "tag",
      requestId,
      lineageId,
      historyId,
      tag: "original XML",
      configRevision: list.configRevision,
    });
    assertMetadataOnly(tagged);
    const restored = decode(
      await call(client, "restore_api_definition", {
        ...target,
        historyId,
        configRevision: tagged.configRevision,
      }),
    );
    assertMetadataOnly(restored);
    const restoredProject = await f.read(projectId);
    assert.deepEqual(restoredProject.requests[0], original);
    assert.equal(
      restoredProject.requestDefinitionHistory.entries[0].versions.length,
      2,
    );
    assert.deepEqual(restoredProject.history, []);
    assert.equal(
      f.seen.length,
      0,
      "import/edit/read/tag/restore must be inert",
    );

    const executed = await f.api(route(projectId) + "/execute", {
      request: restoredProject.requests[0],
      environmentId: restoredProject.environments[0].id,
    });
    assert.equal(executed.status, 200);
    assert.equal(executed.outcome, "passed");
    assert.equal(executed.recordSaved, true);
    assert.equal(JSON.parse(executed.body).verified, true);
    assert.equal(f.seen.length, 1);
    assert.deepEqual(f.errors, []);
    const afterExecution = await f.read(projectId);
    assert.deepEqual(afterExecution.requests[0], original);
    assert.deepEqual(
      afterExecution.requestDefinitionHistory,
      restoredProject.requestDefinitionHistory,
    );
    const evidence = afterExecution.history.find(
      (record) => record.id === executed.recordId,
    );
    assert(evidence);
    assertRawDefinition(evidence.request);
    assert.equal(evidence.response.status, 200);
    await assertExportsRefuse(f, client, projectId, original);
    const backup = await f.api(route(projectId) + "/export");
    assert.deepEqual(backup.requests, afterExecution.requests);
    assert.deepEqual(
      backup.requestDefinitionHistory,
      afterExecution.requestDefinitionHistory,
    );
    assert.deepEqual(backup.history, afterExecution.history);
    const copyResponse = await f.api(
      "/restore",
      { document: backup },
      "POST",
      201,
    );
    assert.notEqual(copyResponse.id, projectId);
    // Ordinary owner responses are not the full-history transport. Reopen the
    // actual store to verify the backup's rebound identity and private history.
    const copy = await f.read(copyResponse.id);
    assert.equal(copy.requestDefinitionHistory.projectId, copy.id);
    assert.deepEqual(
      copy.requestDefinitionHistory.entries,
      backup.requestDefinitionHistory.entries,
    );
    assert.deepEqual(copy.requests, backup.requests);
    assert.deepEqual(copy.history, backup.history);
    assert.equal(
      f.seen.length,
      1,
      "backup restore must not replay captured execution",
    );
    await f.restart();
    const reopened = await f.read(copy.id);
    assertRawDefinition(reopened.requests[0]);
    assert.deepEqual(reopened.requests, backup.requests);
    assert.deepEqual(reopened.history, backup.history);
    assert.deepEqual(reopened.runs, backup.runs);
    assert.deepEqual(reopened.requestDefinitionHistory, {
      ...backup.requestDefinitionHistory,
      projectId: copy.id,
    });
    const copyClient = await f.connect(copy.id, { execute: true });
    const copiedTarget = { projectId: copy.id, requestId, lineageId };
    assert.deepEqual(
      decode(
        await call(copyClient, "get_api_definition_version", {
          ...copiedTarget,
          historyId,
        }),
      ).definition,
      original,
    );
    assert.equal(
      f.seen.length,
      1,
      "restart and authorized history reads are inert",
    );
    const sdkExecution = decode(
      await call(copyClient, "execute_api", {
        projectId: copy.id,
        apiId: requestId,
        environmentId: reopened.environments[0].id,
      }),
    );
    assert.equal(sdkExecution.status, "passed");
    assert.equal(sdkExecution.recordSaved, true);
    assert.equal(sdkExecution.results[0].response.status, 200);
    assert.equal(
      JSON.parse(sdkExecution.results[0].response.body).verified,
      true,
    );
    assert.equal(f.seen.length, 2);
    assert.deepEqual(f.errors, []);
    const beforeClear = await f.read(copy.id);
    assertRawDefinition(
      beforeClear.history.find((record) => record.id === sdkExecution.recordId)
        .request,
    );
    assert.deepEqual(
      beforeClear.history.find((record) => record.id === executed.recordId),
      evidence,
    );
    const currentTag = decode(
      await call(copyClient, "tag_api_definition_version", {
        ...copiedTarget,
        historyId: "current",
        tag: "current XML",
        configRevision: beforeClear.configRevision,
      }),
    );
    assertMetadataOnly(currentTag);
    const cleared = decode(
      await call(copyClient, "clear_api_definition_history", {
        ...copiedTarget,
        all: true,
        confirm: true,
        configRevision: currentTag.configRevision,
      }),
    );
    assertMetadataOnly(cleared);
    const final = await f.read(copy.id);
    assert.deepEqual(final.requests, reopened.requests);
    assert.deepEqual(final.history, beforeClear.history);
    assert.deepEqual(final.runs, beforeClear.runs);
    assert.equal(final.requestDefinitionHistory.entries[0].versions.length, 0);
    assertRawDefinition(final.requests[0]);
    await assertExportsRefuse(f, copyClient, copy.id, original);
    assert.deepEqual(await f.read(projectId), afterExecution);
    assert.deepEqual(await f.read(f.untouched.id), peerBefore);
    assert.deepEqual(
      await diskBytes(f.app.store.directory(f.untouched.id)),
      peerBytes,
    );
    assert.equal(
      f.seen.length,
      2,
      "only the two explicit executions reached the wire",
    );
    for (const id of [projectId, copy.id, f.untouched.id])
      await noJournal(f.app.store, id);
  },
);

// Same real-lock pattern as request-definition-history-transports.test.mjs.
// Never replace Store reads, input validation, journaling or commit behavior.
function holdQueuedRestore(store, projectId) {
  const originalSave = store.save;
  let unlock,
    releasePromise,
    releaseRequested = false,
    started = false,
    signal,
    failure;
  const ready = Promise.withResolvers(),
    settled = Promise.withResolvers();
  ready.promise.catch(() => {});
  const release = async () => {
    releaseRequested = true;
    if (unlock) releasePromise ??= unlock();
    await releasePromise;
  };
  const wrapped = async function (project, options = {}) {
    if (
      project.id !== projectId ||
      options.definitionHistoryOperation?.kind !== "restore"
    )
      return originalSave.call(this, project, options);
    assert.equal(started, false);
    started = true;
    signal = options.signal;
    let saving;
    try {
      unlock = await acquireFileLock(store.lockFile(projectId));
      if (releaseRequested)
        throw Error("restore fixture released before admission");
      assert(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      const previous = store.pending;
      saving = originalSave.call(this, project, options);
      saving.catch(() => {});
      assert.notEqual(store.pending, previous, "real save entered its queue");
      ready.resolve();
      return await saving;
    } catch (error) {
      failure = error;
      ready.reject(error);
      throw error;
    } finally {
      try {
        await release();
      } finally {
        await saving?.catch(() => {});
        settled.resolve();
      }
    }
  };
  store.save = wrapped;
  return {
    ready: ready.promise,
    settled: settled.promise,
    release,
    get signal() {
      return signal;
    },
    get failure() {
      return failure;
    },
    async dispose() {
      if (store.save === wrapped) store.save = originalSave;
      try {
        await release();
      } finally {
        if (started) await settled.promise;
      }
    },
  };
}
for (const mode of ["sdk-cancel", "write-revocation"])
  test(
    "raw XML queued history restore " +
      mode +
      " preserves current marker/history/peer without replay",
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t);
      const { requestId, lineageId, historyId } = await importedAndEdited(f);
      const projectId = f.project.id;
      const client = await f.connect(projectId);
      const before = await f.read(projectId),
        peerBefore = await f.read(f.untouched.id);
      const beforeBytes = await diskBytes(f.app.store.directory(projectId));
      const peerBytes = await diskBytes(f.app.store.directory(f.untouched.id));
      const held = holdQueuedRestore(f.app.store, projectId);
      f.cleanup(held.dispose);
      const controller = new AbortController();
      const observation = observeToolCall(
        call(
          client,
          "restore_api_definition",
          {
            projectId,
            requestId,
            lineageId,
            historyId,
            configRevision: before.configRevision,
          },
          { signal: controller.signal },
        ),
      );
      try {
        await held.ready;
        observation.assertPending();
        assert.equal(held.signal.aborted, false);
        if (mode === "sdk-cancel") controller.abort();
        // Explicit remember:false selects the existing immediate reduction
        // path; pending full reconfiguration is not effective revocation.
        else await f.configure([projectId], false, false);
        await waitFor(() => held.signal.aborted);
        await held.release();
        const terminal = await observation.completion;
        await held.settled;
        assert.equal(held.failure?.code, "STORE_SAVE_ABORTED");
        assert(
          terminal.kind === "rejected" || terminal.value?.isError === true,
        );
        const after = await f.read(projectId);
        assert.deepEqual(after, before);
        assert.deepEqual(after.requests[0].postmanRawBody, {
          version: 1,
          language: "text",
        });
        assert.deepEqual(
          after.requestDefinitionHistory,
          before.requestDefinitionHistory,
        );
        assert.deepEqual(
          await diskBytes(f.app.store.directory(projectId)),
          beforeBytes,
        );
        assert.deepEqual(await f.read(f.untouched.id), peerBefore);
        assert.deepEqual(
          await diskBytes(f.app.store.directory(f.untouched.id)),
          peerBytes,
        );
        assert.deepEqual(after.history, []);
        assert.deepEqual(after.runs, []);
        assert.equal(f.seen.length, 0);
        assert.deepEqual(f.errors, []);
        await noJournal(f.app.store, projectId);
      } finally {
        controller.abort();
        await held.dispose();
        await observation.completion;
      }
    },
  );

const largeXML = (bytes) => "<raw>" + "x".repeat(bytes - 11) + "</raw>";
async function assertLargeCompatibility(t, bytes) {
  const f = await fixture(t);
  const body = largeXML(bytes);
  assert.equal(Buffer.byteLength(body), bytes);
  const peerBefore = await f.read(f.untouched.id);
  const peerBytes = await diskBytes(f.app.store.directory(f.untouched.id));
  const input = { document: collection(f.origin, body) };
  assert(Buffer.byteLength(JSON.stringify(input)) < 12 * MiB);
  const imported = await f.api(route(f.project.id) + "/import", input);
  assertRawDefinition(imported.requests[0], body);
  const original = storedJSON(imported.requests[0]);
  const changed = await f.api(route(imported.id));
  changed.requests[0].description =
    "first owner edit must preserve the complete prior definition";
  assert(Buffer.byteLength(JSON.stringify(changed)) < 12 * MiB);
  await f.api(route(imported.id), changed, "PUT");
  const current = await f.read(imported.id);
  assertRawDefinition(current.requests[0], body);
  assert.equal(current.requestDefinitionHistory.entries[0].versions.length, 1);
  assert.deepEqual(
    current.requestDefinitionHistory.entries[0].versions[0].definition,
    original,
  );
  const ordinary = await f.api(route(imported.id));
  assertRawDefinition(ordinary.requests[0], body);
  assert.equal(Object.hasOwn(ordinary, "requestDefinitionHistory"), false);
  assert(Buffer.byteLength(JSON.stringify(ordinary)) < 12 * MiB);
  const list = await f.api(
    historyRoute(imported.id) + "?requestId=" + encodeURIComponent(original.id),
  );
  assert.equal(list.total, 1);
  assertMetadataOnly(list);
  assert(Buffer.byteLength(JSON.stringify(list)) < 64 * 1024);
  const backup = await f.api(route(imported.id) + "/export");
  assert.deepEqual(backup.requests, current.requests);
  assert.deepEqual(
    backup.requestDefinitionHistory,
    current.requestDefinitionHistory,
  );
  const restoreBytes = Buffer.byteLength(JSON.stringify({ document: backup }));
  assert(restoreBytes < 64 * MiB);
  if (bytes === 8 * MiB)
    assert(
      restoreBytes > 12 * MiB,
      "exact 8 MiB current plus its complete archive needs the dedicated backup envelope",
    );
  const copy = await f.api("/restore", { document: backup }, "POST", 201);
  assert.notEqual(copy.id, imported.id);
  await f.restart();
  for (const id of [imported.id, copy.id]) {
    const disk = await f.read(id);
    assertRawDefinition(disk.requests[0], body);
    assert.deepEqual(disk.requests, current.requests);
    assert.deepEqual(disk.requestDefinitionHistory, {
      ...current.requestDefinitionHistory,
      projectId: id,
    });
    await noJournal(f.app.store, id);
  }
  assert.deepEqual(await f.read(f.untouched.id), peerBefore);
  assert.deepEqual(
    await diskBytes(f.app.store.directory(f.untouched.id)),
    peerBytes,
  );
  assert.equal(f.seen.length, 0);
  assert.deepEqual(f.errors, []);
}
test(
  "2 MiB raw owner import, first edit with full historical definition and backup new identity stay exact",
  { timeout: 30000 },
  async (t) => assertLargeCompatibility(t, 2 * MiB),
);
test(
  "exact 8 MiB raw owner import, full first archive and dedicated backup restore remain compatible",
  { timeout: 30000 },
  async (t) => assertLargeCompatibility(t, 8 * MiB),
);
