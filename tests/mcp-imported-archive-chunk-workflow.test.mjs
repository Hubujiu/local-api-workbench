// ROOT acceptance uses synthetic data derived from the legal directory fixture.
// No original executable, archived script, VM, database, or execution tool runs.
// The production 8 MiB writer and the accepted 4 MiB archive cap stay unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { makeWireRecord, prepareWireExecution } from "../src/wire-evidence.mjs";

const MiB = 1024 * 1024;
const toolName = "localapi_get_imported_execution_run";
const sourceId = "synthetic-source-large";
const otherSourceId = "synthetic-source-small";
const runId = "synthetic-run-shared";
const archivePath = "executions/runs/" + runId + ".json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const argsFor = (projectId, sourceProjectId = sourceId) => ({
  projectId,
  sourceProjectId,
  runId,
});
const call = (client, args) =>
  client.callTool({ name: toolName, arguments: args });
const chunk = async (client, args, options = {}) =>
  decode(
    await call(client, { ...args, chunk: { offsetBytes: 0, ...options } }),
  );
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

async function syntheticDirectory(endpoint, sourceProjectId, heavy = false) {
  const files = [];
  for (const [directory, prefix] of [
    ["directory/", ""],
    ["executions/", "executions/"],
  ]) {
    const base = new URL(
      "./fixtures/original-offline2/" + directory,
      import.meta.url,
    );
    for (const file of (await readdir(base, { recursive: true })).filter((p) =>
      p.endsWith(".json"),
    )) {
      const relative = file.replaceAll("\\", "/");
      files.push({
        path: prefix + relative,
        text: await readFile(new URL(relative, base), "utf8"),
      });
    }
  }
  const originalIndex = JSON.parse(
    files.find((f) => f.path === "executions/runs/index.json").text,
  );
  const originalMeta = originalIndex.records[0];
  const originalId = originalMeta.run_id;
  const kept = files.filter(
    (f) =>
      !f.path.startsWith("executions/runs/") ||
      f.path === "executions/runs/index.json" ||
      f.path === originalMeta.detail_file,
  );
  for (const file of kept) {
    file.path = file.path.replaceAll(originalId, runId);
    file.text = file.text
      .replaceAll(originalMeta.project_id, sourceProjectId)
      .replaceAll(originalId, runId)
      .replaceAll("http://127.0.0.1:18766", endpoint);
  }
  const index = kept.find((f) => f.path === "executions/runs/index.json");
  index.text = JSON.stringify({
    version: 2,
    records: [JSON.parse(index.text).records[0]],
  });
  const file = kept.find((f) => f.path === archivePath);
  const record = JSON.parse(file.text);
  // 400,000 legal JSON values exceed the unrelated PR16 parsed-node cap.
  // Their 1e20 source lexeme expands 4.4x when the old API reserializes it.
  record.steps[0].input.body.numbers = heavy ? Array(400000).fill(1e20) : [];
  record.steps[0].input.body.rawProbe = "raw雪🧪";
  record.steps[0].input.body.lexemes = "RAW_NUMBER_LEXEMES";
  record.steps[0].input.body.syntheticMarker = heavy ? "heavy" : "small";
  file.text =
    " \n\t" +
    JSON.stringify(record)
      .replaceAll("100000000000000000000", "1e20")
      .replace('"raw雪🧪"', '"raw\\u96ea🧪"')
      .replace('"RAW_NUMBER_LEXEMES"', "[-0,1.000,1E+02]") +
    "\n ";
  const document = { format: "apipost-offline-directory-v1", files: kept };
  const total = kept.reduce(
    (n, f) => n + Buffer.byteLength(f.text) + f.path.length,
    0,
  );
  assert(
    total < 4 * MiB,
    "the real native directory input remains accepted and bounded",
  );
  return { document, text: file.text, bytes: Buffer.from(file.text, "utf8") };
}

async function projectDisk(root, projectId) {
  const files = {};
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, projectId, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else
        files[name] = sha256(await readFile(path.join(root, projectId, name)));
    }
  }
  await visit("");
  return files;
}

