import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
test("isolated xml2Json converts element text repeated children attributes and CDATA without host objects", async () => {
  const text =
    '<?xml version="1.0"?><note id="7"><to>Ada &amp; Bob</to><item>one</item><item><![CDATA[two<3]]></item><empty/><tag code="x">value</tag></note>';
  const result = await runScript(
    'apt.setVar("parsed",xml2Json(pm.response.text()));pm.test("no DOM host",()=>pm.expect(typeof DOMParser).to.equal("undefined"));',
    { response: { status: 200, body: text, headers: {} } },
  );
  assert.deepEqual(result.variables.parsed, {
    note: {
      $: { id: "7" },
      to: "Ada & Bob",
      item: ["one", "two<3"],
      empty: "",
      tag: { $: { code: "x" }, _: "value" },
    },
  });
  assert(
    result.tests.every((t) => t.passed),
    JSON.stringify(result.tests),
  );
});
for (const [name, expression] of [
  ["type", "null"],
  ["malformed", JSON.stringify("<a><b></a>")],
  [
    "DTD",
    JSON.stringify(
      '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///not-read">]><a>&x;</a>',
    ),
  ],
  ["unknown entity", JSON.stringify("<a>&unknown;</a>")],
  ["mixed content", JSON.stringify("<a>mixed<b/>text</a>")],
  ["options", '"<a/>",{}'],
  ["bytes", "'<a>'+\"中\".repeat(22000)+'</a>'"],
  ["depth", "'<a>'.repeat(34)+'</a>'.repeat(34)"],
  ["nodes", "'<a>'+'<b/>'.repeat(10001)+'</a>'"],
]) {
  test("XML rejects " + name + " within one normal script budget", async () => {
    const r = await runScript(
      `pm.test("reject",()=>pm.expect(()=>xml2Json(${expression})).to.throw(/XML/));`,
      {},
    );
    assert.equal(r.tests.length, 1);
    assert(r.tests[0].passed, JSON.stringify(r.tests));
  });
}
test("XML element names stay data and namespace-qualified names remain explicit", async () => {
  const r = await runScript(
    'apt.setVar("parsed",xml2Json(\'<root xmlns:p="urn:test"><p:item>42</p:item><__proto__>safe</__proto__><constructor>text</constructor></root>\'));pm.test("prototype",()=>pm.expect({}.safe).to.equal(undefined));',
    {},
  );
  assert.equal(r.variables.parsed.root["p:item"], "42");
  assert(Object.hasOwn(r.variables.parsed.root, "__proto__"));
  assert.equal(r.variables.parsed.root.__proto__, "safe");
  assert.equal(r.variables.parsed.root.constructor, "text");
  assert(r.tests.every((t) => t.passed));
});

test("XML preflight ignores literal markup in CDATA and comments", async () => {
  const r = await runScript(
    `const literal="<b/>".repeat(10001);
 pm.test("CDATA",()=>pm.expect(xml2Json("<a><![CDATA["+literal+"]]></a>").a).to.equal(literal));
 pm.test("comments",()=>pm.expect(xml2Json("<a><!--"+literal+"--></a>").a).to.equal(""));`,
    {},
  );
  assert.equal(r.tests.length, 2);
  assert(
    r.tests.every((t) => t.passed),
    JSON.stringify(r.tests),
  );
});
