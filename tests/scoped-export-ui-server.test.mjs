import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest, importIntoProject } from "../src/core.mjs";
import {
  scopedExportResources,
  assertScopedExportPreview,
  scopedExportConfirmationHTML,
  scopedExportRequest,
  assertScopedExportResult,
} from "../public/scoped-export-view.js";
for (const format of [
  "apipost",
  "apipost-directory",
  "postman-collection-v2.1",
])
  test(`UI receipt contract and roundtrip through real owner HTTP: ${format}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "scoped-ui-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const project = await app.store.create("UI export");
    project.requests = [
      normalizeRequest({
        id: "chosen",
        name: "Chosen",
        url: "http://127.0.0.1/chosen",
        headers: [{ key: "X-Example", value: "selected-fixture-secret" }],
      }),
      normalizeRequest({
        id: "other",
        name: "Other",
        url: "http://127.0.0.1/unselected-fixture-secret",
      }),
    ];
    await app.store.save(project);
    const before = await app.store.get(project.id);
    const input = {
      format,
      selection: {
        mode: "explicit",
        resources: [{ kind: "api", id: "chosen" }],
      },
    };
    const post = async (action, data) => {
      const response = await fetch(
        app.url + "/api/projects/" + project.id + "/" + action,
        {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(data),
        },
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    const preview = await post("export-preview", input);
    assertScopedExportPreview(preview, input, before);
    const html = scopedExportConfirmationHTML(
      preview,
      scopedExportResources(before),
    );
    assert(
      !html.includes("selected-fixture-secret"),
      "preview exposed selected fixture content",
    );
    assert(
      !html.includes("unselected-fixture-secret"),
      "preview exposed unselected fixture content",
    );
    assert(/非脱敏/.test(html), "non-redaction warning missing");
    const result = await post(
      "export-selection",
      scopedExportRequest(input, preview),
    );
    const document = assertScopedExportResult(result, preview);
    assert(
      !JSON.stringify(document).includes("unselected-fixture-secret"),
      "unselected fixture content was exported",
    );
    assert(
      JSON.stringify(document).includes("selected-fixture-secret"),
      "selected fixture content was lost",
    );
    const restored = await app.store.create("Roundtrip");
    importIntoProject(restored, document);
    await app.store.save(restored);
    const reloaded = await app.store.get(restored.id);
    assert.equal(reloaded.requests.length, 1);
    assert.equal(reloaded.requests[0].name, "Chosen");
    assert(
      isDeepStrictEqual(await app.store.get(project.id), before),
      "source project changed during read-only export",
    );
  });
