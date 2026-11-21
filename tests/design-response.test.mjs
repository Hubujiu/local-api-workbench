import assert from "node:assert/strict";
import test from "node:test";
import {
  designResponsePanel,
  responseSelection,
} from "../public/design-response.js";

const definitions = [
  {
    status: "200",
    description: "成功",
    content: { "application/json": { schema: { type: "object" } } },
  },
  {
    status: "404",
    description: "失败",
    content: {
      "text/plain": { schema: { type: "string" } },
      "application/json": { schema: false },
    },
  },
];

test("select by status identity and keep only an existing media choice", () => {
  const unchanged = structuredClone(definitions);
  const selected = responseSelection(definitions.toReversed(), {
    status: "404",
    media: "application/json",
  });
  assert.equal(selected.index, 0);
  assert.equal(selected.media, "application/json");
  assert.equal(
    responseSelection(definitions, { status: "404", media: "missing" }).media,
    "text/plain",
  );
  assert.deepEqual(definitions, unchanged);
});

test("do not invent statuses for a new request; preserve the editable raw area", () => {
  const html = designResponsePanel([]);
  assert.doesNotMatch(html, /200|404|role="tabpanel"/);
  assert.match(html, /new-response-schema/);
  assert.match(html, /response-definitions/);
});

test("preview safely escapes names and supports boolean JSON Schema without replacing it", () => {
  const html = designResponsePanel(
    [{ ...definitions[1], description: "<svg>" }],
    { status: "404", media: "application/json" },
  );
  assert.match(html, /&lt;svg&gt;（404）/);
  assert.match(html, /design-response-kind">false</);
  assert.doesNotMatch(html, /<svg>/);
});
