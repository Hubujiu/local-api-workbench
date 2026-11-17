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
} from "./fixtures/apipost-descriptions.mjs";

const exec = promisify(execFile);
const semantic = (rows) =>
  rows.map(({ key, description }) => ({ key, description }));
const close = (app) =>
  new Promise((resolve, reject) => {
    app.server.close((error) => (error ? reject(error) : resolve()));
    app.server.closeIdleConnections();
  });

for (const format of ["apipost", "apipost-directory"])
  test(
    `${format} description catalogue survives owner import, two native generations and restarted readback without cross-project changes`,
    { timeout: 15000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "native-descriptions-"));
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
        { name: "Description source" },
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
      const expected = document.global.describe_library.map((entry) => ({
        key: entry.key,
        description: entry.description ?? "",
      }));
      assert.deepEqual(
        semantic(imported.settings.parameterDescriptions),
        expected,
      );
      const sourceBefore = await new Store(root).get(source.id);
      await close(app);
      app = await createApp({ root, port: 0 });
      assert.deepEqual(
        (await call(`/api/projects/${source.id}`)).settings
          .parameterDescriptions,
        imported.settings.parameterDescriptions,
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
        assert.deepEqual(semantic(emitted.rows), expected);
        assert.equal(
          new Set(emitted.rows.map((entry) => entry.id)).size,
          expected.length,
        );
        for (const entry of emitted.rows) {
          assert.equal(typeof entry.id, "string");
          assert.ok(entry.id.length > 0);
          assert.notEqual(entry.id, "old-description");
          assert.equal(entry.project_id, emitted.projectId);
          assert.notEqual(entry.project_id, document.project_id);
          assert.deepEqual(Object.keys(entry).sort(), [
            "description",
            "id",
            "key",
            "project_id",
          ]);
        }
        const target = await call(
          "/api/projects",
          "POST",
          { name: `Generation ${generation}` },
          201,
        );
        current = await call(`/api/projects/${target.id}/import`, "POST", {
          document: output,
        });
        assert.deepEqual(
          semantic(current.settings.parameterDescriptions),
          expected,
        );
        assert.equal(current.requests.length, 1);
        assert.equal(current.requests[0].url, document.apis[0].url);
        assert.equal(
          Object.hasOwn(current.settings, "is_describe_library"),
          false,
        );
        for (const entry of current.settings.parameterDescriptions)
          assert.equal(entry.apipostSource.projectId, emitted.projectId);
        assert.deepEqual(
          (await new Store(root).get(current.id)).settings
            .parameterDescriptions,
          current.settings.parameterDescriptions,
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
        restored.settings.parameterDescriptions,
        current.settings.parameterDescriptions,
      );
      await close(app);
      app = await createApp({ root, port: 0 });
      assert.deepEqual(
        (await call(`/api/projects/${restored.id}`)).settings
          .parameterDescriptions,
        current.settings.parameterDescriptions,
      );
      const child = await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {Store} from ${JSON.stringify(new URL("../src/runtime.mjs", import.meta.url).href)}; const p = await new Store(process.argv[1]).get(process.argv[2]); process.stdout.write(JSON.stringify(p.settings.parameterDescriptions));`,
          root,
          restored.id,
        ],
        { timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      assert.deepEqual(
        JSON.parse(child.stdout),
        current.settings.parameterDescriptions,
      );
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
  "owner catalogue merges retain local provenance and invalid imports leave all project bytes and grants unchanged",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "description-import-atomic-"));
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
      { name: "Atomic descriptions" },
      201,
    );
    const base = catalogueDocument("http://127.0.0.1:1/never");
    base.apis = [];
    base.global.describe_library = [
      {
        id: "keep-id",
        project_id: base.project_id,
        key: "key",
        description: "same",
      },
    ];
    const imported = await call(`/api/projects/${project.id}/import`, "POST", {
      document: base,
    });
    const incoming = structuredClone(base);
    incoming.project_id = "another-source";
    incoming.global.describe_library = [
      {
        id: "replace-attempt",
        project_id: incoming.project_id,
        key: "key",
        description: "same",
      },
    ];
    const repeated = await call(`/api/projects/${project.id}/import`, "POST", {
      document: incoming,
    });
    assert.deepEqual(
      repeated.settings.parameterDescriptions,
      imported.settings.parameterDescriptions,
    );
    const before = await new Store(root).get(project.id);
    const diskBefore = await diskSnapshot(app.store.directory(project.id));
    const grantsBefore = await call("/api/mcp/config");
    const invalidRows = [
      [{ key: "key", description: "conflict" }],
      [
        { id: "duplicate", key: "a", description: "a" },
        { id: "duplicate", key: "b", description: "b" },
      ],
      [{ project_id: "foreign", key: "new", description: "new" }],
      [{ key: "new", description: "new", unknown: true }],
      [
        { key: "new", description: "a" },
        { key: "new", description: "b" },
      ],
      [{ key: "new", description: null }],
    ];
    for (const rows of invalidRows) {
      const document = structuredClone(base);
      document.global.describe_library = rows;
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
    assert.equal(Object.hasOwn(before.settings, "is_describe_library"), false);
  },
);
