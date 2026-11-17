import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const secret = "fictional-saved-header-credential";
const selected = (ids) => ({
  format: "postman-collection-v2.1",
  selection: {
    mode: "explicit",
    resources: ids.map((id) => ({ kind: "api", id })),
  },
});
const accepted = (input, preview) => ({
  ...input,
  configRevision: preview.configRevision,
  scopeDigest: preview.scope.digest,
  acceptedDependencies: preview.scope.dependencies,
});
const decode = (response) => {
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return JSON.parse(response.content[0].text);
};
const leaves = (items) =>
  items.flatMap((item) => (item.item ? leaves(item.item) : [item]));
async function fixture(t) {
  const seen = [];
  const peer = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    seen.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      body,
    });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(tmpdir(), "postman-definition-")),
    base = `http://127.0.0.1:${peer.address().port}`;
  let app = await createApp({ root, port: 0 });
  const project = await app.store.create("Synthetic Postman definition export");
  project.folders = ["Selected", "Selected/Nested", "Excluded"];
  project.environments[0].variables = {
    who: "environment-secret-not-exported",
  };
  project.requests = [
    normalizeRequest({
      id: "first",
      name: "First",
      folder: "Selected/Nested",
      method: "POST",
      url: base + "/literal-target",
      headers: [
        { key: "Authorization", value: secret, enabled: true },
        { key: "Content-Type", value: "text/plain", enabled: true },
      ],
      bodyType: "raw",
      body: "literal {{who}} payload",
      inheritAuth: false,
      inheritGlobalParameters: false,
      inheritSharedScripts: false,
    }),
    normalizeRequest({
      id: "second",
      name: "Second",
      folder: "Selected/Nested",
      method: "GET",
      url: base + "/second",
      inheritAuth: false,
      inheritGlobalParameters: false,
      inheritSharedScripts: false,
    }),
    normalizeRequest({
      id: "excluded",
      name: "Excluded",
      folder: "Excluded",
      url: base + "/excluded",
      beforeScript: "throw Error('must-not-run')",
    }),
  ];
  await app.store.save(project);
  const clients = [];
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    for (const client of clients) await client.close();
    await stop();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    project,
    seen,
    get: (id) => app.store.get(id || project.id),
    save: (p) => app.store.save(p),
    create: (name) => app.store.create(name),
    restart: async () => {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    owner: async (action, body, status = 200, id = project.id) => {
      const url =
        action === "restore" ? "/api/restore" : `/api/projects/${id}/${action}`;
      const response = await fetch(app.url + url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.equal(response.status, status, JSON.stringify(data));
      return data;
    },
    connect: async () => {
      const client = new Client({
        name: "postman-definition-workflow",
        version: "1",
      });
      clients.push(client);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            path.resolve(import.meta.dirname, "../src/mcp.mjs"),
            "--project",
            project.id,
            "--write",
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        }),
      );
      return (name, args) =>
        client.callTool({
          name: "localapi_" + name,
          arguments: { projectId: project.id, ...args },
        });
    },
  };
}

test(
  "owner/MCP scoped Postman definition export preserves credentials, folder order and literal variables without leaking preview values",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      mcp = await f.connect(),
      before = await f.get();
    const input = selected(["first", "second"]);
    const preview = await f.owner("export-preview", input);
    assert.ok(preview.warnings.length);
    assert.ok(!JSON.stringify(preview).includes(secret));
    assert.equal(preview.document, undefined);
    await f.owner("export-selection", input, 400);
    const owner = await f.owner("export-selection", accepted(input, preview));
    const mp = decode(await mcp("preview_project_export", input));
    assert.ok(mp.warnings.length);
    assert.ok(!JSON.stringify(mp).includes(secret));
    assert.equal(mp.document, undefined);
    for (const value of [preview, mp]) {
      assert.equal(value.omittedConfiguration.independentlyReplayable, false);
      assert.equal(
        typeof value.omittedConfiguration.globalVariables,
        "boolean",
      );
      assert.ok(Array.isArray(value.omittedConfiguration.environments));
      for (const environment of value.omittedConfiguration.environments) {
        assert.deepEqual(Object.keys(environment).sort(), ["id", "kind"]);
        assert.equal(environment.kind, "environment");
        assert.ok(
          before.environments.some((saved) => saved.id === environment.id),
        );
      }
      assert.ok(
        !JSON.stringify(value).includes("environment-secret-not-exported"),
      );
    }
    const exported = decode(
      await mcp("export_project_selection", accepted(input, mp)),
    );
    for (const result of [owner, exported]) {
      const document = result.document,
        text = JSON.stringify(document);
      assert.equal(
        document.info.schema,
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      );
      assert.ok(text.includes(secret));
      assert.ok(text.includes("{{who}}"));
      assert.ok(!text.includes("environment-secret-not-exported"));
      assert.equal(document.environments, undefined);
      assert.equal(document.history, undefined);
      assert.equal(document.runs, undefined);
      assert.deepEqual(
        leaves(document.item).map((item) => item.name),
        ["First", "Second"],
      );
      assert.equal(document.item[0].name, "Selected");
      assert.equal(document.item[0].item[0].name, "Nested");
    }
    assert.deepEqual(await f.get(), before);
    assert.deepEqual(f.seen, []);
    const sourceForExecution = await f.get();
    sourceForExecution.environments[0].variables.who = "actual-loopback";
    await f.save(sourceForExecution);
    const sourceRun = await f.owner("execute", {
      request: sourceForExecution.requests[0],
      environmentId: sourceForExecution.environments[0].id,
    });
    assert.equal(sourceRun.outcome, "passed");
    const sourceWire = structuredClone(f.seen[0]);
    const target = await f.create("Reimported definition");
    await f.owner("import", { document: owner.document }, 200, target.id);
    const imported = await f.get(target.id);
    assert.deepEqual(
      imported.requests.map((r) => r.name),
      ["First", "Second"],
    );
    assert.equal(imported.requests[0].folder, "Selected/Nested");
    imported.environments[0].variables = { who: "actual-loopback" };
    await f.save(imported);
    const request = imported.requests[0];
    const run = await f.owner("execute", { request }, 200, target.id);
    assert.equal(run.outcome, "passed");
    const expected = {
      method: "POST",
      url: "/literal-target",
      authorization: secret,
      contentType: "text/plain",
      body: "literal actual-loopback payload",
    };
    assert.deepEqual(sourceWire, expected);
    assert.deepEqual(
      f.seen,
      [sourceWire, sourceWire],
      "source and reimported requests must produce identical wire payloads",
    );
    const targetInput = selected(imported.requests.map((r) => r.id));
    const targetPreview = await f.owner(
      "export-preview",
      targetInput,
      200,
      target.id,
    );
    const targetExport = await f.owner(
      "export-selection",
      accepted(targetInput, targetPreview),
      200,
      target.id,
    );
    const reexportedLeaves = leaves(targetExport.document.item);
    assert.deepEqual(
      reexportedLeaves.map((item) => item.name),
      ["First", "Second"],
    );
    assert.deepEqual(
      reexportedLeaves.map((item) => item.request),
      leaves(owner.document.item).map((item) => item.request),
    );
    assert.equal(f.seen.length, 2, "second definition export is inert");
    const plan = await f.owner(
      "plans",
      { name: "Frozen imported request", steps: [{ request }] },
      200,
      target.id,
    );
    const live = await f.get(target.id);
    live.requests[0].url = "http://127.0.0.1:1/wrong";
    await f.save(live);
    const backup = await f.owner("export", undefined, 200, target.id),
      restored = await f.owner("restore", { document: backup }, 201);
    await f.restart();
    assert.equal(f.seen.length, 2);
    const frozen = await f.owner("run", { planId: plan.id }, 200, restored.id);
    assert.equal(frozen.status, "passed");
    assert.deepEqual(f.seen, [expected, expected, expected]);
  },
);

