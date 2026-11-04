import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";
import { writeProject } from "../src/project-files.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { listRequestDefinitionHistory } from "../src/request-definition-history.mjs";

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return;
    await delay(5);
  }
  throw Error("Definition history workflow observation timed out");
};
const decode = (response) => {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
};
async function seed(store, base = "https://example.invalid") {
  let p = await store.create("Definition history transport fixture");
  // Seed canonical definitions just like the owner editor. Backup restore may
  // add missing defaults to legacy shapes; that is not lost stored data.
  p.requests = [
    {
      id: "api",
      name: "API",
      method: "GET",
      url: base + "/first",
      auth: { type: "bearer", token: "fixture-definition-only-secret" },
    },
    {
      id: "other",
      name: "Other",
      method: "GET",
      url: base + "/other",
    },
  ].map((request) => normalizeRequest(request));
  p = await store.save(p);
  p.requests[0].url = base + "/second";
  p = await store.save(p);
  const history = listRequestDefinitionHistory(p, { requestId: "api" });
  return { p, lineageId: history.lineageId, historyId: history.versions[0].id };
}
async function fixture(t, { base } = {}) {
  const root = await mkdtemp(
    path.join(tmpdir(), "definition-history-transport-"),
  );
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const seeded = await seed(app.store, base);
  const headers = {
    "x-local-token": app.token,
    "content-type": "application/json",
  };
  return {
    ...seeded,
    root,
    app,
    headers,
    route: app.url + "/api/projects/" + seeded.p.id + "/definition-history",
  };
}
const rpcCall = (dispatch, name, args, options) =>
  dispatch(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "localapi_" + name, arguments: args },
    },
    options,
  );

// Tests intentionally require the real Store, server and official SDK. They must
// not replace unavailable production dependencies with stubs or claim a pass.
test(
  "owner history routes validate exact paths/query/body and return bounded target data",
  { timeout: 15000 },
  async (t) => {
    const { app, headers, route, p, lineageId, historyId } = await fixture(t);
    assert.equal((await fetch(route + "?requestId=api")).status, 403);
    const list = await fetch(route + "?requestId=api", { headers }).then((r) =>
      r.json(),
    );
    assert.equal(list.configRevision, p.configRevision);
    assert.equal(list.lineageId, lineageId);
    assert.equal(list.versions[0].id, historyId);
    assert.equal(
      JSON.stringify(list).includes("fixture-definition-only-secret"),
      false,
    );
    const version = await fetch(
      route + "/version?requestId=api&historyId=" + historyId,
      { headers },
    ).then((r) => r.json());
    assert.equal(version.definition.url, "https://example.invalid/first");
    for (const suffix of [
      "?requestId=api&requestId=other",
      "?requestId=api&limit=",
      "?requestId=api&offset=1.0",
      "?requestId=api&offset=-1",
      "?requestId=api&limit=101",
      "?requestId=api&unknown=1",
      "?requestId=%FF",
      "/version?requestId=api&historyId=current&historyId=" + historyId,
    ])
      assert.equal(
        (await fetch(route + suffix, { headers })).status,
        400,
        suffix,
      );
    assert.equal(
      (await fetch(route + "/version/extra?requestId=api", { headers })).status,
      404,
    );
    assert.equal(
      (await fetch(route + "/version", { method: "POST", headers, body: "{}" }))
        .status,
      405,
    );
    const input = {
      kind: "tag",
      requestId: "api",
      lineageId,
      historyId,
      configRevision: p.configRevision,
      tag: "reviewed",
    };
    const before = await app.store.get(p.id);
    for (const invalid of [
      { ...input, configRevision: undefined },
      { ...input, configRevision: "1" },
      { ...input, configRevision: null },
      { ...input, unrelated: true },
      {
        ...input,
        kind: "clear",
        tag: undefined,
        historyId: undefined,
        all: true,
      },
    ]) {
      assert.equal(
        (
          await fetch(route, {
            method: "POST",
            headers,
            body: JSON.stringify(invalid),
          })
        ).status,
        400,
      );
      assert.deepEqual(await app.store.get(p.id), before);
    }
    assert.equal(
      (
        await fetch(route + "?requestId=api", {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        })
      ).status,
      400,
    );
    const tagged = await fetch(route, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    }).then((r) => r.json());
    assert.equal(tagged.tag, "reviewed");
    assert(tagged.configRevision > p.configRevision);
    assert.equal(tagged.requestId, "api");
    assert.equal(tagged.lineageId, lineageId);
    assert.equal(tagged.requests, undefined);
    assert.equal(
      JSON.stringify(tagged).includes("fixture-definition-only-secret"),
      false,
    );
    assert.equal(
      (
        await fetch(route, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        })
      ).status,
      400,
      "stale configuration must not overwrite a tag",
    );
    const current = await app.store.get(p.id);
    const clear = {
      kind: "clear",
      requestId: "api",
      lineageId,
      configRevision: current.configRevision,
      all: true,
    };
    for (const confirm of [undefined, false, 1, "true", null])
      assert.equal(
        (
          await fetch(route, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...clear, confirm }),
          })
        ).status,
        400,
      );
    const cleared = await fetch(route, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...clear, confirm: true }),
    }).then((r) => r.json());
    assert.equal(cleared.remainingHistory, 0);
    const after = await app.store.get(p.id);
    assert.deepEqual(after.requests, current.requests);
    assert.deepEqual(after.history, current.history);
    assert.deepEqual(after.runs, current.runs);
  },
);

