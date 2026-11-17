// Real owner + official SDK composition; public-schema synthetic data, loopback only.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { previewDefinitionExport } from "../src/scoped-definition-export.mjs";
import { binaryExportFixture } from "./fixtures/native-websocket-binary-export.mjs";

// Independent byte oracle, never derived by the importer/exporter or its helper.
const expected = [
  { hex: "e99baaf09f988000", binary: false },
  { hex: "", binary: false },
  { hex: "00ff80c280", binary: true },
  { hex: "00ff80c280", binary: true },
  { hex: "", binary: true },
  { hex: "", binary: true },
];
const scope = (format, kind = "protocol-bundle", id = "definitions") => ({
  format,
  selection: { mode: "explicit", resources: [{ kind, id }] },
});
const accept = (input, preview) => ({
  ...input,
  configRevision: preview.configRevision,
  scopeDigest: preview.scope.digest,
  acceptedDependencies: preview.scope.dependencies,
});
const inputFor = (format, document) => ({
  format,
  document,
  selection: { mode: "all" },
});
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const tool = (client, projectId, name, input) =>
  client.callTool({
    name: "localapi_" + name,
    arguments: { projectId, ...input },
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
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "binary-interchange-"));
  const frames = [];
  let connections = 0,
    httpHits = 0,
    databaseHits = 0;
  const peer = http.createServer((_req, res) => {
    httpHits++;
    res.end("unexpected");
  });
  const database = net.createServer((socket) => {
    databaseHits++;
    socket.destroy();
  });
  const wss = new WebSocketServer({ server: peer });
  wss.on("connection", (socket) => {
    connections++;
    socket.on("error", () => {});
    socket.on("message", (data, binary) => {
      frames.push({ hex: data.toString("hex"), binary });
      socket.send(data, { binary });
    });
  });
  peer.listen(0, "127.0.0.1");
  database.listen(0, "127.0.0.1");
  await Promise.all([once(peer, "listening"), once(database, "listening")]);
  let app = await createApp({ root, port: 0 });
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await app.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((r) => wss.close(r));
    peer.closeAllConnections();
    await Promise.all(
      [peer, database].map((s) => new Promise((r) => s.close(r))),
    );
    await rm(root, { recursive: true, force: true });
  });
  const owner = async (route, body, status = 200) => {
    const response = await fetch(app.url + "/api" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const source = await app.store.create("Binary source"),
    target = await app.store.create("Binary target"),
    untouched = await app.store.create("Untouched peer");
  const document = binaryExportFixture(
      `ws://127.0.0.1:${peer.address().port}/echo?x=one`,
    ),
    original = structuredClone(document);
  await owner(`/projects/${source.id}/import`, { document });
  let p = await app.store.get(target.id);
  p.currentEnvironmentId = p.environments[0].id;
  p.globalVariables.scriptHits = "0";
  p.requests = [
    normalizeRequest({
      id: "retained",
      name: "Old HTTP",
      method: "POST",
      url: `http://127.0.0.1:${peer.address().port}/never`,
      bodyType: "raw",
      body: "<private>雪</private>\r\n",
      postmanRawBody: { version: 1, language: "xml" },
      auth: {
        type: "basic",
        username: "fixture",
        password: "fictional-secret",
      },
      beforeScript: 'throw Error("must not run");',
    }),
  ];
  p = await app.store.save(p);
  p.requests[0].name = "Current HTTP";
  p = await app.store.save(p);
  await owner(`/projects/${target.id}/plans`, {
    name: "Retained frozen HTTP",
    steps: [{ request: p.requests[0] }],
  });
  assert.ok(
    p.requestDefinitionHistory.entries.some(
      (e) =>
        e.requestId === "retained" &&
        e.versions.some((v) => v.definition.name === "Old HTTP"),
    ),
  );
  return {
    root,
    source,
    target,
    untouched,
    document,
    original,
    frames,
    owner,
    get app() {
      return app;
    },
    get: (id) => new Store(root).get(id),
    post: (p, action, body, status) =>
      owner(`/projects/${p.id}/${action}`, body, status),
    async restart() {
      await app.close();
      app = await createApp({ root, port: 0 });
    },
    noEffects(n = 0) {
      assert.equal(connections, n);
      assert.equal(frames.length, n);
      assert.equal(httpHits, 0);
      assert.equal(databaseHits, 0);
    },
    async connect(kind, p, write = false, execute = false) {
      const client = new Client({
        name: "binary-interchange-sdk",
        version: "1",
      });
      clients.push(client);
      let transport;
      if (kind === "HTTP") {
        const config = await owner("/mcp/config", {
          enabled: true,
          remember: false,
          projects: [p.id],
          write,
          execute,
        });
        transport = new StreamableHTTPClientTransport(
          new URL(app.url + "/mcp"),
          {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          },
        );
      } else
        transport = new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            p.id,
            ...(write ? ["--write"] : []),
            ...(execute ? ["--execute"] : []),
          ],
          env: {
            LOCAL_API_DATA: root,
            ...(process.platform === "win32"
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
          },
          stderr: "pipe",
        });
      await client.connect(transport);
      return client;
    },
  };
}
function retained(actual, before) {
  for (const field of [
    "requests",
    "requestDefinitionHistory",
    "currentEnvironmentId",
    "environments",
    "globalVariables",
    "plans",
  ])
    assert.deepEqual(actual[field], before[field], field);
}
function binaryModel(p) {
  assert.equal(p.protocols.length, 6);
  assert.equal(p.protocols[1].sendEmptyMessage, true);
  for (let i = 2; i < 6; i++) {
    assert.equal(Object.hasOwn(p.protocols[i], "sendEmptyMessage"), false);
    assert.equal(Object.hasOwn(p.protocols[i], "templateMode"), false);
    assert.equal(
      Buffer.from(
        p.protocols[i].message.data,
        p.protocols[i].message.encoding,
      ).toString("hex"),
      expected[i].hex,
    );
  }
}
async function artifact(f, p, format) {
  const selection = scope(format),
    preview = await f.post(p, "export-preview", selection);
  return (await f.post(p, "export-selection", accept(selection, preview)))
    .document;
}
async function manual(f, p, format, document) {
  const input = inputFor(format, document),
    preview = await f.post(p, "import-preview", input);
  assert.deepEqual(preview.blockers, []);
  return f.post(p, "import-apply", { input, token: preview.token });
}
async function frozen(f, p) {
  const saved = await f.get(p.id);
  return f.post(p, "plans", {
    name: "Frozen full binary group",
    steps: saved.protocols.map((definition, i) => ({
      id: "wire-" + i,
      type: "protocol",
      expectedStatus: "partial",
      protocol: { definition, duration: 1000, maxMessages: 1 },
    })),
  });
}
for (const format of ["apipost", "apipost-directory"])
  test(
    `owner ${format}: native binary scoped/manual two generations, history, backup and frozen byte wire`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t),
        sourceBefore = await bytes(f.app.store.directory(f.source.id)),
        peerBefore = await bytes(f.app.store.directory(f.untouched.id));
      const before = await f.get(f.target.id),
        document = await artifact(f, f.source, format),
        input = inputFor(format, document);
      // Unsupported raw HTTP is deliberately unselected; use all-empty protocol scope only after import.
      const preview = await f.post(f.target, "import-preview", input);
      assert.deepEqual(preview.blockers, []);
      const sourceScope = scope(format),
        sourcePreview = await f.post(f.source, "export-preview", sourceScope);
      const targetBytes = await bytes(f.app.store.directory(f.target.id));
      await f.post(
        f.source,
        "export-selection",
        accept(sourceScope, sourcePreview),
      );
      assert.deepEqual(
        await bytes(f.app.store.directory(f.target.id)),
        targetBytes,
      );
      await f.post(f.target, "import-apply", { input, token: preview.token });
      let saved = await f.get(f.target.id);
      retained(saved, before);
      binaryModel(saved);
      const firstTargetArtifact = await artifact(f, f.target, format);
      const negativeBytes = await bytes(f.root);
      for (const invalid of [
        { mode: "binary", raw: "AA==" },
        { mode: "base64", raw: "AA==\n" },
        { mode: "hexadecimal", raw: "00 ff" },
        { mode: "base64", raw: "{{value}}" },
        { mode: "base64", raw: "AA==", compress: true },
      ]) {
        const malformed = structuredClone(f.document);
        malformed.apis[0].message[2].request = invalid;
        await f.post(f.target, "import", { document: malformed }, 400);
        await f.post(
          f.target,
          "import-preview",
          inputFor("apipost", malformed),
          400,
        );
      }
      for (const mutate of [
        (p) => p.protocols.splice(2, 1),
        (p) => {
          p.protocols[2].id = p.protocols[3].id;
        },
        (p) => {
          p.protocols[2].message.data = "AQ==";
        },
        (p) => {
          p.settings.apipostProtocolSources[0].source.message[2].param_id =
            p.settings.apipostProtocolSources[0].source.message[3].param_id;
        },
      ]) {
        const changed = structuredClone(saved);
        mutate(changed);
        const snapshot = structuredClone(changed);
        assert.throws(() => previewDefinitionExport(changed, scope(format)));
        assert.deepEqual(changed, snapshot);
      }
      assert.deepEqual(await bytes(f.root), negativeBytes);
      const oldPreview = await f.post(f.target, "export-preview", sourceScope),
        staleExport = accept(sourceScope, oldPreview);
      // A second native group changes configuration through the manual writer.
      const secondDocument = binaryExportFixture(
        f.document.apis[0].url,
        "second-source",
      );
      secondDocument.apis[0].target_id = "second-ws";
      const staleImport = await f.post(f.target, "import-preview", input);
      await manual(f, f.target, "apipost", secondDocument);
      const afterChange = await bytes(f.app.store.directory(f.target.id));
      await f.post(f.target, "export-selection", staleExport, 400);
      await f.post(
        f.target,
        "import-apply",
        { input, token: staleImport.token },
        400,
      );
      await f.post(
        f.target,
        "import-apply",
        { input, token: preview.token },
        400,
      );
      assert.deepEqual(
        await bytes(f.app.store.directory(f.target.id)),
        afterChange,
      );
      retained(await f.get(f.target.id), before);
      // The next two generations descend from the manual target, not the original source.
      let current = f.target;
      for (let generation = 0; generation < 2; generation++) {
        const d =
            generation === 0
              ? firstTargetArtifact
              : await artifact(f, current, format),
          next = await f.app.store.create("Generation " + generation);
        await manual(f, next, format, d);
        binaryModel(await f.get(next.id));
        current = next;
      }
      await f.post(current, "export?format=" + format); // Full native export is valid before any native protocol plan exists.
      await f.restart();
      binaryModel(await f.get(current.id));
      f.noEffects();
      const plan = await frozen(f, current),
        frozenBefore = (await f.get(current.id)).plans;
      await f.post(current, "export?format=" + format, undefined, 400); // Never delete plans to manufacture an export pass.
      const backup = await f.post(current, "export"),
        restored = await f.owner("/restore", { document: backup }, 201);
      assert.notEqual(restored.id, current.id);
      assert.deepEqual(restored.plans, frozenBefore);
      await f.restart();
      f.noEffects();
      for (const definition of (await f.get(restored.id)).protocols)
        await f.post(restored, "protocol", {
          definitionId: definition.id,
          duration: 1000,
          maxMessages: 1,
        });
      assert.deepEqual(f.frames, expected);
      f.noEffects(6);
      const liveChanged = await f.get(restored.id);
      liveChanged.protocols[2].message = { encoding: "hex", data: "deadbeef" };
      await f.app.store.save(liveChanged);
      const run = await f.post(restored, "run", { planId: plan.id });
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.deepEqual(f.frames, [...expected, ...expected]);
      f.noEffects(12);
      assert.deepEqual((await f.get(restored.id)).plans, frozenBefore);
      retained(await f.get(f.target.id), before);
      assert.deepEqual(
        await bytes(f.app.store.directory(f.source.id)),
        sourceBefore,
      );
      assert.deepEqual(
        await bytes(f.app.store.directory(f.untouched.id)),
        peerBefore,
      );
      assert.deepEqual(f.document, f.original);
    },
  );