const sourceText = (project, sourceProjectId = sourceId) =>
  project.settings.apipostDirectoryArtifacts
    .find((s) => s.sourceProjectId === sourceProjectId)
    ?.files.find((f) => f.path === archivePath)?.text;

async function reconstruct(client, ids, expected, defaultFirst = false) {
  const pieces = [];
  const expectedArtifactSha256 = sha256(expected);
  let offsetBytes = 0;
  do {
    const maxBytes = defaultFirst && offsetBytes === 0 ? undefined : 256 * 1024;
    const result = await chunk(client, ids, {
      offsetBytes,
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(offsetBytes ? { expectedArtifactSha256 } : {}),
    });
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        "artifactSha256",
        "chunk",
        "executedByWorkbench",
        "projectId",
        "provenance",
        "runId",
        "sourceProjectId",
      ].sort(),
    );
    assert.equal(result.provenance, "imported-apipost-archive");
    assert.equal(result.executedByWorkbench, false);
    for (const [key, value] of Object.entries(ids))
      assert.equal(result[key], value);
    assert.equal(result.artifactSha256, expectedArtifactSha256);
    const part = result.chunk;
    assert.deepEqual(
      Object.keys(part).sort(),
      [
        "version",
        "encoding",
        "mediaType",
        "offsetBytes",
        "chunkBytes",
        "totalBytes",
        "nextOffsetBytes",
        "eof",
        "data",
      ].sort(),
    );
    assert.equal(part.version, 1);
    assert.equal(part.encoding, "base64");
    assert.equal(part.mediaType, "application/json");
    assert.equal(part.offsetBytes, offsetBytes);
    assert.equal(part.totalBytes, expected.length);
    const bytes = Buffer.from(part.data, "base64");
    assert.equal(bytes.toString("base64"), part.data);
    assert.equal(part.chunkBytes, bytes.length);
    assert.equal(
      bytes.length,
      Math.min(maxBytes ?? 65536, expected.length - offsetBytes),
    );
    assert.deepEqual(
      bytes,
      expected.subarray(offsetBytes, offsetBytes + bytes.length),
    );
    assert.equal(part.nextOffsetBytes, offsetBytes + bytes.length);
    assert.equal(part.eof, part.nextOffsetBytes === expected.length);
    assert(
      Buffer.byteLength(
        serializeMessage({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        }),
      ) < 400000,
    );
    pieces.push(bytes);
    offsetBytes = part.nextOffsetBytes;
    if (part.eof) break;
    assert(bytes.length > 0);
  } while (offsetBytes < expected.length);
  const actual = Buffer.concat(pieces);
  assert.deepEqual(
    actual,
    expected,
    "exact raw UTF-8 bytes, not parse/stringify equivalence",
  );
  assert.equal(sha256(actual), expectedArtifactSha256);
  const eof = await chunk(client, ids, { offsetBytes, expectedArtifactSha256 });
  assert.equal(eof.chunk.eof, true);
  assert.equal(eof.chunk.data, "");
  assert.equal(eof.chunk.chunkBytes, 0);
  assert.equal(eof.chunk.nextOffsetBytes, expected.length);
  return pieces.length;
}

async function rejected(client, args, options = {}) {
  const result = await call(client, {
    ...args,
    chunk: { offsetBytes: 0, ...options },
  });
  assert.equal(result.isError, true);
  const message = result.content?.[0]?.text || "";
  assert(message.length > 0 && message.length < 1024);
  assert.doesNotMatch(
    message,
    /PRIVATE-ARGUMENT|rawProbe|syntheticMarker|"data"|chunkBytes/,
  );
  await client.ping();
}

