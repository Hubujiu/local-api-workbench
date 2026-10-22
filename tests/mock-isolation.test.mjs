import test from "node:test";
import assert from "node:assert/strict";
import { validateMockResponse } from "../public/response-example.js";
import { createApp } from "../src/server.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("same-origin Mock cannot replace workbench isolation or browser-state headers", () => {
  for (const name of [
    "Content-Security-Policy",
    "content-security-policy-report-only",
    "X-Content-Type-Options",
    "Cache-Control",
    "Set-Cookie",
    "Clear-Site-Data",
    "Refresh",
  ]) {
    assert.throws(
      () =>
        validateMockResponse({
          status: 200,
          body: "fixture",
          headers: { [name]: "fixture" },
        }),
      /隔离/,
    );
  }
});
test("actual Mock HTML responses are sandboxed and never cacheable at the workbench origin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mock-isolation-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const project = await app.store.create("Isolated Mock");
  project.requests = [
    {
      id: "html",
      url: "http://localhost",
      examples: [
        {
          status: 200,
          body: "<h1>fixture</h1><script>globalThis.__mockExecuted=true</script>",
          headers: { "content-type": "text/html" },
        },
      ],
    },
  ];
  await app.store.save(project);
  const response = await fetch(`${app.url}/mock/${project.id}/html`);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-security-policy") || "",
    /(?:^|;)\s*sandbox\s*(?:;|$)/,
  );
  assert.match(
    response.headers.get("content-security-policy"),
    /default-src 'none'/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await response.text(), project.requests[0].examples[0].body);
  project.requests[0].examples.push({
    status: 200,
    body: "blocked",
    headers: { "Set-Cookie": "fixture_cookie=1; Path=/" },
  });
  await app.store.save(project);
  const blocked = await fetch(`${app.url}/mock/${project.id}/html?example=1`);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.headers.get("set-cookie"), null);
  assert.match(await blocked.text(), /隔离/);
});
