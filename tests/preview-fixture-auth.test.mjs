import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createApp } from "../src/server.mjs";
import { readPreviewProject } from "./helpers/preview-draft-ownership-ui.mjs";

test("preview snapshot uses local session authentication against the real HTTP server", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-fixture-auth-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await fetch(app.url + "/api/projects", {
    method: "POST",
    headers: { "x-local-token": app.token, "content-type": "application/json" },
    body: JSON.stringify({ name: "Preview fixture authentication" }),
  });
  assert.equal(created.status, 201);
  const project = await created.json();
  const url = app.url + "/api/projects/" + project.id;
  assert.equal(
    (await fetch(url)).status,
    403,
    "the original unauthenticated read remains forbidden",
  );
  // Execute the exact page.evaluate callback with browser globals, while fetch
  // reaches the real server. This is an HTTP regression, not a browser journey.
  let credential = app.token;
  let gets = 0;
  const page = {
    evaluate(callback, argument) {
      return vm.runInNewContext(`(${callback.toString()})(argument)`, {
        argument,
        URL,
        location: { origin: app.url },
        fetch: (url, options) => {
          gets++;
          assert.equal(options.redirect, "error");
          return fetch(url, options);
        },
        sessionStorage: {
          getItem(key) {
            assert.equal(key, "local-api-token");
            return credential;
          },
        },
      });
    },
  };
  const read = await readPreviewProject(page, url);
  assert.equal(read.id, project.id);
  assert.equal(read.name, project.name);
  credential = "invalid-local-fixture-token";
  await assert.rejects(readPreviewProject(page, url), (error) => {
    assert.equal(error.actual, 403);
    assert.equal(error.expected, 200);
    return true;
  });
  const before = gets;
  await assert.rejects(
    readPreviewProject(page, "https://example.invalid/api/projects/nope"),
    /application origin/,
  );
  assert.equal(
    gets,
    before,
    "never transmit the local credential to another origin",
  );
});
