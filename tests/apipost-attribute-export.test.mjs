// Synthetic owner contracts, not original-GUI acceptance.
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
  attributeDocument,
  attributeSemantics,
  emittedAttributes,
} from "./fixtures/apipost-export-attributes.mjs";
const exec = promisify(execFile);
const close = (app) =>
  new Promise((resolve, reject) => {
    app.server.close((e) => (e ? reject(e) : resolve()));
    app.server.closeIdleConnections();
  });
for (const format of ["apipost", "apipost-directory"])
  test(
    `${format} owner saves attribute definitions and explicit values through two native generations and restarted readback`,
    { timeout: 15000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "native-attributes-"));
      let sends = 0,
        app;
      const upstream = http.createServer((_req, res) => {
        sends++;
        res.end("{}");
      });
      await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
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
        const r = await fetch(app.url + route, {
            method,
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
          text = await r.text();
        assert.equal(r.status, status, text);
        return JSON.parse(text);
      };
      const source = await call(
          "/api/projects",
          "POST",
          { name: "Attribute source" },
          201,
        ),
        other = await call("/api/projects", "POST", { name: "Unrelated" }, 201);
      const otherBefore = await new Store(root).get(other.id);
      const document = attributeDocument(
          `http://127.0.0.1:${upstream.address().port}/must-not-send`,
        ),
        documentBefore = structuredClone(document);
      let imported = await call(`/api/projects/${source.id}/import`, "POST", {
        document,
      });
      imported.settings.attributes[0].description = "Edited and saved help";
      imported.requests[0].attributes[imported.settings.attributes[0].key] =
        "Edited and saved value";
      imported = await call(`/api/projects/${source.id}`, "PUT", imported);
      const expected = attributeSemantics(imported),
        sourceBefore = await new Store(root).get(source.id);
      await close(app);
      app = await createApp({ root, port: 0 });
      assert.deepEqual(
        attributeSemantics(await call(`/api/projects/${source.id}`)),
        expected,
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
      for (let generation = 0; generation < 2; generation++) {
        const output = await call(
            `/api/projects/${current.id}/export?format=${format}`,
          ),
          emitted = emittedAttributes(output, format);
        assert.equal(emitted.fields.length, 9);
        assert.equal(
          new Set(emitted.fields.map((f) => f.attribute_id)).size,
          9,
        );
        assert.ok(
          emitted.fields.every((f) => f.project_id === emitted.projectId),
        );
        const ids = new Set(emitted.fields.map((f) => f.attribute_id));
        assert.ok(
          emitted.apis.every((a) =>
            Object.keys(a.attribute_info).every((id) => ids.has(id)),
          ),
        );
        const target = await call(
          "/api/projects",
          "POST",
          { name: `Generation ${generation}` },
          201,
        );
        current = await call(`/api/projects/${target.id}/import`, "POST", {
          document: output,
        });
        assert.deepEqual(attributeSemantics(current), expected);
        assert.equal(current.requests.length, 2);
        assert.deepEqual(
          attributeSemantics(await new Store(root).get(current.id)),
          expected,
        );
      }
      const backup = await call(`/api/projects/${source.id}/export`),
        restored = await call(
          "/api/restore",
          "POST",
          { document: backup },
          201,
        );
      assert.deepEqual(
        restored.settings.attributes,
        imported.settings.attributes,
      );
      assert.deepEqual(
        restored.requests.map((r) => r.attributes),
        imported.requests.map((r) => r.attributes),
      );
      await close(app);
      app = await createApp({ root, port: 0 });
      assert.deepEqual(
        attributeSemantics(await call(`/api/projects/${restored.id}`)),
        expected,
      );
      const child = await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {Store} from ${JSON.stringify(new URL("../src/runtime.mjs", import.meta.url).href)};const p=await new Store(process.argv[1]).get(process.argv[2]);process.stdout.write(JSON.stringify({fields:p.settings.attributes,values:p.requests.map(r=>r.attributes)}));`,
          root,
          restored.id,
        ],
        { timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      assert.deepEqual(JSON.parse(child.stdout), {
        fields: imported.settings.attributes,
        values: imported.requests.map((r) => r.attributes),
      });
      assert.deepEqual(await new Store(root).get(source.id), sourceBefore);
      assert.deepEqual(await new Store(root).get(other.id), otherBefore);
      assert.deepEqual(document, documentBefore);
      assert.equal(sends, 0);
    },
  );

async function diskSnapshot(directory, prefix = "") {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + item.name,
      file = join(directory, item.name);
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
  "owner invalid native imports and unsupported stored attribute exports leave project bytes, history and grants unchanged",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "native-attribute-atomic-")),
      app = await createApp({ root, port: 0 });
    t.after(async () => {
      try {
        await close(app);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    const call = async (route, method = "GET", body, status = 200) => {
      const r = await fetch(app.url + route, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        text = await r.text();
      assert.equal(r.status, status, text);
      return JSON.parse(text);
    };
    const project = await call(
        "/api/projects",
        "POST",
        { name: "Atomic attribute source" },
        201,
      ),
      other = await call("/api/projects", "POST", { name: "Other" }, 201),
      document = attributeDocument();
    await call(`/api/projects/${project.id}/import`, "POST", { document });
    const before = await new Store(root).get(project.id),
      otherBefore = await new Store(root).get(other.id),
      diskBefore = await diskSnapshot(app.store.directory(project.id)),
      grantsBefore = await call("/api/mcp/config");
    for (const change of [
      (d) => d.global.attributes.push(structuredClone(d.global.attributes[0])),
      (d) => (d.global.attributes[0].project_id = "foreign"),
      (d) =>
        (d.global.attributes[0].field_name = "conflicting existing definition"),
      (d) => (d.global.attributes[0].required = false),
      (d) => (d.apis[0].attribute_info.unknown = null),
      (d) => (d.apis[0].attribute_info["field-4"] = "2026-11-03T00:00:00Z"),
    ]) {
      const invalid = structuredClone(document);
      change(invalid);
      const sourceBefore = structuredClone(invalid);
      const failure = await call(
        `/api/projects/${project.id}/import`,
        "POST",
        { document: invalid },
        400,
      );
      assert.deepEqual(Object.keys(failure), ["error"]);
      assert.deepEqual(invalid, sourceBefore);
      assert.deepEqual(await new Store(root).get(project.id), before);
      assert.deepEqual(
        await diskSnapshot(app.store.directory(project.id)),
        diskBefore,
      );
      assert.deepEqual(await call("/api/mcp/config"), grantsBefore);
    }
    for (const change of [
      (p) => (p.settings.attributes[8].type = "boolean"),
      (p) => (p.settings.attributes[8].required = false),
      (p) => (p.settings.attributes[8].apipostSource.unknown = true),
      (p) => (p.requests[0].attributes.unknown = null),
    ]) {
      const changed = await app.store.get(project.id);
      changed.settings.attributes = structuredClone(before.settings.attributes);
      changed.requests = structuredClone(before.requests);
      change(changed);
      await app.store.save(changed);
      const stored = await new Store(root).get(project.id),
        files = await diskSnapshot(app.store.directory(project.id));
      for (const format of ["apipost", "apipost-directory"]) {
        const failure = await call(
          `/api/projects/${project.id}/export?format=${format}`,
          "GET",
          undefined,
          400,
        );
        assert.deepEqual(Object.keys(failure), ["error"]);
        assert.equal(typeof failure.error, "string");
        assert.deepEqual(await new Store(root).get(project.id), stored);
        assert.deepEqual(
          await diskSnapshot(app.store.directory(project.id)),
          files,
        );
        assert.deepEqual(await call("/api/mcp/config"), grantsBefore);
        assert.deepEqual(await new Store(root).get(other.id), otherBefore);
      }
      const backup = await call(`/api/projects/${project.id}/export`);
      assert.deepEqual(backup.settings.attributes, stored.settings.attributes);
      assert.deepEqual(
        backup.requests.map((r) => r.attributes),
        stored.requests.map((r) => r.attributes),
      );
    }
  },
);
