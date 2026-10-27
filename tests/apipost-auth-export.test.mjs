import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { exportExtendedApipostAuth } from "../src/apipost-auth-export.mjs";
import { importExtendedApipostAuth } from "../src/apipost-auth-import.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";
import {
  credentials,
  fixture,
  verify,
} from "./helpers/native-signing-fixture.mjs";

test("native signing definitions export without changing explicit or default behavior and reject unmapped data", () => {
  for (const native of credentials) {
    const imported = importExtendedApipostAuth(native);
    assert.deepEqual(
      importExtendedApipostAuth(exportExtendedApipostAuth(imported)),
      imported,
    );
  }
  const defaultHawk = exportExtendedApipostAuth({
    type: "hawk",
    id: "id",
    key: "key",
  });
  assert.equal(defaultHawk.hawk.algorithm, "sha256");
  assert.equal(defaultHawk.hawk.includePayloadHash, true);
  assert.equal(
    exportExtendedApipostAuth({
      type: "hawk",
      id: "id",
      key: "key",
      payloadHash: "disabled",
    }).hawk.includePayloadHash,
    false,
  );
  for (const auth of [
    {
      ...importExtendedApipostAuth(credentials[0]),
      signingDate: "2020-01-01T00:00:00Z",
    },
    { ...importExtendedApipostAuth(credentials[4]), maxBodySize: 131072 },
    {
      ...importExtendedApipostAuth(credentials[4]),
      headersToSign: ["x-proof"],
    },
    { ...importExtendedApipostAuth(credentials[2]), timestamp: 1700000000 },
    { ...importExtendedApipostAuth(credentials[2]), payloadHash: "maybe" },
    { ...importExtendedApipostAuth(credentials[0]), extra: "do not drop" },
    { ...importExtendedApipostAuth(credentials[0]), addAuthDataToQuery: true },
  ])
    assert.throws(() => exportExtendedApipostAuth(auth));
});

test("owner signed HTTP import dual export/reimport frozen execution live edits restore restart and isolation", async (t) => {
  const seen = [],
    errors = [];
  let base;
  const wire = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      seen.push(verify(req, body, base));
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    } catch (e) {
      errors.push(e.message);
      res.statusCode = 401;
      res.end(e.message);
    }
  });
  await new Promise((r) => wire.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${wire.address().port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "signing-export-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await stop();
    wire.closeAllConnections();
    await new Promise((r) => wire.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, method = "GET", body, expected = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  const other = await app.store.create("untouched"),
    otherBefore = await app.store.get(other.id);
  for (const inputFormat of ["json", "directory"]) {
    const native = fixture(base),
      document =
        inputFormat === "json" ? native : nativeDirectoryFixture(native),
      original = structuredClone(document);
    const project = await app.store.create("source " + inputFormat);
    let source = await call(`/api/projects/${project.id}/import`, "POST", {
      document,
    });
    // A normal Workbench edit removes default fields. Export must make both
    // defaults explicit rather than importing native omission as hash-disabled.
    delete source.requests[5].auth.algorithm;
    delete source.requests[5].auth.payloadHash;
    await call(`/api/projects/${project.id}`, "PUT", source);
    source = await app.store.get(project.id);
    const expectedAuth = source.requests.map((r, i) =>
      i === 5
        ? { ...r.auth, algorithm: "sha256", payloadHash: "enabled" }
        : r.auth,
    );
    assert.equal(source.requests[0].auth.secretKey, "{{awsSecret}}");
    const before = structuredClone(source),
      count = seen.length;
    for (const format of ["apipost", "apipost-directory"]) {
      const route = `/api/projects/${project.id}/export?format=${format}`;
      assert.equal((await fetch(app.url + route)).status, 403);
      const output = await call(route);
      assert.equal(seen.length, count);
      const target = await app.store.create("target " + format);
      const imported = await call(`/api/projects/${target.id}/import`, "POST", {
        document: output,
      });
      assert.equal(seen.length, count);
      assert.deepEqual(
        imported.requests.map((r) => r.auth),
        expectedAuth,
      );
      const second = await call(
        `/api/projects/${target.id}/export?format=${format}`,
      );
      assert.equal(seen.length, count);
      const secondTarget = await app.store.create("second");
      const again = await call(
        `/api/projects/${secondTarget.id}/import`,
        "POST",
        { document: second },
      );
      assert.deepEqual(
        again.requests.map((r) => r.auth),
        expectedAuth,
      );
      const plan = await call(`/api/projects/${target.id}/plans`, "POST", {
        statusPolicy: "strict200",
        environmentId: imported.environments.find((e) => e.name === "Imported")
          .id,
        steps: imported.requests.map((request) => ({ request })),
      });
      const edited = await app.store.get(target.id);
      for (const request of edited.requests)
        request.auth = { type: "bearer", token: "later-live-edit" };
      await call(`/api/projects/${target.id}`, "PUT", edited);
      const run = await call(`/api/projects/${target.id}/run`, "POST", {
        planId: plan.id,
      });
      assert.equal(run.status, "passed", JSON.stringify({ run, errors }));
      assert.deepEqual(seen.slice(-6), [0, 1, 2, 3, 4, 5]);
      const backup = await call(`/api/projects/${target.id}/export`),
        restored = await call(
          "/api/restore",
          "POST",
          { document: backup },
          201,
        );
      await stop();
      app = await createApp({ root, port: 0 });
      const disk = await app.store.get(restored.id);
      assert.deepEqual(
        disk.plans[0].steps.map((s) => s.request.auth),
        expectedAuth,
      );
      const rerun = await call(`/api/projects/${restored.id}/run`, "POST", {
        planId: disk.plans[0].id,
      });
      assert.equal(rerun.status, "passed", JSON.stringify({ rerun, errors }));
      assert.deepEqual(seen.slice(-6), [0, 1, 2, 3, 4, 5]);
      // Reset the no-network counter only after explicit separately authorized runs.
      seen.splice(count);
    }
    assert.deepEqual(await app.store.get(project.id), before);
    const invalid = structuredClone(source);
    invalid.requests[0].auth.signingDate = "2020-01-01T00:00:00Z";
    await call(`/api/projects/${project.id}`, "PUT", invalid);
    const invalidSaved = await app.store.get(project.id);
    for (const format of ["apipost", "apipost-directory"])
      await call(
        `/api/projects/${project.id}/export?format=${format}`,
        "GET",
        undefined,
        400,
      );
    assert.deepEqual(await app.store.get(project.id), invalidSaved);
    assert.equal(seen.length, count);
    assert.deepEqual(document, original);
  }
  assert.deepEqual(await app.store.get(other.id), otherBefore);
  assert.deepEqual(errors, []);
});