test(
  "MCP history tools enforce project/write grants, exact arguments, cancellation and bounded results",
  { timeout: 15000 },
  async (t) => {
    const { app, p, lineageId, historyId } = await fixture(t);
    const write = createMCP({
      store: app.store,
      projects: [p.id],
      write: true,
      execute: false,
    });
    const read = createMCP({
      store: app.store,
      projects: [p.id],
      write: false,
    });
    const denied = createMCP({ store: app.store, projects: [], write: true });
    const args = { projectId: p.id, requestId: "api", lineageId };
    const catalog = (await write({ id: 0, method: "tools/list" })).result.tools;
    for (const name of [
      "tag_api_definition_version",
      "restore_api_definition",
      "clear_api_definition_history",
    ])
      assert(
        catalog
          .find((item) => item.name === "localapi_" + name)
          .inputSchema.required.includes("configRevision"),
      );
    const clearTool = catalog.find(
      (item) => item.name === "localapi_clear_api_definition_history",
    );
    assert.equal(clearTool.inputSchema.properties.confirm.const, true);
    assert(clearTool.inputSchema.required.includes("confirm"));
    assert.equal(
      (await rpcCall(denied, "list_api_definition_history", args)).result
        .isError,
      true,
    );
    const list = decode(
      (await rpcCall(read, "list_api_definition_history", args)).result,
    );
    assert.equal(list.versions[0].id, historyId);
    assert.equal(list.configRevision, p.configRevision);
    assert.equal(list.versions[0].definition, undefined);
    const detail = decode(
      (
        await rpcCall(read, "get_api_definition_version", {
          ...args,
          historyId,
        })
      ).result,
    );
    assert.equal(detail.definition.url, "https://example.invalid/first");
    const input = {
      ...args,
      historyId,
      configRevision: p.configRevision,
      tag: "MCP-tag",
    };
    for (const dispatch of [read, denied])
      assert.equal(
        (await rpcCall(dispatch, "tag_api_definition_version", input)).result
          .isError,
        true,
      );
    for (const invalid of [
      { ...input, configRevision: undefined },
      { ...input, configRevision: "0" },
      { ...input, extra: true },
      { ...input, tag: 1 },
      { ...input, lineageId: "wrong-lineage" },
    ])
      assert.equal(
        (await rpcCall(write, "tag_api_definition_version", invalid)).result
          .isError,
        true,
      );
    let accessed = false;
    const accessor = Object.defineProperty({ ...input }, "tag", {
      enumerable: true,
      get() {
        accessed = true;
        return "unsafe";
      },
    });
    const proxy = new Proxy(
      { ...input },
      {
        ownKeys() {
          accessed = true;
          throw Error("must not inspect proxy");
        },
      },
    );
    for (const unsafe of [accessor, proxy])
      assert.equal(
        (await rpcCall(write, "tag_api_definition_version", unsafe)).result
          .isError,
        true,
      );
    assert.equal(accessed, false);
    const aborted = AbortSignal.abort();
    assert.equal(
      (
        await rpcCall(write, "tag_api_definition_version", input, {
          signal: aborted,
        })
      ).result.isError,
      true,
    );
    assert.deepEqual(await app.store.get(p.id), p);
    const tagged = decode(
      (await rpcCall(write, "tag_api_definition_version", input)).result,
    );
    assert.equal(tagged.tag, "MCP-tag");
    assert.equal(tagged.requests, undefined);
    let current = await app.store.get(p.id);
    const restored = decode(
      (
        await rpcCall(write, "restore_api_definition", {
          ...args,
          historyId,
          configRevision: current.configRevision,
        })
      ).result,
    );
    assert.equal(restored.kind, "restore");
    current = await app.store.get(p.id);
    assert.equal(current.requests[0].url, "https://example.invalid/first");
    assert.deepEqual(current.history, p.history);
    assert.deepEqual(current.runs, p.runs);
    const clear = {
      ...args,
      configRevision: current.configRevision,
      all: true,
    };
    for (const confirm of [undefined, false, "true", 1, null])
      assert.equal(
        (
          await rpcCall(write, "clear_api_definition_history", {
            ...clear,
            confirm,
          })
        ).result.isError,
        true,
      );
    for (const choice of [
      {},
      { all: false },
      { historyIds: ["current"] },
      { historyIds: ["missing-history"] },
      { all: true, historyIds: [historyId] },
    ])
      assert.equal(
        (
          await rpcCall(write, "clear_api_definition_history", {
            ...args,
            configRevision: current.configRevision,
            confirm: true,
            ...choice,
          })
        ).result.isError,
        true,
      );
    decode(
      (
        await rpcCall(write, "clear_api_definition_history", {
          ...clear,
          confirm: true,
        })
      ).result,
    );
    const after = await app.store.get(p.id);
    assert.deepEqual(after.requests, current.requests);
    assert.equal(
      listRequestDefinitionHistory(after, { requestId: "api" }).total,
      0,
    );
  },
);

