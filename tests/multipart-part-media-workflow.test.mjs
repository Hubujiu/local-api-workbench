// Real application/HTTP/SDK/CLI workflows: ordinary CI only, not local execution.
import test from "node:test";
import { stringify as yamlStringify } from "yaml";
import {
  formMedia,
  invalidEncodings,
  encodingDocument,
  mixedEncodingDocument,
} from "./fixtures/openapi-form-encoding.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { executeRequest } from "../src/runtime.mjs";
const media = 'Application/JSON; charset="utf-8"';
const payload = Buffer.from([0, 255, 13, 10, 1, 128]);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function files(root) {
  const out = {};
  for (const e of await readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      for (const [k, v] of Object.entries(await files(p)))
        out[e.name + "/" + k] = v;
    } else out[e.name] = (await readFile(p)).toString("base64");
  }
  return out;
}
function document(origin) {
  return {
    info: {
      name: "multipart source",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: "typed upload",
        request: {
          method: "POST",
          url: origin + "/upload",
          body: {
            mode: "formdata",
            formdata: [
              {
                key: "meta",
                type: "text",
                value: '{"label":"雪"}',
                contentType: media,
              },
              { key: "duplicate", type: "text", value: "one" },
              {
                key: "duplicate",
                type: "text",
                value: "two",
                contentType: "text/plain; charset=utf-8",
              },
              {
                key: "file",
                type: "file",
                src: "/never-read/source.dat",
                contentType: "application/x-fixture",
              },
              {
                key: "default-file",
                type: "file",
                src: "/never-read/default.dat",
              },
              {
                key: "disabled",
                type: "text",
                value: "must-not-send",
                disabled: true,
                contentType: "application/json",
              },
            ],
          },
        },
      },
    ],
  };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "multipart-media-")),
    seen = [],
    clients = [],
    children = new Map();
  let app,
    connections = 0;
  const peer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({
      type: req.headers["content-type"],
      body: Buffer.concat(chunks),
      url: req.url,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"accepted":true}');
  });
  peer.on("connection", () => connections++);
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + peer.address().port;
  const owner = async (route, body, method = "POST", status = 200) => {
    const r = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await r.json();
    assert.equal(r.status, status, JSON.stringify(value));
    return value;
  };
  const stop = async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    if (app) {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      app = undefined;
    }
  };
  t.after(async () => {
    for (const c of children.keys()) c.kill();
    await Promise.allSettled(children.values());
    await stop();
    peer.closeAllConnections();
    await new Promise((r) => peer.close(r));
    await rm(root, { recursive: true, force: true });
  });
  app = await createApp({ root, port: 0 });
  return {
    root,
    origin,
    seen,
    owner,
    children,
    get connections() {
      return connections;
    },
    get app() {
      return app;
    },
    get: (id) => owner(`/api/projects/${id}`, undefined, "GET"),
    project: (name) => owner("/api/projects", { name }, "POST", 201),
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    async connect(id, transport) {
      const c = new Client(
        { name: "multipart-media", version: "1" },
        { capabilities: {} },
      );
      clients.push(c);
      if (transport === "http") {
        const config = await owner("/api/mcp/config", {
          enabled: true,
          projects: [id],
          write: true,
          execute: true,
          remember: false,
        });
        await c.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { authorization: "Bearer " + config.token },
            },
          }),
        );
      } else {
        const pipe = new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            id,
            "--write",
            "--execute",
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        });
        pipe.stderr.resume();
        await c.connect(pipe);
      }
      assert(
        (await c.listTools()).tools.some(
          (tool) => tool.name === "localapi_execute_flow",
        ),
        "explicit project/write/execute grant must expose flow execution",
      );
      return c;
    },
  };
}
async function cli(f, id, plan) {
  let child;
  const terminal = new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        id,
        "--plan",
        plan,
      ],
      {
        env: { ...process.env, LOCAL_API_DATA: f.root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    const collect = (which, v) => {
      if (stdout.length + stderr.length + v.length > 1024 * 1024) {
        failure ||= Error("CLI evidence limit");
        child.kill();
        return;
      }
      if (which === "out") stdout += v;
      else stderr += v;
    };
    child.stdout.on("data", (v) => collect("out", v));
    child.stderr.on("data", (v) => collect("err", v));
    const timer = setTimeout(() => {
      failure ||= Error("CLI deadline");
      child.kill();
    }, 10000);
    child.once("error", (e) => {
      failure ||= e;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
  f.children.set(child, terminal);
  try {
    return await terminal;
  } finally {
    f.children.delete(child);
  }
}
function checkWire(record, rows) {
  assert.match(record.type, /^multipart\/form-data; boundary=/);
  const boundary = record.type.split("boundary=")[1];
  const expected = [];
  for (const row of rows.filter((x) => x.enabled !== false)) {
    const file = row.type === "file";
    expected.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${row.key}"${file ? `; filename="${row.filename}"` : ""}\r\n${row.contentType !== undefined || file ? `Content-Type: ${row.contentType ?? "application/octet-stream"}\r\n` : ""}\r\n`,
      ),
    );
    expected.push(
      file ? Buffer.from(row.value, "base64") : Buffer.from(row.value),
    );
    expected.push(Buffer.from("\r\n"));
  }
  expected.push(Buffer.from(`--${boundary}--\r\n`));
  assert.deepEqual(record.body, Buffer.concat(expected));
  assert.equal(record.url, "/upload");
}
for (const transport of ["http", "stdio"])
  test(
    `multipart media survives owner import, ${transport} SDK, CLI frozen execution, backup and restart`,
    { timeout: 60000 },
    async (t) => {
      const f = await fixture(t),
        p = await f.project("typed multipart"),
        other = await f.project("untouched");
      const imported = await f.owner(`/api/projects/${p.id}/import`, {
        document: document(f.origin),
      });
      const r = imported.requests[0];
      assert.equal(r.form[0].contentType, media);
      assert.equal(r.form[3].requiresFile, true);
      assert.equal(r.form[3].value, "");
      assert.equal(r.form[3].filename, "source.dat");
      assert.equal(Object.hasOwn(r.form[1], "contentType"), false);
      const missing = await f.owner(`/api/projects/${p.id}/execute`, {
        request: r,
      });
      assert.equal(missing.outcome, "failed");
      assert.match(missing.error, /重新选择/);
      assert.equal(f.seen.length, 0);
      assert.equal(f.connections, 0);
      for (const row of r.form.filter((x) => x.type === "file")) {
        row.requiresFile = false;
        row.value = payload.toString("base64");
      }
      await f.owner(`/api/projects/${p.id}`, imported, "PUT");
      const saved = (await f.get(p.id)).requests[0];
      const direct = await f.owner(`/api/projects/${p.id}/execute`, {
        request: saved,
      });
      assert.equal(direct.status, 200);
      assert.equal(direct.outcome, "passed");
      checkWire(f.seen.at(-1), saved.form);
      const created = await f.owner(`/api/projects/${p.id}/plans`, {
        name: "frozen media",
        steps: [{ id: "upload", request: saved }],
      });
      const frozen = (await f.get(p.id)).plans.find((x) => x.id === created.id);
      const latest = await f.get(p.id);
      latest.requests[0].form[0].contentType = "text/plain";
      latest.requests[0].form[0].value = "live changed";
      await f.owner(`/api/projects/${p.id}`, latest, "PUT");
      const c = await f.connect(p.id, transport),
        otherBefore = await files(f.app.store.directory(other.id)),
        count = f.seen.length;
      assert.equal(
        (
          await c.callTool({
            name: "localapi_execute_flow",
            arguments: { projectId: other.id, planId: created.id },
          })
        ).isError,
        true,
      );
      assert.equal(f.seen.length, count);
      const run = decode(
        await c.callTool({
          name: "localapi_execute_flow",
          arguments: { projectId: p.id, planId: created.id },
        }),
      );
      assert.equal(run.status, "passed");
      assert.equal(run.recordSaved, true);
      assert.equal(run.recordId, run.id);
      assert.equal(run.attemptedRecordId, run.id);
      assert.deepEqual(run.snapshot, frozen);
      assert.equal(run.planHash, hash(frozen));
      checkWire(f.seen.at(-1), saved.form);
      const invoked = await cli(f, p.id, created.id);
      assert.equal(invoked.code, 0, invoked.stderr + invoked.stdout);
      const cliRun = JSON.parse(invoked.stdout);
      assert.equal(cliRun.status, "passed");
      assert.equal(cliRun.recordSaved, true);
      assert.equal(cliRun.recordId, cliRun.id);
      assert.equal(cliRun.attemptedRecordId, cliRun.id);
      assert.equal(cliRun.planHash, hash(frozen));
      checkWire(f.seen.at(-1), saved.form);
      const beforeExport = await files(f.app.store.directory(p.id));
      const curl = await f.owner(
        `/api/projects/${p.id}/curl`,
        { request: saved },
        "POST",
        400,
      );
      assert.match(curl.error, /分项Content-Type/);
      const oas = await f.owner(
        `/api/projects/${p.id}/export?format=openapi`,
        undefined,
        "GET",
        400,
      );
      assert.match(oas.error, /分项Content-Type/);
      assert.deepEqual(await files(f.app.store.directory(p.id)), beforeExport);
      const backup = await f.owner(
        `/api/projects/${p.id}/export`,
        undefined,
        "GET",
      );
      for (const receipt of [run, cliRun]) {
        const records = backup.runs.filter(
          (entry) => entry.id === receipt.recordId,
        );
        assert.equal(records.length, 1);
        assert.equal(records[0].planHash, receipt.planHash);
        assert.deepEqual(records[0].snapshot, receipt.snapshot);
      }
      const invalidFrozen = structuredClone(backup);
      invalidFrozen.plans.find(
        (x) => x.id === created.id,
      ).steps[0].request.form[0].contentType = "text/plain\r\nInjected: yes";
      // Rehash any corresponding historical snapshot as well: rejection must
      // concern media admission, not a deliberately stale evidence checksum.
      for (const evidence of invalidFrozen.runs) {
        if (evidence.snapshot?.id !== created.id) continue;
        evidence.snapshot.steps[0].request.form[0].contentType =
          "text/plain\r\nInjected: yes";
        evidence.planHash = hash(evidence.snapshot);
        assert.equal(evidence.planHash, hash(evidence.snapshot));
      }
      const projectsBeforeRestore = await f.owner(
          "/api/projects",
          undefined,
          "GET",
        ),
        rootBytesBeforeRestore = await files(f.root),
        connectionsBeforeRestore = f.connections,
        hitsBeforeRestore = f.seen.length;
      const invalidResult = await f.owner(
        "/api/restore",
        { document: invalidFrozen },
        "POST",
        400,
      );
      assert.match(invalidResult.error, /分项Content-Type/);
      assert.deepEqual(
        await f.owner("/api/projects", undefined, "GET"),
        projectsBeforeRestore,
      );
      assert.deepEqual(await files(f.root), rootBytesBeforeRestore);
      assert.equal(f.connections, connectionsBeforeRestore);
      assert.equal(f.seen.length, hitsBeforeRestore);
      const restored = await f.owner(
        "/api/restore",
        { document: backup },
        "POST",
        201,
      );
      assert.notEqual(restored.id, p.id);
      assert.deepEqual(
        restored.plans.find((x) => x.id === created.id),
        frozen,
      );
      assert.deepEqual(restored.runs, backup.runs);
      const beforeRestart = f.seen.length;
      await f.restart();
      const persisted = await f.get(restored.id);
      assert.equal(f.seen.length, beforeRestart);
      assert.deepEqual(
        persisted.plans.find((x) => x.id === created.id),
        frozen,
      );
      assert.equal(persisted.requests[0].form[0].contentType, "text/plain");
      const rerun = await f.owner(`/api/projects/${restored.id}/run`, {
        planId: created.id,
      });
      assert.equal(rerun.status, "passed");
      assert.equal(rerun.recordSaved, true);
      assert.equal(rerun.recordId, rerun.id);
      assert.equal(rerun.attemptedRecordId, rerun.id);
      assert.equal(rerun.planHash, hash(frozen));
      checkWire(f.seen.at(-1), saved.form);
      assert.deepEqual(
        await files(f.app.store.directory(other.id)),
        otherBefore,
      );
    },
  );
test(
  "multipart invalid media and mixed imports are atomic before network; script row updates preserve media",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.project("negative multipart");
    const seed = await f.owner(`/api/projects/${p.id}/import`, {
      document: document(f.origin),
    });
    const saved = seed.requests[0];
    const before = await files(f.app.store.directory(p.id));
    for (const value of [
      null,
      "",
      42,
      "text/plain\r\nX-Injected: yes",
      'text/plain; charset="{{charset}}"',
      "application/*",
      "text/plain; x=" + "a".repeat(1024),
    ]) {
      const bad = structuredClone(saved);
      bad.form = [{ key: "meta", value: "{}", contentType: value }];
      await f.owner(
        `/api/projects/${p.id}/execute`,
        { request: bad },
        "POST",
        400,
      );
      const changed = structuredClone(seed);
      changed.requests[0] = bad;
      await f.owner(`/api/projects/${p.id}`, changed, "PUT", 400);
      const mixed = document(f.origin);
      mixed.item.push({ ...structuredClone(mixed.item[0]), name: "invalid" });
      mixed.item[1].request.body.formdata[0].contentType = value;
      await f.owner(
        `/api/projects/${p.id}/import`,
        { document: mixed },
        "POST",
        400,
      );
      assert.deepEqual(await files(f.app.store.directory(p.id)), before);
      assert.equal(f.seen.length, 0);
      assert.equal(f.connections, 0);
    }
    const invalidRestore = structuredClone(seed);
    invalidRestore.requests[0].form[0].contentType = "text/plain\r\nBad: value";
    const projectsBefore = await f.owner("/api/projects", undefined, "GET");
    await f.owner("/api/restore", { document: invalidRestore }, "POST", 400);
    assert.deepEqual(
      await f.owner("/api/projects", undefined, "GET"),
      projectsBefore,
    );
    assert.deepEqual(await files(f.app.store.directory(p.id)), before);
    assert.equal(f.connections, 0);
    const wrong = structuredClone(saved);
    wrong.bodyType = "urlencoded";
    assert.throws(() => normalizeRequest(wrong), /分项Content-Type/);
    await assert.rejects(executeRequest(wrong), /分项Content-Type/);
    assert.equal(f.seen.length, 0);
    const r = {
      ...saved,
      form: [{ key: "meta", value: "old", contentType: media }],
      beforeScript:
        'pm.request.body.formdata.one("meta").update({value:"updated"});',
    };
    const result = await f.owner(`/api/projects/${p.id}/execute`, {
      request: r,
    });
    assert.equal(result.outcome, "passed", result.error);
    checkWire(f.seen.at(-1), [{ ...r.form[0], value: "updated" }]);
    const replacement = {
      ...r,
      beforeScript:
        'pm.request.body.update({mode:"formdata",formdata:[{key:"meta",value:"replacement"}]});',
    };
    const replaced = await f.owner(`/api/projects/${p.id}/execute`, {
      request: replacement,
    });
    assert.equal(replaced.outcome, "passed", replaced.error);
    checkWire(f.seen.at(-1), [{ key: "meta", value: "replacement" }]);
    assert.deepEqual((await f.get(p.id)).requests, seed.requests);
  },
);

