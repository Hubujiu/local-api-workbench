import test from "node:test";
import assert from "node:assert/strict";
import { fillHTTPDesignSchema } from "./helpers/http-design-source-ui.mjs";

test("schema fills open the visible source disclosure only when needed", async () => {
  let details = { open: false };
  const events = [];
  const editor = {
    async waitFor(options) {
      assert.deepEqual(options, { state: "visible" });
      assert.equal(details.open, true);
    },
    async fill(value) {
      events.push(value);
    },
  };
  const source = {
    async evaluate(readState) {
      return readState(details);
    },
    locator(selector) {
      if (selector === "#schema") return editor;
      assert.equal(selector, ":scope > summary");
      return {
        filter({ hasText }) {
          assert.match("JSON Schema 源编辑", hasText);
          return {
            async click() {
              events.push("open");
              details.open = !details.open;
            },
          };
        },
      };
    },
  };
  const page = {
    locator(selector) {
      assert.equal(selector, ".http-design-page .design-schema-source");
      return source;
    },
  };
  await fillHTTPDesignSchema(page, "{}");
  await fillHTTPDesignSchema(page, '{"type":"object"}');
  details = { open: false };
  await fillHTTPDesignSchema(page, '{"type":"string"}');
  assert.deepEqual(events, [
    "open",
    "{}",
    '{"type":"object"}',
    "open",
    '{"type":"string"}',
  ]);
});