test(
  "Postman definition export refuses stale previews and selected unsupported scripts or dynamic definitions without effects",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      mcp = await f.connect();
    const input = selected(["first"]),
      preview = await f.owner("export-preview", input);
    const mp = decode(await mcp("preview_project_export", input));
    const edit = await f.get();
    edit.requests[0].description = "Changed after preview";
    await f.save(edit);
    const before = await f.get();
    await f.owner("export-selection", accepted(input, preview), 400);
    assert.equal(
      (await mcp("export_project_selection", accepted(input, mp))).isError,
      true,
    );
    assert.deepEqual(await f.get(), before);
    assert.deepEqual(f.seen, []);
    for (const mutate of [
      ...[
        "/:id.json",
        "/:user-id",
        "/prefix/{{part}}",
        "/{{part}}.json",
        "/prefix{{part}}",
        "/safe?value={{part}}",
      ].map((suffix) => (request) => {
        request.url = f.base + suffix;
      }),
      (request) => {
        request.url = "{{baseUrl}}/safe";
      },
      (request) => {
        request.beforeScript = "throw Error('never execute')";
      },
      (request) => {
        request.graphqlVariableTemplate = { version: 1 };
      },
    ]) {
      const project = await f.get();
      project.requests = structuredClone(before.requests);
      mutate(project.requests[0]);
      await f.save(project);
      const snapshot = await f.get();
      const refused = await f.owner("export-preview", input, 400);
      assert.equal(refused.document, undefined);
      assert.ok(!JSON.stringify(refused).includes(secret));
      const result = await mcp("preview_project_export", input);
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.deepEqual(await f.get(), snapshot);
      assert.deepEqual(f.seen, []);
    }
    const inheritedProject = await f.get();
    inheritedProject.requests = structuredClone(before.requests);
    inheritedProject.requests[0].inheritAuth = true;
    inheritedProject.settings.globalAuth = {
      type: "bearer",
      token: "never-export-inherited-token",
    };
    await f.save(inheritedProject);
    const inheritedBefore = await f.get();
    await f.owner("export-preview", input, 400);
    assert.equal((await mcp("preview_project_export", input)).isError, true);
    assert.deepEqual(await f.get(), inheritedBefore);
    assert.deepEqual(f.seen, []);
    const protocolProject = await f.get();
    protocolProject.requests = structuredClone(before.requests);
    protocolProject.settings = structuredClone(before.settings);
    protocolProject.protocols = [
      {
        id: "ws-fixture",
        type: "websocket",
        name: "Unsupported websocket",
        folder: "Selected",
        url: "ws://127.0.0.1:1/not-opened",
        message: "never-send",
      },
    ];
    await f.save(protocolProject);
    const protocolBefore = await f.get();
    const protocolInput = {
      format: "postman-collection-v2.1",
      selection: {
        mode: "explicit",
        resources: [{ kind: "protocol-bundle", id: "definitions" }],
      },
    };
    await f.owner("export-preview", protocolInput, 400);
    assert.equal(
      (await mcp("preview_project_export", protocolInput)).isError,
      true,
    );
    assert.deepEqual(await f.get(), protocolBefore);
    assert.deepEqual(f.seen, []);
  },
);