async function configure(app, headers, projectId, write = true) {
  const response = await fetch(app.url + "/api/mcp/config", {
    method: "POST",
    headers,
    body: JSON.stringify({
      enabled: true,
      projects: [projectId],
      write,
      execute: false,
      // Revocation must take the immediate reduction path while a real project
      // lock is held; the full reconfiguration path also reads this project.
      remember: false,
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
function holdQueuedHistorySave(store) {
  const originalSave = store.save;
  let releaseLock,
    releasePromise,
    entered,
    rejectReady,
    signal,
    finished,
    started = false,
    releaseRequested = false,
    failure;
  const ready = new Promise((resolve, reject) => {
    entered = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  const settled = new Promise((resolve) => {
    finished = resolve;
  });
  const release = async () => {
    releaseRequested = true;
    if (releaseLock) releasePromise ??= releaseLock();
    await releasePromise;
  };
  const wrappedSave = async function (project, options = {}) {
    if (options.definitionHistoryOperation === undefined)
      return originalSave.call(this, project, options);
    assert.equal(started, false, "fixture holds exactly one history save");
    started = true;
    signal = options.signal;
    let saving;
    try {
      releaseLock = await acquireFileLock(store.lockFile(project.id));
      if (releaseRequested) throw Error("history save hold already released");
      assert(signal instanceof AbortSignal);
      assert.equal(
        signal.aborted,
        false,
        "real save starts before cancellation",
      );
      const previousQueue = store.pending;
      // Start the unmodified Store save while the actual project lock is held.
      // Its synchronous input validation and signal admission have already run
      // when pending changes, so cancellation tests the later commit gate.
      saving = originalSave.call(this, project, options);
      saving.catch(() => {});
      assert.notEqual(
        store.pending,
        previousQueue,
        "real save entered its queue",
      );
      entered();
      return await saving;
    } catch (error) {
      failure = error;
      rejectReady(error);
      throw error;
    } finally {
      try {
        await release();
      } finally {
        // Even an assertion/cleanup failure after queue admission must wait for
        // the genuine Store operation rather than leaving a late writer alive.
        await saving?.catch(() => {});
        finished();
      }
    }
  };
  store.save = wrappedSave;
  const dispose = async () => {
    if (store.save === wrappedSave) store.save = originalSave;
    try {
      await release();
    } finally {
      if (started) await settled;
    }
  };
  return {
    ready,
    release,
    settled,
    dispose,
    get signal() {
      return signal;
    },
    get failure() {
      return failure;
    },
  };
}

test(
  "official HTTP SDK cancellation and grant revocation stop history mutations before Store commit",
  { timeout: 20000 },
  async (t) => {
    const { app, headers, p, lineageId, historyId } = await fixture(t);
    let config = await configure(app, headers, p.id);
    for (const action of ["cancel", "revoke", "delete-session"]) {
      if (action === "delete-session")
        config = await configure(app, headers, p.id);
      const client = new Client({
        name: "definition-history-cancellation",
        version: "1",
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(app.url + "/mcp"),
        {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        },
      );
      t.after(() => client.close().catch(() => {}));
      await client.connect(transport);
      const held = holdQueuedHistorySave(app.store);
      t.after(held.dispose);
      try {
        const controller = new AbortController();
        const pending = client
          .callTool(
            {
              name: "localapi_tag_api_definition_version",
              arguments: {
                projectId: p.id,
                requestId: "api",
                lineageId,
                historyId,
                configRevision: p.configRevision,
                tag: action,
              },
            },
            undefined,
            { signal: controller.signal },
          )
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        await held.ready;
        assert(held.signal instanceof AbortSignal);
        assert.equal(held.signal.aborted, false);
        if (action === "cancel") controller.abort();
        else if (action === "revoke")
          await configure(app, headers, p.id, false);
        else await transport.terminateSession();
        await waitFor(() => held.signal.aborted);
        await held.release();
        const outcome = await pending;
        await held.settled;
        assert.equal(held.failure?.code, "STORE_SAVE_ABORTED");
        if (action === "cancel" || action === "revoke")
          assert(outcome.error || outcome.value?.isError);
        else assert(outcome.value?.isError || outcome.error);
        assert.deepEqual(
          await app.store.get(p.id),
          p,
          action + " must not commit",
        );
      } finally {
        await held.dispose();
      }
      await client.close();
    }
  },
);

test(
  "owner disconnect and stateless HTTP MCP revocation abort queued definition writes",
  { timeout: 20000 },
  async (t) => {
    const { app, headers, route, p, lineageId, historyId } = await fixture(t);
    const input = {
      kind: "tag",
      requestId: "api",
      lineageId,
      historyId,
      configRevision: p.configRevision,
      tag: "must-not-commit",
    };
    const heldOwner = holdQueuedHistorySave(app.store);
    t.after(heldOwner.dispose);
    const req = http.request(route, { method: "POST", headers });
    req.on("error", () => {});
    try {
      req.end(JSON.stringify(input));
      await heldOwner.ready;
      assert.equal(heldOwner.signal.aborted, false);
      req.destroy();
      await waitFor(() => heldOwner.signal.aborted);
      await heldOwner.release();
      await heldOwner.settled;
      assert.equal(heldOwner.failure?.code, "STORE_SAVE_ABORTED");
    } finally {
      req.destroy();
      await heldOwner.dispose();
    }
    const config = await configure(app, headers, p.id);
    const heldMCP = holdQueuedHistorySave(app.store);
    t.after(heldMCP.dispose);
    try {
      const { kind, ...args } = input;
      const pending = fetch(app.url + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer " + config.token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "localapi_tag_api_definition_version",
            arguments: { ...args, projectId: p.id },
          },
        }),
      });
      pending.catch(() => {});
      await heldMCP.ready;
      assert.equal(heldMCP.signal.aborted, false);
      await configure(app, headers, p.id, false);
      await waitFor(() => heldMCP.signal.aborted);
      await heldMCP.release();
      const result = await pending.then((r) => r.json());
      await heldMCP.settled;
      assert.equal(heldMCP.failure?.code, "STORE_SAVE_ABORTED");
      assert.equal(result.error?.code, -32000);
    } finally {
      await heldMCP.dispose();
    }
    assert.deepEqual(await new Store(app.store.root).get(p.id), p);
  },
);

async function connectStdio(t, root, projectId, { write = false } = {}) {
  const client = new Client({ name: "definition-history-stdio", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
      "--project",
      projectId,
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
  t.after(() => client.close().catch(() => {}));
  await client.connect(transport);
  return client;
}

test(
  "official stdio SDK reads/tags/restores/clears and restarts with restored identity and exact grants without network effects",
  { timeout: 30000 },
  async (t) => {
    let effects = 0;
    const sentinel = http.createServer((_req, res) => {
      effects++;
      res.end("unexpected execution");
    });
    await new Promise((resolve) => sentinel.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      sentinel.closeAllConnections();
      await new Promise((resolve) => sentinel.close(resolve));
    });
    const base = "http://127.0.0.1:" + sentinel.address().port;
    const { root, app, p, lineageId, historyId, headers } = await fixture(t, {
      base,
    });
    const unauthorized = await app.store.create("not granted");
    const client = await connectStdio(t, root, p.id, { write: true });
    const names = new Set(
      (await client.listTools()).tools.map((item) => item.name),
    );
    for (const name of [
      "list_api_definition_history",
      "get_api_definition_version",
      "tag_api_definition_version",
      "restore_api_definition",
      "clear_api_definition_history",
    ])
      assert(names.has("localapi_" + name));
    assert(!names.has("localapi_execute_api"));
    const call = (who, projectId, name, args) =>
      who.callTool({
        name: "localapi_" + name,
        arguments: { projectId, requestId: "api", lineageId, ...args },
      });
    for (const name of [
      "list_api_definition_history",
      "get_api_definition_version",
      "tag_api_definition_version",
      "restore_api_definition",
      "clear_api_definition_history",
    ])
      assert.equal(
        (
          await call(client, unauthorized.id, name, {
            ...(name === "get_api_definition_version" ? { historyId } : {}),
            ...(name === "tag_api_definition_version"
              ? { historyId, tag: "denied", configRevision: 1 }
              : {}),
            ...(name === "restore_api_definition"
              ? { historyId, configRevision: 1 }
              : {}),
            ...(name === "clear_api_definition_history"
              ? { all: true, confirm: true, configRevision: 1 }
              : {}),
          })
        ).isError,
        true,
      );
    const first = decode(
      await call(client, p.id, "list_api_definition_history"),
    );
    assert.equal(first.configRevision, p.configRevision);
    const historical = decode(
      await call(client, p.id, "get_api_definition_version", { historyId }),
    );
    assert.equal(historical.definition.url, base + "/first");
    const tagged = decode(
      await call(client, p.id, "tag_api_definition_version", {
        historyId: "current",
        tag: "stdio-current",
        configRevision: first.configRevision,
      }),
    );
    assert.equal(tagged.historyId, "current");
    assert.equal(tagged.tag, "stdio-current");
    assert.equal(tagged.requests, undefined);
    const restored = decode(
      await call(client, p.id, "restore_api_definition", {
        historyId,
        configRevision: tagged.configRevision,
      }),
    );
    const afterRestore = await new Store(root).get(p.id);
    assert.equal(afterRestore.requests[0].url, base + "/first");
    const history = decode(
      await call(client, p.id, "list_api_definition_history"),
    );
    const cleared = decode(
      await call(client, p.id, "clear_api_definition_history", {
        historyIds: history.versions.map((item) => item.id),
        configRevision: restored.configRevision,
        confirm: true,
      }),
    );
    assert.equal(cleared.remainingHistory, 0);
    const source = await new Store(root).get(p.id);
    assert.deepEqual(source.requests, afterRestore.requests);
    assert.deepEqual(source.history, p.history);
    assert.deepEqual(source.runs, p.runs);
    const copyResponse = await fetch(app.url + "/api/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ document: afterRestore }),
    });
    assert.equal(copyResponse.status, 201);
    const copy = await copyResponse.json();
    assert.notEqual(copy.id, p.id);
    assert.equal(copy.requestDefinitionHistory, undefined);
    assert.equal(
      (await new Store(root).get(copy.id)).requestDefinitionHistory.projectId,
      copy.id,
    );
    assert.equal(
      (await call(client, copy.id, "list_api_definition_history")).isError,
      true,
    );
    await client.close();
    const diskHistory = JSON.parse(
      await readFile(
        path.join(app.store.directory(copy.id), "history/definitions.json"),
        "utf8",
      ),
    );
    assert.equal(diskHistory.projectId, copy.id);
    assert.deepEqual(
      diskHistory.entries,
      afterRestore.requestDefinitionHistory.entries,
    );
    const readonly = await connectStdio(t, root, copy.id);
    const readonlyNames = new Set(
      (await readonly.listTools()).tools.map((item) => item.name),
    );
    assert(readonlyNames.has("localapi_list_api_definition_history"));
    for (const name of [
      "tag_api_definition_version",
      "restore_api_definition",
      "clear_api_definition_history",
    ])
      assert(!readonlyNames.has("localapi_" + name));
    const copyList = decode(
      await call(readonly, copy.id, "list_api_definition_history"),
    );
    assert.equal(copyList.total, history.total);
    assert.deepEqual(
      decode(
        await call(readonly, copy.id, "get_api_definition_version", {
          historyId: "current",
        }),
      ).definition,
      afterRestore.requests[0],
    );
    assert.equal(
      (await call(readonly, p.id, "list_api_definition_history")).isError,
      true,
    );
    for (const [name, args] of [
      ["tag_api_definition_version", { historyId: "current", tag: "denied" }],
      ["restore_api_definition", { historyId }],
      ["clear_api_definition_history", { all: true, confirm: true }],
    ])
      assert.equal(
        (
          await call(readonly, copy.id, name, {
            configRevision: copyList.configRevision,
            ...args,
          })
        ).isError,
        true,
      );
    await readonly.close();
    const writer = await connectStdio(t, root, copy.id, { write: true });
    decode(
      await call(writer, copy.id, "clear_api_definition_history", {
        configRevision: copyList.configRevision,
        all: true,
        confirm: true,
      }),
    );
    await writer.close();
    const reopened = new Store(root);
    assert.deepEqual(
      (await reopened.get(copy.id)).requests,
      afterRestore.requests,
    );
    assert.deepEqual(await reopened.get(p.id), source);
    assert.deepEqual(await readMCPActivities(root), []);
    assert.equal(
      effects,
      0,
      "history reads, tag, restore, clear and process restarts never execute the API",
    );
  },
);

test(
  "oversized legacy current definition returns explicit MCP size error and leaves official stdio usable",
  { timeout: 20000 },
  async (t) => {
    const { root, app, p } = await fixture(t);
    const legacy = structuredClone(p);
    delete legacy.requestDefinitionHistory;
    legacy.requests[0].body = "x".repeat(2 * 1024 * 1024);
    // Model an already persisted pre-feature definition. Current and snapshot
    // capacity are separate from the bounded MCP detail transport.
    await writeProject(app.store.directory(p.id), legacy);
    const client = await connectStdio(t, root, p.id);
    const list = decode(
      await client.callTool({
        name: "localapi_list_api_definition_history",
        arguments: { projectId: p.id, requestId: "api" },
      }),
    );
    assert.equal(list.tracked, false);
    const detail = await client.callTool({
      name: "localapi_get_api_definition_version",
      arguments: { projectId: p.id, requestId: "api", historyId: "current" },
    });
    assert.equal(detail.isError, true);
    assert.match(detail.content[0].text, /2 MiB/);
    assert(Buffer.byteLength(JSON.stringify(detail)) < 1024);
    await client.ping();
    decode(
      await client.callTool({
        name: "localapi_list_api_definition_history",
        arguments: { projectId: p.id, requestId: "other" },
      }),
    );
    await client.close();
    assert.deepEqual(
      (await new Store(root).get(p.id)).requests,
      legacy.requests,
    );
  },
);

function escapedBackup(project) {
  const document = structuredClone(project);
  document.documents = [
    {
      id: "quoted-document",
      title: "Dense JSON quoting",
      content: '\"\\'.repeat(2 * 1024 * 1024),
    },
  ];
  const objectBody = JSON.stringify({ document });
  const stringBody = JSON.stringify({ document: JSON.stringify(document) });
  assert(Buffer.byteLength(objectBody) < 12 * 1024 * 1024);
  assert(Buffer.byteLength(stringBody) > 12 * 1024 * 1024);
  return { document, objectBody, stringBody };
}

test(
  "owner backup restore accepts dense quote/backslash object envelope below 12 MiB",
  { timeout: 30000 },
  async (t) => {
    const { app, root, headers, p } = await fixture(t);
    const { document, objectBody } = escapedBackup(p);
    const before = await app.store.list();
    const response = await fetch(app.url + "/api/restore", {
      method: "POST",
      headers,
      body: objectBody,
    });
    assert.equal(response.status, 201);
    const restored = await response.json();
    assert.notEqual(restored.id, p.id);
    assert.equal((await app.store.list()).length, before.length + 1);
    const disk = await new Store(root).get(restored.id);
    assert.deepEqual(disk.documents, document.documents);
    assert.equal(disk.requestDefinitionHistory.projectId, restored.id);
    assert.deepEqual(
      disk.requestDefinitionHistory.entries,
      p.requestDefinitionHistory.entries,
    );
  },
);

test(
  "owner backup restore accepts legacy string envelopes above 12 MiB under its dedicated 64 MiB bound",
  { timeout: 30000 },
  async (t) => {
    const { app, root, headers, p } = await fixture(t);
    const { stringBody } = escapedBackup(p);
    const before = await app.store.list();
    const response = await fetch(app.url + "/api/restore", {
      method: "POST",
      headers,
      body: stringBody,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const restored = await response.json();
    const disk = await new Store(root).get(restored.id);
    assert.equal((await app.store.list()).length, before.length + 1);
    assert.deepEqual(disk.documents, escapedBackup(p).document.documents);
    assert.deepEqual(
      disk.requestDefinitionHistory.entries,
      p.requestDefinitionHistory.entries,
    );
    assert.equal(disk.requestDefinitionHistory.projectId, restored.id);
  },
);

test(
  "owner editable responses omit history without losing client edits, while explicit backup remains complete",
  { timeout: 15000 },
  async (t) => {
    const { app, root, headers, p } = await fixture(t);
    const url = app.url + "/api/projects/" + p.id;
    const before = await app.store.get(p.id);
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const editable = await response.json();
    assert.equal(Object.hasOwn(editable, "requestDefinitionHistory"), false);
    const expected = structuredClone(before);
    delete expected.requestDefinitionHistory;
    assert.deepEqual(editable, expected);
    editable.name = "Client name retained";
    editable.requests[0].name = "Client API edit retained";
    const savedResponse = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(editable),
    });
    assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
    const saved = await savedResponse.json();
    assert.equal(Object.hasOwn(saved, "requestDefinitionHistory"), false);
    assert.equal(saved.name, editable.name);
    assert.equal(saved.requests[0].name, editable.requests[0].name);
    const disk = await new Store(root).get(p.id);
    const oldEntry = before.requestDefinitionHistory.entries.find(
      (e) => e.requestId === "api",
    );
    const newEntry = disk.requestDefinitionHistory.entries.find(
      (e) => e.requestId === "api",
    );
    assert.deepEqual(newEntry.versions.slice(0, -1), oldEntry.versions);
    assert.deepEqual(newEntry.versions.at(-1).definition, before.requests[0]);
    assert.equal(newEntry.currentVersion, oldEntry.currentVersion + 1);
    assert.deepEqual(disk.requests[1], before.requests[1]);
    const backup = await fetch(url + "/export", { headers }).then((r) =>
      r.json(),
    );
    assert.deepEqual(backup, disk);
    const stale = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(editable),
    });
    assert.equal(stale.status, 400);
    assert.deepEqual(await app.store.get(p.id), disk);
  },
);

test(
  "ordinary owner input stays 12 MiB and backups above 64 MiB fail without a new identity",
  { timeout: 30000 },
  async (t) => {
    const { app, root, headers, p } = await fixture(t);
    const before = await app.store.list();
    const original = await app.store.get(p.id);
    for (const [route, method, document, expectedLimit] of [
      [
        "/api/projects/" + p.id,
        "PUT",
        { ...p, description: "x".repeat(12 * 1024 * 1024) },
        "12 MiB",
      ],
      [
        "/api/restore",
        "POST",
        { document: { ...p, description: "x".repeat(64 * 1024 * 1024) } },
        "64 MiB",
      ],
    ]) {
      let response;
      try {
        response = await fetch(app.url + route, {
          method,
          headers,
          body: JSON.stringify(document),
        });
      } catch (error) {
        assert(error instanceof TypeError);
        assert.match(
          error.cause?.code || "",
          /ECONNRESET|EPIPE|UND_ERR_SOCKET/,
        );
      }
      if (response) {
        assert.equal(response.status, 400);
        assert((await response.json()).error.includes(expectedLimit));
      }
      assert.deepEqual(await new Store(root).list(), before);
      assert.deepEqual(await app.store.get(p.id), original);
      assert.equal(
        (await fetch(app.url + "/api/projects", { headers })).status,
        200,
      );
    }
  },
);
