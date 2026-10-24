import test from "node:test";
import assert from "node:assert/strict";
import { applyMCPInput } from "../src/mcp-request-input.mjs";
const fixture = () => ({
  url: "http://localhost/{id}",
  method: "POST",
  path: [{ key: "id", value: "saved" }],
  query: [{ key: "q", value: "saved", enabled: false }],
  headers: [{ key: "X-Test", value: "saved" }],
  cookies: [{ key: "session", value: "saved" }],
  bodyType: "json",
  body: "{}",
  auth: { type: "basic", username: "old", password: "old" },
});
test("temporary input clones saved rows and preserves request configuration", () => {
  const saved = fixture(),
    before = structuredClone(saved);
  const result = applyMCPInput(saved, {
    path: { id: "new" },
    query: { q: 5 },
    headers: { "x-test": "new" },
    cookies: { session: "new" },
    body: { hello: true },
    auth: { password: "new" },
  });
  assert.deepEqual(saved, before);
  assert.equal(result.query[0].value, "5");
  assert.equal(result.query[0].enabled, true);
  assert.equal(result.headers[0].value, "new");
  assert.equal(result.path[0].value, "new");
  assert.equal(result.auth.username, "old");
  assert.equal(result.auth.password, "new");
  assert.deepEqual(JSON.parse(result.body), { hello: true });
  assert.equal(result.url, saved.url);
});
test("unknown overrides and auth type changes fail without mutating saved data", () => {
  for (const input of [
    { url: "http://evil" },
    { query: { missing: 1 } },
    { headers: { "X-Test": "a", "x-test": "b" } },
    { auth: { type: "bearer" } },
    { auth: { token: "new" } },
    { path: [] },
    null,
  ]) {
    const saved = fixture(),
      before = structuredClone(saved);
    assert.throws(() => applyMCPInput(saved, input));
    assert.deepEqual(saved, before);
  }
});
test("form overrides cannot introduce file data and raw bodies require strings", () => {
  const saved = {
    ...fixture(),
    bodyType: "form-data",
    form: [
      { key: "text", value: "old" },
      { key: "file", type: "file", value: "" },
    ],
  };
  assert.equal(
    applyMCPInput(saved, { body: { text: "new" } }).form[0].value,
    "new",
  );
  assert.throws(() => applyMCPInput(saved, { body: { file: "data" } }));
  assert.throws(() =>
    applyMCPInput({ ...saved, bodyType: "binary" }, { body: "YQ==" }),
  );
  assert.throws(() =>
    applyMCPInput({ ...saved, bodyType: "none" }, { body: "x" }),
  );
  assert.throws(() =>
    applyMCPInput({ ...saved, bodyType: "xml" }, { body: { a: 1 } }),
  );
  assert.equal(
    applyMCPInput({ ...saved, bodyType: "xml" }, { body: "<a/>" }).body,
    "<a/>",
  );
});

test("temporary inputs enforce JSON size and safety boundaries", () => {
  for (const input of [
    { body: NaN },
    { body: Infinity },
    { body: undefined },
    { body: "x".repeat(1024 * 1024) },
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { query: JSON.parse('{"constructor":"x"}') },
  ])
    assert.throws(() => applyMCPInput(fixture(), input));
  assert.equal({}.polluted, undefined);
  const saved = fixture();
  const clone = applyMCPInput(saved);
  clone.query[0].value = "different";
  assert.equal(saved.query[0].value, "saved");
  assert.equal(applyMCPInput(saved, { body: null }).body, "null");
});
