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
import { emittedAttributes } from "./fixtures/apipost-export-attributes.mjs";
import {
  combinedDocument as attributeDocument,
  catalogueSemantics as attributeSemantics,
} from "./fixtures/apipost-attribute-catalogues.mjs";
import { emittedCatalogue as emittedCodes } from "./fixtures/apipost-codes.mjs";
import { emittedCatalogue as emittedDescriptions } from "./fixtures/apipost-descriptions.mjs";
const exec = promisify(execFile);
const close = (app) =>
  new Promise((resolve, reject) => {
    app.server.close((e) => (e ? reject(e) : resolve()));
    app.server.closeIdleConnections();
  });
for (const format of ["apipost", "apipost-directory"])
  test(
    `${format} owner saves all three catalogues and explicit attribute values through two native generations and restarted readback`,
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
      imported.settings.statusCodes[0].label = "Edited business code";
      imported.settings.parameterDescriptions[0].description =
        "Edited parameter explanation";
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
        assert.deepEqual(
          emittedCodes(output, format).rows,
          expected.codes.map(({ code, label }) => ({
            code_number: code,
            code_msg: label,
          })),
        );
        assert.deepEqual(
          emittedDescriptions(output, format).rows.map(
            ({ key, description }) => ({ key, description }),
          ),
          expected.descriptions,
        );
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
          `import {Store} from ${JSON.stringify(new URL("../src/runtime.mjs", import.meta.url).href)};const p=await new Store(process.argv[1]).get(process.argv[2]);process.stdout.write(JSON.stringify({fields:p.settings.attributes,values:p.requests.map(r=>r.attributes),codes:p.settings.statusCodes,descriptions:p.settings.parameterDescriptions}));`,
          root,
          restored.id,
        ],
        { timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      assert.deepEqual(JSON.parse(child.stdout), {
        codes: imported.settings.statusCodes,
        descriptions: imported.settings.parameterDescriptions,
        fields: imported.settings.attributes,
        values: imported.requests.map((r) => r.attributes),
      });
      assert.deepEqual(await new Store(root).get(source.id), sourceBefore);
      assert.deepEqual(await new Store(root).get(other.id), otherBefore);
      const grantsBefore = await call("/api/mcp/config");
      // Descriptions reject unknown fields during save, before export is reached.
      const valid = await new Store(root).get(current.id);
      const validFiles = await diskSnapshot(app.store.directory(current.id));
      const invalidDescription = structuredClone(valid);
      invalidDescription.settings.parameterDescriptions[0].unknown = true;
      const rejectedSave = await call(
        `/api/projects/${current.id}`,
        "PUT",
        invalidDescription,
        400,
      );
      assert.deepEqual(Object.keys(rejectedSave).sort(), [
        "commit_outcome",
        "error",
        "project_id",
        "retry_safe",
      ]);
      assert.equal(rejectedSave.project_id, current.id);
      assert.equal(rejectedSave.commit_outcome, "not_committed");
      assert.equal(rejectedSave.retry_safe, false);
      assert.deepEqual(await new Store(root).get(current.id), valid);
      assert.deepEqual(
        await diskSnapshot(app.store.directory(current.id)),
        validFiles,
      );
      assert.deepEqual(await call("/api/mcp/config"), grantsBefore);
      for (const mutate of [
        (p) => (p.settings.statusCodes[1].httpHint = true),
        (p) => (p.settings.attributes[8].required = false),
      ]) {
        const invalid = await app.store.get(current.id);
        invalid.settings = structuredClone(current.settings);
        mutate(invalid);
        await app.store.save(invalid);
        const before = await new Store(root).get(current.id),
          files = await diskSnapshot(app.store.directory(current.id));
        const failure = await call(
          `/api/projects/${current.id}/export?format=${format}`,
          "GET",
          undefined,
          400,
        );
        assert.deepEqual(Object.keys(failure), ["error"]);
        assert.deepEqual(await new Store(root).get(current.id), before);
        assert.deepEqual(
          await diskSnapshot(app.store.directory(current.id)),
          files,
        );
        assert.deepEqual(await call("/api/mcp/config"), grantsBefore);
        assert.deepEqual(await new Store(root).get(source.id), sourceBefore);
        assert.deepEqual(await new Store(root).get(other.id), otherBefore);
      }
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
