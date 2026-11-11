import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { importIntoProject } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";
import { nativeAutomationRejectionFixture } from "./fixtures/native-automation-rejection.mjs";

function assertNoToken(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(
    Object.hasOwn(value, "token"),
    false,
    "failed preview must not return a token",
  );
  for (const child of Object.values(value)) assertNoToken(child);
}

async function disk(root) {
  const result = {};
  for (const name of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!name.isFile()) continue;
    const file = path.join(name.parentPath, name.name);
    result[path.relative(root, file)] = (await readFile(file)).toString(
      "base64",
    );
  }
  return result;
}

test("synthetic complete native automation is atomically rejected by direct, owner and official MCP import entrypoints", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "native-automation-reject-"));
  let hits = 0;
  const peer = http.createServer((_req, res) => {
    hits++;
    res.end("must not run");
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  const app = await createApp({ root, port: 0 });
  const client = new Client({
    name: "synthetic-native-rejection",
    version: "1",
  });
  t.after(async () => {
    await client.close();
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    peer.closeAllConnections();
    await new Promise((r) => peer.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("existing destination");
  const other = await app.store.create("untouched project");
  const endpoint = `http://127.0.0.1:${peer.address().port}`;
  const original = nativeAutomationRejectionFixture(endpoint);
  // Positive control: the complete surrounding modern project is accepted.
  // Therefore rejection below is not caused by an incomplete project envelope.
  const supported = structuredClone(original);
  supported.automated_testings = [];
  const control = structuredClone(project);
  importIntoProject(control, supported);
  assert.equal(control.requests.length, 7);
  assert.equal(hits, 0);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
        "--project",
        project.id,
        "--write",
      ],
      env: { LOCAL_API_DATA: root },
      stderr: "pipe",
    }),
  );
  const tools = (await client.listTools()).tools.map((x) => x.name);
  for (const name of [
    "localapi_import_project",
    "localapi_preview_import",
    "localapi_apply_import",
  ])
    assert.ok(tools.includes(name));
  const before = await app.store.get(project.id);
  const otherBefore = await app.store.get(other.id);
  const persisted = await disk(root);
  const unchanged = async () => {
    assert.deepEqual(await app.store.get(project.id), before);
    assert.deepEqual(await app.store.get(other.id), otherBefore);
    assert.deepEqual(await disk(root), persisted);
    assert.equal(hits, 0);
  };
  const acceptedInput = {
    format: "apipost",
    document: supported,
    selection: { mode: "all" },
  };
  const ownerPreview = await fetch(
    `${app.url}/api/projects/${project.id}/import-preview`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(acceptedInput),
    },
  );
  assert.equal(ownerPreview.status, 200);
  const ownerToken = (await ownerPreview.json()).token;
  assert.equal(typeof ownerToken, "string");
  const mcpPreview = await client.callTool({
    name: "localapi_preview_import",
    arguments: {
      projectId: project.id,
      input: acceptedInput,
    },
  });
  assert.notEqual(mcpPreview.isError, true, mcpPreview.content[0].text);
  const mcpToken = JSON.parse(mcpPreview.content[0].text).token;
  assert.equal(typeof mcpToken, "string");
  await unchanged();
  const variants = [
    ["observed root structure", () => {}],
    [
      "sort conflict (semantics deliberately unknown)",
      (s) => {
        s.automated_testings[0].event_list[1].sort = 1;
      },
    ],
    [
      "unknown schedule (never inferred)",
      (s) => {
        s.automated_testings[0].scenario = "synthetic-unknown-schedule";
      },
    ],
  ];
  for (const [label, mutate] of variants) {
    const document = structuredClone(original);
    mutate(document);
    const sourceBefore = structuredClone(document);
    const draft = structuredClone(before);
    assert.throws(
      () => importIntoProject(draft, document),
      /automated_testings/,
      label,
    );
    assert.deepEqual(draft, before);
    const input = { format: "apipost", document, selection: { mode: "all" } };
    for (const [action, body] of [
      ["import", { document }],
      ["import-preview", input],
    ]) {
      const response = await fetch(
        `${app.url}/api/projects/${project.id}/${action}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-local-token": app.token,
          },
          body: JSON.stringify(body),
        },
      );
      assert.equal(response.status, 400, label + " owner " + action);
      const responseBody = await response.json();
      if (action === "import-preview") assertNoToken(responseBody);
      assert.match(
        JSON.stringify(responseBody),
        action === "import" ? /automated_testings/ : /手动导入未完成/,
      );
      await unchanged();
    }
    for (const [name, args] of [
      ["localapi_import_project", { format: "apipost", document }],
      ["localapi_preview_import", { input }],
    ]) {
      const result = await client.callTool({
        name,
        arguments: { projectId: project.id, ...args },
      });
      assert.equal(result.isError, true, label + " " + name);
      if (name === "localapi_preview_import") {
        assertNoToken(result);
        assertNoToken(JSON.parse(result.content[0].text));
      }
      assert.match(
        result.content[0].text,
        name === "localapi_import_project"
          ? /automated_testings/
          : /MANUAL_IMPORT_INVALID/,
      );
      await unchanged();
    }
    // A valid preview for the supported source does not authorize replacement
    // with unsupported automation. Rejection may occur before the converter.
    const apply = await fetch(
      `${app.url}/api/projects/${project.id}/import-apply`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify({ input, token: ownerToken }),
      },
    );
    assert.equal(apply.status, 400);
    await apply.arrayBuffer();
    const denied = await client.callTool({
      name: "localapi_apply_import",
      arguments: {
        projectId: project.id,
        input,
        token: mcpToken,
      },
    });
    assert.equal(denied.isError, true);
    assert.deepEqual(document, sourceBefore);
    await unchanged();
  }
  const reopened = new Store(root);
  assert.deepEqual(await reopened.get(project.id), before);
  assert.deepEqual(await reopened.get(other.id), otherBefore);
  await unchanged();
});
