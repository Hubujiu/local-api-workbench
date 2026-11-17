import test from "node:test";
import assert from "node:assert/strict";
import { extractXML } from "../src/xml-extraction.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";
test("XML XPath extracts text, attributes, typed scalars and namespaces with first-node semantics", async () => {
  const xml =
    '<root xmlns:m="urn:test"><m:item id="a">first &amp; safe</m:item><m:item id="b">second</m:item></root>';
  assert.equal(
    await extractXML(xml, "/root/m:item[1]/text()", { m: "urn:test" }),
    "first & safe",
  );
  assert.equal(
    await extractXML(xml, "/root/m:item/@id", { m: "urn:test" }),
    "a",
  );
  assert.equal(
    await extractXML(xml, "count(/root/m:item)", { m: "urn:test" }),
    2,
  );
  assert.equal(
    await extractXML(xml, "boolean(/root/m:missing)", { m: "urn:test" }),
    false,
  );
  await assert.rejects(
    extractXML(xml, "/root/m:missing/text()", { m: "urn:test" }),
    /没有匹配/,
  );
});
test("XML rejects DTD/entity payloads, malformed documents, oversized input and unsafe namespace maps", async () => {
  for (const xml of [
    '<!DOCTYPE root SYSTEM "file:///etc/passwd"><root/>',
    '<!DOCTYPE root [<!ENTITY x "a">]><root>&x;</root>',
  ])
    assert.throws(() => extractXML(xml, "/root"), /禁止 DTD/);
  await assert.rejects(extractXML("<root><open></root>", "/root"), /XML 格式/);
  await assert.rejects(
    extractXML("<root>&unknown;</root>", "/root"),
    /XML 格式/,
  );
  assert.throws(
    () => extractXML("x".repeat(1024 * 1024 + 1), "/root"),
    /1 MiB/,
  );
  assert.throws(
    () => extractXML("<root/>", "/root", JSON.parse('{"__proto__":"x"}')),
    /映射无效/,
  );
  await assert.rejects(extractXML("<root/>", "/["), /./);
});
test("XML extraction integrates with plan evidence and subsequent variable interpolation", async () => {
  const seen = [];
  const result = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            url: "http://fixture.test",
            extract: [{ name: "id", source: "xml", path: "/root/id/text()" }],
          },
        },
        { request: { url: "http://fixture.test/{{id}}" } },
      ],
    }),
    {},
    async (request) => {
      seen.push(request.url);
      return {
        status: 200,
        body: "<root><id>42</id></root>",
        headers: {},
        duration: 1,
      };
    },
  );
  assert.equal(result.status, "passed");
  assert.equal(seen[1], "http://fixture.test/42");
});
