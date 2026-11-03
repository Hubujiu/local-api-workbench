import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selectMockResponse, validateMockRules } from "../src/mock.mjs";
import { createApp } from "../src/server.mjs";

const largeValue = "x".repeat(64 * 1024);
function definition() {
  const conditions = Array.from({ length: 49 }, () => ({
    target: "body.value",
    op: "neq",
    value: "never",
  }));
  conditions.push({ target: "body.value", op: "eq", value: "never" });
  return {
    id: "ordinary",
    name: "Bounded ordinary Mock",
    url: "http://example.test",
    mockRules: Array.from({ length: 100 }, (_, index) => ({
      name: "rule-" + index,
      conditions: structuredClone(conditions),
      response: { status: 200, body: "matched" },
    })),
    examples: [{ status: 200, body: "fallback" }],
  };
}
function observeSerialization(t) {
  const original = JSON.stringify;
  let calls = 0;
  const hook = t.mock.method(JSON, "stringify", function (value, ...args) {
    if (value === largeValue) calls++;
    return original.call(this, value, ...args);
  });
  return { count: () => calls, restore: () => hook.mock.restore() };
}

test("ordinary conditions reject cumulative work without lowering rule counts or changing comparison semantics", () => {
  const request = definition();
  validateMockRules(request.mockRules);
  assert.equal(
    selectMockResponse(request, { body: { value: "small" } }).body,
    "fallback",
  );
  assert.throws(
    () => selectMockResponse(request, { body: { value: largeValue } }),
    /Mock.*(预算|总量|budget)/i,
    "admitted repeated comparisons must fail explicitly, not silently return fallback",
  );
  assert.equal(
    selectMockResponse(request, { body: { value: "small" } }).body,
    "fallback",
  );
});

test(
  "owner-saved ordinary Mock rejects expensive HTTP input and preserves later requests, other projects and restart state",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ordinary-mock-budget-"));
    let app = await createApp({ root, port: 0 });
    const close = async () => {
      app.server.closeAllConnections();
      await new Promise((done) => app.server.close(done));
    };
    t.after(async () => {
      await close();
      await rm(root, { recursive: true, force: true });
    });
    const owner = async (route, method = "GET", body) => {
      const response = await fetch(app.url + route, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert(response.ok, JSON.stringify(value));
      return value;
    };
    const first = await owner("/api/projects", "POST", { name: "Rules owner" });
    first.requests = [definition()];
    await owner("/api/projects/" + first.id, "PUT", first);
    const other = await owner("/api/projects", "POST", {
      name: "Unrelated owner",
    });
    other.requests = [
      {
        id: "healthy",
        name: "healthy",
        url: "http://example.test",
        examples: [{ status: 201, body: "other-project" }],
      },
    ];
    await owner("/api/projects/" + other.id, "PUT", other);
    const before = await app.store.get(first.id);
    const input = JSON.stringify({ value: largeValue });
    const observer = observeSerialization(t);
    let rejected, payload, calls;
    try {
      rejected = await fetch(app.url + "/mock/" + first.id + "/ordinary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: input,
      });
      payload = await rejected.text();
      calls = observer.count();
    } finally {
      observer.restore();
    }
    const small = await fetch(app.url + "/mock/" + first.id + "/ordinary", {
      method: "POST",
      body: JSON.stringify({ value: "small" }),
    });
    assert.equal(small.status, 200);
    assert.equal(await small.text(), "fallback");
    const healthy = await fetch(app.url + "/mock/" + other.id + "/healthy");
    assert.equal(healthy.status, 201);
    assert.equal(await healthy.text(), "other-project");
    assert.deepEqual(await app.store.get(first.id), before);
    await close();
    app = await createApp({ root, port: 0 });
    assert.deepEqual(await app.store.get(first.id), before);
    const restarted = await fetch(app.url + "/mock/" + first.id + "/ordinary", {
      method: "POST",
      body: JSON.stringify({ value: "small" }),
    });
    assert.equal(await restarted.text(), "fallback");
    t.diagnostic("large-value serializations: " + calls);
    // Keep the failure and cleanup observations independent from scheduler speed.
    assert.equal(
      rejected.status,
      400,
      "must not acknowledge exhausted comparison work as fallback success",
    );
    assert.match(payload, /Mock.*(预算|总量|budget)/i);
    assert(
      calls <= 17,
      "large actual value was serialized beyond the 1 MiB logical comparison envelope: " +
        calls,
    );
  },
);
