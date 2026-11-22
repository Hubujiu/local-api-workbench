import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { normalizeRequest } from "../src/core.mjs";
import {
  defaultNewHTTPTimeout,
  readNewHTTPTimeout,
  newHTTPTimeoutKey,
  saveNewHTTPTimeout,
  validateNewHTTPTimeout,
} from "../public/send-settings.js";

test("the local new manual HTTP default is bounded and failure does not replace it", () => {
  const values = new Map();
  const storage = {
    getItem: values.get.bind(values),
    setItem: values.set.bind(values),
    removeItem: values.delete.bind(values),
  };
  assert.equal(readNewHTTPTimeout(storage), 15000);
  assert.equal(normalizeRequest().timeout, 15000);
  for (const [raw, runtime] of [
    ["100", 100],
    ["60000", 60000],
    [" 24000 ", 24000],
  ]) {
    assert.equal(validateNewHTTPTimeout(raw), runtime);
    assert.equal(saveNewHTTPTimeout(storage, raw), true);
    assert.equal(readNewHTTPTimeout(storage), runtime);
  }
  for (const invalid of ["", null, -500, 99, 60001, "12.2", "1e4", "+100"]) {
    assert.equal(validateNewHTTPTimeout(invalid), null);
    assert.equal(saveNewHTTPTimeout(storage, invalid), false);
    assert.equal(readNewHTTPTimeout(storage), 24000);
  }
  assert.equal(saveNewHTTPTimeout(storage, defaultNewHTTPTimeout), true);
  assert(!values.has(newHTTPTimeoutKey));
  values.set(newHTTPTimeoutKey, "bad local value");
  assert.equal(readNewHTTPTimeout(storage), 15000);
});

test("only actual manual request creation consumes this preference; defaults and startup remain independent", async () => {
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  assert.equal(app.match(/readNewHTTPTimeout\(localStorage\)/g).length, 1);
  const start = app.indexOf("function addRequest() {");
  const end = app.indexOf("function assertExecutionReady()", start);
  assert(start >= 0 && end > start);
  assert.match(
    app.slice(start, end),
    /r\.timeout = readNewHTTPTimeout\(localStorage\)/,
  );
  assert.match(
    app,
    /function defaultRequest\(name = "新建接口"\) \{[\s\S]*?timeout: 15000,/,
  );
});