test(
  "synthetic native archives cross the real stdio writer boundary, then raw SDK chunks survive owner import, isolated restore and restart without execution",
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(tmpdir(), "imported-archive-workflow-"),
    );
    let network = 0;
    const peer = http.createServer((_req, res) => {
      network++;
      res.end("must not execute");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    let app = await createApp({ root, port: 0 });
    const clients = [];
    const closeClients = async () => {
      await Promise.all(
        clients.splice(0).map((c) => c.close().catch(() => {})),
      );
    };
    t.after(async () => {
      await closeClients();
      await closeServer(app.server);
      await closeServer(peer);
      await rm(root, { recursive: true, force: true });
    });
    const owner = async (route, body) => {
      const response = await fetch(app.url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert(response.ok, await response.clone().text());
      return response.json();
    };
    const project = await owner("/api/projects", {
      name: "Synthetic imported archive acceptance",
    });
    const denied = await owner("/api/projects", {
      name: "Existing unauthorized project",
    });
    const endpoint = `http://127.0.0.1:${peer.address().port}`;
    const heavy = await syntheticDirectory(endpoint, sourceId, true);
    const small = await syntheticDirectory(endpoint, otherSourceId);
    // Actual owner HTTP native import, not a fabricated Store/mocked helper.
    await owner(`/api/projects/${project.id}/import`, {
      document: heavy.document,
    });
    await owner(`/api/projects/${project.id}/import`, {
      document: small.document,
    });
    await owner(`/api/projects/${denied.id}/import`, {
      document: small.document,
    });
    let persisted = await new Store(root).get(project.id);
    assert.equal(sourceText(persisted), heavy.text);
    assert.equal(sourceText(persisted, otherSourceId), small.text);
    assert.equal(
      JSON.parse(heavy.text).steps[0].input.body.numbers.length,
      400000,
    );
    assert.deepEqual(
      [persisted.history, persisted.runs, persisted.protocolRuns],
      [[], [], []],
    );
    assert.equal(network, 0);
    const clean = await projectDisk(root, project.id);
    const configure = (projects = [project.id]) =>
      owner("/api/mcp/config", {
        enabled: true,
        projects,
        remember: true,
        write: false,
        execute: false,
      });
    const config = await configure();
    const connect = async (kind, grant = project.id) => {
      const c = new Client(
        { name: "imported-archive-workflow-" + kind, version: "1" },
        { capabilities: {} },
      );
      clients.push(c);
      await c.connect(
        kind === "stdio"
          ? new StdioClientTransport({
              command: process.execPath,
              args: [
                fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
                "--project",
                grant,
              ],
              env: { LOCAL_API_DATA: root },
              stderr: "pipe",
            })
          : new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
              requestInit: {
                headers: { Authorization: "Bearer " + config.token },
              },
            }),
      );
      return c;
    };
    const stdio = await connect("stdio");
    const httpClient = await connect("http");
    const ids = argsFor(project.id);
    const fullExpected = {
      provenance: "imported-apipost-archive",
      executedByWorkbench: false,
      ...ids,
      artifactSha256: sha256(heavy.bytes),
      original: JSON.parse(heavy.text),
    };
    const fullFrameBytes = Buffer.byteLength(
      serializeMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify(fullExpected) }],
        },
      }),
    );
    assert(
      fullFrameBytes > 8 * MiB,
      "must cross the actual unchanged production writer limit",
    );
    await assert.rejects(
      call(stdio, ids),
      /Execution\/progress\/output failed; inspect history, do not replay/,
    );
    await stdio.ping();
    // Legacy no-chunk HTTP read retains the complete object and provenance.
    const legacyHTTP = decode(await call(httpClient, ids));
    assert.deepEqual(legacyHTTP, JSON.parse(JSON.stringify(fullExpected)));
    assert(
      Object.is(JSON.parse(heavy.text).steps[0].input.body.lexemes[0], -0),
    );
    assert(Object.is(legacyHTTP.original.steps[0].input.body.lexemes[0], 0));
    const stdioChunks = await reconstruct(stdio, ids, heavy.bytes, true);
    const httpChunks = await reconstruct(httpClient, ids, heavy.bytes);
    const sameRunOtherSource = argsFor(project.id, otherSourceId);
    await reconstruct(stdio, sameRunOtherSource, small.bytes);
    assert.deepEqual(
      decode(await call(stdio, sameRunOtherSource)).original,
      JSON.parse(JSON.stringify(JSON.parse(small.text))),
    );
    const first = await chunk(httpClient, ids);
    const continuation = {
      offsetBytes: first.chunk.nextOffsetBytes,
      expectedArtifactSha256: first.artifactSha256,
    };
    // A hash identifies content only; it never grants project/source access.
    await rejected(httpClient, argsFor(denied.id, otherSourceId), {
      expectedArtifactSha256: sha256(small.bytes),
    });
    await rejected(stdio, argsFor(denied.id, otherSourceId), {
      expectedArtifactSha256: sha256(small.bytes),
    });
    await rejected(httpClient, sameRunOtherSource, continuation);
    const split = heavy.bytes.indexOf(Buffer.from("🧪")) + 1;
    assert(split > 0);
    assert.deepEqual(
      Buffer.from(
        (
          await chunk(stdio, ids, {
            offsetBytes: split,
            maxBytes: 1,
            expectedArtifactSha256: first.artifactSha256,
          })
        ).chunk.data,
        "base64",
      ),
      heavy.bytes.subarray(split, split + 1),
    );
    for (const invalid of [
      { offsetBytes: -1 },
      { offsetBytes: 0.5 },
      { offsetBytes: "PRIVATE-ARGUMENT" },
      { offsetBytes: Number.MAX_SAFE_INTEGER + 1 },
      { offsetBytes: 1 },
      {
        offsetBytes: heavy.bytes.length + 1,
        expectedArtifactSha256: first.artifactSha256,
      },
      { maxBytes: 0 },
      { maxBytes: 262145 },
      { expectedArtifactSha256: "0".repeat(64) },
      { expectedArtifactSha256: "PRIVATE-ARGUMENT" },
    ])
      await rejected(httpClient, ids, invalid);
    await rejected(httpClient, {
      ...ids,
      sourceProjectId: "PRIVATE-ARGUMENT-missing",
    });
    await rejected(stdio, { ...ids, runId: "PRIVATE-ARGUMENT-missing" });
    assert.deepEqual(
      await projectDisk(root, project.id),
      clean,
      "clean Store reads must not rewrite any project file",
    );
    assert.equal(
      network,
      0,
      "archive reads must not execute requests or replay evidence",
    );

    const backup = await owner(`/api/projects/${project.id}/export`);
    const restored = await owner("/api/restore", { document: backup });
    assert.notEqual(restored.id, project.id);
    await rejected(httpClient, argsFor(restored.id), {
      expectedArtifactSha256: first.artifactSha256,
    });
    await rejected(stdio, argsFor(restored.id), {
      expectedArtifactSha256: first.artifactSha256,
    });
    await configure([project.id, restored.id]);
    assert.equal(
      sourceText(await new Store(root).get(restored.id)),
      heavy.text,
    );
    await reconstruct(httpClient, argsFor(restored.id), heavy.bytes);
    const independentlyGranted = await connect("stdio", restored.id);
    await reconstruct(independentlyGranted, argsFor(restored.id), heavy.bytes);
    const restoredClean = await projectDisk(root, restored.id);
    await closeClients();
    await closeServer(app.server);
    app = await createApp({ root, port: 0 });
    const restartedHTTP = await connect("http");
    const restartedStdio = await connect("stdio");
    assert.deepEqual(
      Buffer.from(
        (await chunk(restartedHTTP, ids, continuation)).chunk.data,
        "base64",
      ),
      heavy.bytes.subarray(65536, 131072),
    );
    await reconstruct(restartedStdio, ids, heavy.bytes);
    await reconstruct(restartedHTTP, argsFor(restored.id), heavy.bytes);
    assert.deepEqual(await projectDisk(root, project.id), clean);
    assert.deepEqual(await projectDisk(root, restored.id), restoredClean);
    persisted = await new Store(root).get(project.id);
    assert.deepEqual(
      [persisted.history, persisted.runs, persisted.protocolRuns],
      [[], [], []],
    );
    assert.equal(network, 0);
    t.diagnostic(
      `synthetic raw ${heavy.bytes.length} bytes; legacy full frame ${fullFrameBytes} bytes; stdio ${stdioChunks} chunks; HTTP ${httpChunks} chunks; archive network calls 0`,
    );

    // Stateful interruptions use the same already initialized SDK sessions.
    await configure([restored.id]);
    await rejected(restartedHTTP, ids, continuation);
    await configure([project.id, restored.id]);
    const edit = async (change) => {
      const latest = await app.store.get(project.id);
      change(latest);
      await app.store.save(latest, { activity: true });
    };
    await edit((p) => {
      p.archived = true;
    });
    await rejected(restartedHTTP, ids, continuation);
    await rejected(restartedStdio, ids, continuation);
    await edit((p) => {
      p.archived = false;
    });
    await edit((p) => {
      const artifact = p.settings.apipostDirectoryArtifacts
        .find((s) => s.sourceProjectId === sourceId)
        .files.find((f) => f.path === archivePath);
      artifact.text += " \n";
    });
    await rejected(restartedHTTP, ids, continuation);
    await rejected(restartedStdio, ids, {
      expectedArtifactSha256: first.artifactSha256,
    });
    const changed = await chunk(restartedHTTP, ids);
    assert.notEqual(changed.artifactSha256, first.artifactSha256);
    assert.equal(changed.chunk.totalBytes, heavy.bytes.length + 2);

    // Independent namespaces deliberately collide. Imported reads still use the
    // exact project/source/run triple, never history, runs, or protocol evidence.
    await edit((p) => {
      p.history.push({ id: runId, response: { body: "local API namespace" } });
      p.runs.push({ id: runId, results: [] });
      // Construct only a valid synthetic collision record; no protocol is sent.
      const prepared = prepareWireExecution(p, {
        type: "tcp",
        host: "127.0.0.1",
        port: 9,
        message: "synthetic namespace only",
      });
      const protocol = makeWireRecord(
        prepared,
        runId,
        Date.now(),
        null,
        Error("Synthetic fixture; never executed"),
        false,
      );
      p.protocolRuns.push({ ...protocol, id: runId });
    });
    assert.equal(
      (await chunk(restartedHTTP, ids)).artifactSha256,
      changed.artifactSha256,
    );
    await reconstruct(restartedStdio, sameRunOtherSource, small.bytes);
    await edit((p) => {
      p.settings.apipostDirectoryArtifacts =
        p.settings.apipostDirectoryArtifacts.filter(
          (s) => s.sourceProjectId !== sourceId,
        );
    });
    await rejected(restartedHTTP, ids, {
      offsetBytes: changed.chunk.nextOffsetBytes,
      expectedArtifactSha256: changed.artifactSha256,
    });
    await rejected(restartedStdio, ids);
    await reconstruct(restartedHTTP, sameRunOtherSource, small.bytes);

    // External persisted corruption is detected on the next piece, with recovery
    // on the same session after the owner restores valid bytes.
    const settingsPath = path.join(
      root,
      project.id,
      "settings",
      "project.json",
    );
    const settingsBefore = await readFile(settingsPath);
    const corrupt = JSON.parse(settingsBefore);
    corrupt.apipostDirectoryArtifacts[0].files.find(
      (f) => f.path === archivePath,
    ).text = '{"PRIVATE-ARGUMENT":';
    await writeFile(settingsPath, JSON.stringify(corrupt));
    await rejected(restartedHTTP, sameRunOtherSource);
    await rejected(restartedStdio, sameRunOtherSource);
    await writeFile(settingsPath, settingsBefore);
    await reconstruct(restartedStdio, sameRunOtherSource, small.bytes);
    const invalidIdentity = JSON.parse(settingsBefore);
    const wrongFile = invalidIdentity.apipostDirectoryArtifacts[0].files.find(
      (f) => f.path === archivePath,
    );
    const wrongRecord = JSON.parse(wrongFile.text);
    wrongRecord.run_id = "different-run-identity";
    wrongFile.text = JSON.stringify(wrongRecord);
    await writeFile(settingsPath, JSON.stringify(invalidIdentity));
    await rejected(restartedHTTP, sameRunOtherSource);
    await rejected(restartedStdio, sameRunOtherSource);
    await writeFile(settingsPath, settingsBefore);
    await reconstruct(restartedHTTP, sameRunOtherSource, small.bytes);
    await rm(path.join(root, project.id), { recursive: true });
    await rejected(restartedHTTP, sameRunOtherSource);
    await rejected(restartedStdio, sameRunOtherSource);
    await reconstruct(
      restartedHTTP,
      argsFor(restored.id, otherSourceId),
      small.bytes,
    );
    assert.equal(network, 0);
  },
);
