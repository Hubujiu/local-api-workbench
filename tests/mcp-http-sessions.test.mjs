import test from "node:test";
import assert from "node:assert/strict";
import { MCPHTTPSessions } from "../src/mcp-http-sessions.mjs";

test("MCP HTTP sessions isolate typed request IDs, late notifications and policy epochs", () => {
  const registry = new MCPHTTPSessions();
  const a = registry.create(),
    b = registry.create();
  const one = registry.begin(a, 1, true),
    other = registry.begin(b, 1, true);
  const stringID = registry.begin(a, "1", true);
  registry.cancel(a, 1);
  assert(one.signal.aborted);
  assert(one.cancelledByNotification);
  assert(!other.signal.aborted);
  assert(!stringID.signal.aborted);
  one.finish();
  assert.throws(() => registry.begin(a, 1, true), /reused/);
  registry.cancel(a, 999);
  registry.cancel(a, {});
  assert(!stringID.signal.aborted);
  registry.advance();
  assert(other.signal.aborted && stringID.signal.aborted);
  assert(!other.cancelledByNotification);
  assert(registry.get(a));
  const next = registry.begin(a, 2, true);
  stringID.finish();
  other.finish();
  registry.cancel(a, 1);
  assert(!next.signal.aborted);
  assert(registry.delete(a));
  assert(next.signal.aborted);
  next.finish();
  next.finish();
  assert.equal(registry.get(a), undefined);
  registry.advance({ dropSessions: true });
  assert.equal(registry.get(b), undefined);
});

test("MCP HTTP routing is bounded without expiring handlers still saving evidence", () => {
  let now = 0;
  const registry = new MCPHTTPSessions({
    now: () => now,
    maxSessions: 1,
    idleMs: 10,
    maxRequests: 2,
  });
  const id = registry.create();
  const mutation = registry.begin(id, 0, false);
  now = 20;
  registry.advance();
  assert.throws(() => registry.create(), /limit/);
  mutation.finish();
  const query = registry.begin(id, 1, true);
  assert.throws(() => registry.begin(id, 2, true), /request limit/);
  registry.cancel(id, 1);
  assert(query.signal.aborted);
  query.finish();
  now = 40;
  assert.notEqual(registry.create(), id);
  const fresh = registry.create.bind(registry);
  assert.throws(fresh, /limit/);
});

test("MCP request IDs are bounded and invalid IDs consume no execution lease", () => {
  const registry = new MCPHTTPSessions(),
    id = registry.create();
  for (const invalid of [null, {}, [], Infinity, 1.5, "中".repeat(86)])
    assert.throws(() => registry.begin(id, invalid, true), /request ID/);
  const value = registry.begin(id, "中".repeat(85), false);
  value.finish();
  assert.throws(() => registry.begin(id, "中".repeat(85), true), /reused/);
});

test("invalid initialize IDs cannot exhaust session slots", () => {
  const registry = new MCPHTTPSessions({ maxSessions: 1 });
  for (const invalid of [null, {}, "x".repeat(257), 1.5])
    assert.throws(() => registry.create(invalid), /request ID/);
  assert(registry.create(0));
});