test("root native JSON and directory exports reject explicit multipart media only after a same-source supported control", async (t) => {
  const f = await fixture(t),
    source = await f.project("native multipart boundary");
  source.requests = [
    normalizeRequest({
      id: "native-upload",
      name: "ordinary multipart",
      method: "POST",
      url: f.origin + "/upload",
      bodyType: "form-data",
      form: [{ key: "meta", value: '{"ok":true}', enabled: true }],
    }),
  ];
  await f.owner(`/api/projects/${source.id}`, source, "PUT");
  const persisted = await f.get(source.id),
    bytesBefore = await files(f.root);
  for (const exporter of [exportApipost, exportApipostDirectory]) {
    const supported = structuredClone(persisted),
      before = structuredClone(supported);
    assert.ok(
      exporter(supported),
      "same-source control is representable without explicit part media",
    );
    assert.deepEqual(supported, before);
    // Add exactly the new semantic; do not strip a policy from the source.
    const typed = structuredClone(persisted);
    typed.requests[0].form[0].contentType = media;
    const typedBefore = structuredClone(typed);
    assert.throws(() => exporter(typed), /contentType/);
    assert.deepEqual(typed, typedBefore);
  }
  assert.deepEqual(await files(f.root), bytesBefore);
  assert.equal(f.seen.length, 0);
  assert.equal(f.connections, 0);
});
// Selected-form validation belongs to this multipart feature, not a new codec.
for (const transport of ["http", "stdio"])
  test(
    `OpenAPI encoding validation is atomic through owner and ${transport} sync, with default-media roundtrip and restart`,
    { timeout: 60000 },
    async (t) => {
      const f = await fixture(t),
        p = await f.project("encoding controls"),
        other = await f.project("encoding isolation");
      const c = await f.connect(p.id, transport);
      assert(
        (await c.listTools()).tools.some(
          (tool) => tool.name === "localapi_sync_openapi",
        ),
      );
      const invoke = (id, document) =>
        c.callTool({
          name: "localapi_sync_openapi",
          arguments: { projectId: id, document, coverMode: "url_and_folder" },
        });
      const allBefore = await files(f.root);
      for (const mime of formMedia)
        for (const encoding of invalidEncodings) {
          const document = mixedEncodingDocument(f.origin, mime, encoding);
          for (const source of [
            JSON.stringify(document),
            yamlStringify(document),
          ]) {
            const error = await f.owner(
              `/api/projects/${p.id}/import`,
              { document: source },
              "POST",
              400,
            );
            assert.match(error.error, /encoding/);
            assert.deepEqual(await files(f.root), allBefore);
          }
          const result = await invoke(p.id, document);
          assert.equal(result.isError, true);
          assert.match(result.content[0].text, /encoding/);
          assert.deepEqual(await files(f.root), allBefore);
          assert.equal(f.seen.length, 0);
          assert.equal(f.connections, 0);
        }
      const denied = await invoke(
        other.id,
        encodingDocument(f.origin, formMedia[0], {}),
      );
      assert.equal(denied.isError, true);
      assert.deepEqual(await files(f.root), allBefore);
      const otherBefore = await files(f.app.store.directory(other.id));
      for (const mime of formMedia) {
        const controls = [
          encodingDocument(f.origin, mime, undefined, false),
          encodingDocument(f.origin, mime, {}),
          encodingDocument(f.origin, mime, { meta: {}, "x-field": {} }),
        ];
        for (const document of controls) {
          if (mime !== "multipart/form-data") {
            document.paths["/urlencoded"] = document.paths["/upload"];
            document.paths["/urlencoded"].post.operationId =
              "urlencoded-control";
            delete document.paths["/upload"];
          }
          const synced = decode(await invoke(p.id, JSON.stringify(document)));
          assert.equal(synced.length, 1);
          assert(
            synced[0].form.every((row) => !Object.hasOwn(row, "contentType")),
          );
        }
      }
      const exported = await f.owner(
        `/api/projects/${p.id}/export?format=openapi`,
        undefined,
        "GET",
      );
      const roundtrip = await f.project("encoding roundtrip");
      const imported = await f.owner(`/api/projects/${roundtrip.id}/import`, {
        document: exported,
      });
      assert.equal(imported.requests.length, 2);
      for (const request of imported.requests) {
        assert.deepEqual(
          request.form.map(({ key, value }) => [key, value]),
          [
            ["meta", "雪 & +"],
            ["x-field", "literal"],
            ["exampleOnly", "kept"],
          ],
        );
        assert(request.form.every((row) => !Object.hasOwn(row, "contentType")));
      }
      const plan = await f.owner(`/api/projects/${roundtrip.id}/plans`, {
        name: "default encoding frozen",
        steps: imported.requests.map((request, i) => ({
          id: "step-" + i,
          request,
        })),
      });
      const frozen = (await f.get(roundtrip.id)).plans.find(
        (item) => item.id === plan.id,
      );
      const backup = await f.owner(
        `/api/projects/${roundtrip.id}/export`,
        undefined,
        "GET",
      );
      const restored = await f.owner(
        "/api/restore",
        { document: backup },
        "POST",
        201,
      );
      assert.equal(f.seen.length, 0);
      await f.restart();
      const persisted = await f.get(restored.id);
      assert.deepEqual(
        persisted.plans.find((item) => item.id === plan.id),
        frozen,
      );
      const run = await f.owner(`/api/projects/${restored.id}/run`, {
        planId: plan.id,
      });
      assert.equal(run.status, "passed");
      assert.equal(run.planHash, hash(frozen));
      assert.equal(f.seen.length, 2);
      for (const request of imported.requests) {
        const wire = f.seen.find(
          (record) => record.url === new URL(request.url).pathname,
        );
        assert(wire);
        if (request.bodyType === "form-data") checkWire(wire, request.form);
        else {
          assert.match(wire.type, /^application\/x-www-form-urlencoded/);
          assert.equal(
            wire.body.toString(),
            new URLSearchParams(
              request.form.map((row) => [row.key, row.value]),
            ).toString(),
          );
        }
      }
      assert.deepEqual(
        await files(f.app.store.directory(other.id)),
        otherBefore,
      );
    },
  );
