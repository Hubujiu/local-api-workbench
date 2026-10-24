import test from "node:test";
import assert from "node:assert/strict";
import { resolveApipostFunctionTemplate } from "../src/apipost-function-templates.mjs";
import { parseApipostFunctionTemplate } from "../public/apipost-function-template.js";

test("native variable paths preserve own dotted-key precedence and array indexes", async () => {
  for (const [expression, variables, expected] of [
    ["{{data.token|upper}}", { data: { token: "nested" } }, "NESTED"],
    [
      "{{data.token|upper}}",
      { data: { token: "nested" }, "data.token": "flat" },
      "FLAT",
    ],
    [
      "{{data.items.0.name|upper}}",
      { data: { items: [{ name: "first" }] } },
      "FIRST",
    ],
    ["{{data.length|number}}", { data: "abc" }, 3],
    ["{{data.missing|upper}}", { data: {} }, "{{DATA.MISSING}}"],
  ])
    assert.equal(
      await resolveApipostFunctionTemplate(expression, [], "body", variables),
      expected,
    );
});

test("variable path traversal never calls accessors or walks prototype properties", async () => {
  let calls = 0;
  const data = {};
  Object.defineProperty(data, "token", {
    get() {
      calls++;
      return "bad";
    },
  });
  await assert.rejects(
    resolveApipostFunctionTemplate("{{data.token|upper}}", [], "body", {
      data,
    }),
    /访问器/,
  );
  assert.equal(calls, 0);
  const inherited = Object.create({ token: "inherited" });
  assert.equal(
    await resolveApipostFunctionTemplate("{{data.token|upper}}", [], "body", {
      data: inherited,
    }),
    "{{DATA.TOKEN}}",
  );
  for (const name of [
    "data.__proto__.x",
    "data.constructor.name",
    "data.prototype",
    "data..token",
    "data.items[0]",
    "data.items.10000",
    "a.b.c.d.e.f.g.h.i",
    "a".repeat(101),
  ])
    assert.throws(() => parseApipostFunctionTemplate("{{" + name + "|upper}}"));
});
