// Synthetic contract from observed fields; the original application is not run.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import {
  catalogueDocument,
  emittedCatalogue,
} from "./fixtures/apipost-codes.mjs";

const exec = promisify(execFile);
const semantic = (rows) => rows.map(({ code, label }) => ({ code, label }));
const close = (app) =>
  new Promise((resolve, reject) => {
    app.server.close((error) => (error ? reject(error) : resolve()));
    app.server.closeIdleConnections();
  });

for (const format of ["apipost", "apipost-directory"])
  test(
    `${format} status-code catalogue survives owner import, two native generations and restarted readback without cross-project changes`,
    { timeout: 15000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "native-codes-"));
      let upstreamRequests = 0;
      const upstream = http.createServer((_req, res) => {
        upstreamRequests++;
        res.end("{}");
      });
      await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      let app;
      t.after(async () => {
        try {
          if (app?.server.listening) await close(app);
        } finally {
          upstream.closeAllConnections();
          await new Promise((resolve) => upstream.close(resolve));
          await rm(root, { recursive: true, force: true });
        }
      });
      app = await createApp({ root, port: 0 });
      const call = async (route, method = "GET", body, status = 200) => {
        const response = await fetch(app.url + route, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        assert.equal(response.status, status, text);
        return JSON.parse(text);
      };
      const source = await call(
        "/api/projects",
        "POST",
        { name: "Status-code source" },
        201,
      );
      const other = await call(
        "/api/projects",
        "POST",
        { name: "Unrelated project" },
        201,
      );
      const unrelatedBefore = await new Store(root).get(other.id);
      const document = catalogueDocument(
        `http://127.0.0.1:${upstream.address().port}/must-not-send`,
      );
      const documentBefore = JSON.stringify(document);
      const imported = await call(`/api/projects/${source.id}/import`, "POST", {
        document,
      });
      const expected = document.global.codes.map((entry) => ({
        code: entry.code_number,
        label: entry.code_msg,
      }));
      assert.deepEqual(semantic(imported.settings.statusCodes), expected);
      const sourceBefore = await new Store(root).get(source.id);
      const sourceBackup = await call(`/api/projects/${source.id}/export`);
      assert.deepEqual(
        sourceBackup.settings.statusCodes,
        imported.settings.statusCodes,
      );
      assert.deepEqual(sourceBackup.settings.statusCodes[0].apipostSource, {
        projectId: document.project_id,
        codeId: "old-code",
      });
      await close(app);
      app = await createApp({ root, port: 0 });
      assert.deepEqual(
        (await call(`/api/projects/${source.id}`)).settings.statusCodes,
        imported.settings.statusCodes,
      );
      assert.equal(
        (
          await fetch(
            app.url + `/api/projects/${source.id}/export?format=${format}`,
          )
        ).status,
        403,
      );
      let current = imported;
      let output = await call(
        `/api/projects/${current.id}/export?format=${format}`,
      );
      for (let generation = 0; generation < 2; generation++) {
        const emitted = emittedCatalogue(output, format);
        assert.deepEqual(
          emitted.rows,
          expected.map(({ code, label }) => ({
            code_number: code,
            code_msg: label,
          })),
        );
        for (const entry of emitted.rows)
          assert.deepEqual(Object.keys(entry).sort(), [
            "code_msg",
            "code_number",
          ]);
        const target = await call(
          "/api/projects",
          "POST",
          { name: `Generation ${generation}` },
          201,
        );
        current = await call(`/api/projects/${target.id}/import`, "POST", {
          document: output,
        });
        assert.deepEqual(semantic(current.settings.statusCodes), expected);
        assert.equal(current.requests.length, 1);
        assert.equal(current.requests[0].url, document.apis[0].url);
        for (const entry of current.settings.statusCodes) {
          assert.notEqual(entry.httpHint, true);
          assert.equal(Object.hasOwn(entry, "apipostSource"), false);
        }
        assert.deepEqual(
          (await new Store(root).get(current.id)).settings.statusCodes,
          current.settings.statusCodes,
        );
        output = await call(
          `/api/projects/${current.id}/export?format=${format}`,
        );
      }
      const backup = await call(`/api/projects/${current.id}/export`);
      const restored = await call(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      assert.notEqual(restored.id, current.id);
      assert.deepEqual(
        restored.settings.statusCodes,
        current.settings.statusCodes,
      );
      await close(app);
      app = await createApp({ root, port: 0 });
      assert.deepEqual(
        (await call(`/api/projects/${restored.id}`)).settings.statusCodes,
        current.settings.statusCodes,
      );
      const child = await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {Store} from ${JSON.stringify(new URL("../src/runtime.mjs", import.meta.url).href)}; const p = await new Store(process.argv[1]).get(process.argv[2]); process.stdout.write(JSON.stringify(p.settings.statusCodes));`,
          root,
          restored.id,
        ],
        { timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      assert.deepEqual(JSON.parse(child.stdout), current.settings.statusCodes);
      assert.deepEqual(await new Store(root).get(source.id), sourceBefore);
      assert.deepEqual(await new Store(root).get(other.id), unrelatedBefore);
      assert.equal(JSON.stringify(document), documentBefore);
      assert.equal(upstreamRequests, 0);
    },
  );

async function diskSnapshot(directory, prefix = "") {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + item.name;
    const file = join(directory, item.name);
    if (item.isDirectory())
      entries.push(...(await diskSnapshot(file, relative + "/")));
    else
      entries.push([
        relative,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

test(
  "owner code merges retain local type and provenance and invalid imports leave project bytes and grants unchanged",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "code-import-atomic-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      try {
        await close(app);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    const call = async (route, method = "GET", body, status = 200) => {
      const response = await fetch(app.url + route, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      assert.equal(response.status, status, text);
      return JSON.parse(text);
    };
    const project = await call(
      "/api/projects",
      "POST",
      { name: "Atomic codes" },
      201,
    );
    const base = catalogueDocument("http://127.0.0.1:1/never");
    base.apis = [];
    base.global.codes = [
      {
        code_id: "keep-id",
        project_id: base.project_id,
        code_number: 409,
        code_msg: "same",
      },
    ];
    const imported = await call(`/api/projects/${project.id}/import`, "POST", {
      document: base,
    });
    const incoming = structuredClone(base);
    incoming.project_id = "another-source";
    incoming.global.codes = [
      {
        code_id: "replace-attempt",
        project_id: incoming.project_id,
        code_number: "409",
        code_msg: "same",
      },
    ];
    const repeated = await call(`/api/projects/${project.id}/import`, "POST", {
      document: incoming,
    });
    assert.deepEqual(
      repeated.settings.statusCodes,
      imported.settings.statusCodes,
    );
    const before = await new Store(root).get(project.id);
    const diskBefore = await diskSnapshot(app.store.directory(project.id));
    const grantsBefore = await call("/api/mcp/config");
    const invalidRows = [
      [{ code_number: 409, code_msg: "conflict" }],
      [
        { code_id: "duplicate", code_number: "a", code_msg: "a" },
        { code_id: "duplicate", code_number: "b", code_msg: "b" },
      ],
      [{ project_id: "foreign", code_number: "new", code_msg: "new" }],
      [{ code_number: "new", code_msg: "new", unknown: true }],
      [
        { code_number: 200, code_msg: "a" },
        { code_number: "200", code_msg: "b" },
      ],
      [{ code_number: "new", code_msg: "" }],
      [{ code_number: "new" }],
      [{ code_number: "white space", code_msg: "rejected" }],
    ];
    for (const rows of invalidRows) {
      const document = structuredClone(base);
      document.global.codes = rows;
      const sourceBefore = JSON.stringify(document);
      await call(
        `/api/projects/${project.id}/import`,
        "POST",
        { document },
        400,
      );
      assert.equal(JSON.stringify(document), sourceBefore);
      assert.deepEqual(await new Store(root).get(project.id), before);
      assert.deepEqual(
        await diskSnapshot(app.store.directory(project.id)),
        diskBefore,
      );
      assert.deepEqual(await call("/api/mcp/config"), grantsBefore);
    }
    assert.notEqual(before.settings.statusCodes[0].httpHint, true);
  },
);