for (const kind of ["HTTP", "stdio"])
  test(
    `official ${kind} SDK: binary import/export grants, session rejection, frozen explicit execution`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t),
        format = kind === "HTTP" ? "apipost" : "apipost-directory";
      const document = await artifact(f, f.source, format),
        input = inputFor(format, document);
      const before = await f.get(f.target.id),
        sourceBytes = await bytes(f.app.store.directory(f.source.id)),
        peerBytes = await bytes(f.app.store.directory(f.untouched.id));
      const first = await f.connect(kind, f.target, true),
        second = await f.connect(kind, f.target, true);
      const preview = decode(
        await tool(first, f.target.id, "preview_import", { input }),
      );
      assert.deepEqual(preview.blockers, []);
      const priorBytes = await bytes(f.app.store.directory(f.target.id));
      for (const [client, id, args] of [
        [second, f.target.id, { input, token: preview.token }],
        [first, f.untouched.id, { input, token: preview.token }],
        [
          first,
          f.target.id,
          {
            input: { ...input, selection: { mode: "explicit", keys: [] } },
            token: preview.token,
          },
        ],
      ])
        assert.equal(
          (await tool(client, id, "apply_import", args)).isError,
          true,
        );
      assert.deepEqual(
        await bytes(f.app.store.directory(f.target.id)),
        priorBytes,
      );
      decode(
        await tool(first, f.target.id, "apply_import", {
          input,
          token: preview.token,
        }),
      );
      binaryModel(await f.get(f.target.id));
      retained(await f.get(f.target.id), before);
      // Read-only export operations do not consume the pending writer preview token.
      const pendingInput = {
        ...input,
        selection: { mode: "explicit", keys: [] },
      };
      const pending = decode(
        await tool(first, f.target.id, "preview_import", {
          input: pendingInput,
        }),
      );
      const pendingScope = scope(format),
        pendingExport = decode(
          await tool(
            first,
            f.target.id,
            "preview_project_export",
            pendingScope,
          ),
        );
      decode(
        await tool(
          first,
          f.target.id,
          "export_project_selection",
          accept(pendingScope, pendingExport),
        ),
      );
      decode(
        await tool(first, f.target.id, "apply_import", {
          input: pendingInput,
          token: pending.token,
        }),
      );
      const read = await f.connect(kind, f.target, false);
      const names = (await read.listTools()).tools.map((x) => x.name);
      assert.ok(names.includes("localapi_export_project_selection"));
      assert.equal(names.includes("localapi_apply_import"), false);
      assert.equal(names.includes("localapi_execute_flow"), false);
      const selection = scope(format),
        p = decode(
          await tool(read, f.target.id, "preview_project_export", selection),
        );
      const exported = decode(
        await tool(
          read,
          f.target.id,
          "export_project_selection",
          accept(selection, p),
        ),
      );
      const noOpInput = { ...input, selection: { mode: "explicit", keys: [] } },
        noOp = decode(
          await tool(read, f.target.id, "preview_import", { input: noOpInput }),
        );
      const readBytes = await bytes(f.app.store.directory(f.target.id));
      assert.equal(
        (
          await tool(read, f.target.id, "apply_import", {
            input: noOpInput,
            token: noOp.token,
          })
        ).isError,
        true,
      );
      assert.equal(
        (await tool(read, f.target.id, "execute_flow", { planId: "absent" }))
          .isError,
        true,
      );
      assert.deepEqual(
        await bytes(f.app.store.directory(f.target.id)),
        readBytes,
      );
      const copy = await f.app.store.create("SDK export generation");
      await manual(f, copy, format, exported.document);
      binaryModel(await f.get(copy.id));
      const plan = await frozen(f, f.target),
        frozenPlans = (await f.get(f.target.id)).plans;
      const writer = await f.connect(kind, f.target, true, false);
      const writerBytes = await bytes(f.app.store.directory(f.target.id));
      assert.equal(
        (await tool(writer, f.target.id, "execute_flow", { planId: plan.id }))
          .isError,
        true,
      );
      assert.deepEqual(
        await bytes(f.app.store.directory(f.target.id)),
        writerBytes,
      );
      f.noEffects();
      const changedLive = await f.get(f.target.id);
      changedLive.protocols[2].message = { encoding: "hex", data: "deadbeef" };
      await f.app.store.save(changedLive);
      const executor = await f.connect(kind, f.target, true, true);
      const result = decode(
        await tool(executor, f.target.id, "execute_flow", { planId: plan.id }),
      );
      assert.equal(result.status, "passed", JSON.stringify(result));
      assert.deepEqual(f.frames, expected);
      f.noEffects(6);
      const after = await f.get(f.target.id);
      retained(
        {
          ...after,
          plans: after.plans.filter((p) =>
            before.plans.some((old) => old.id === p.id),
          ),
        },
        before,
      );
      assert.deepEqual(after.plans, frozenPlans);
      const backup = await f.post(f.target, "export"),
        restored = await f.owner("/restore", { document: backup }, 201);
      assert.notEqual(restored.id, f.target.id);
      assert.deepEqual(restored.plans, frozenPlans);
      await f.restart();
      assert.deepEqual((await f.get(restored.id)).plans, frozenPlans);
      f.noEffects(6);
      assert.deepEqual(
        await bytes(f.app.store.directory(f.source.id)),
        sourceBytes,
      );
      assert.deepEqual(
        await bytes(f.app.store.directory(f.untouched.id)),
        peerBytes,
      );
    },
  );
