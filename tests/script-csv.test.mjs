import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
test("bounded csv2array parses response CSV as string rows without treating its header as variables", async () => {
  const text = '\ufeffname,note\r\nAda,"a,b"\r\nBob,"a""b\nc"\r\n';
  const r = await runScript(
    'apt.setVar("rows",csv2array(pm.response.text()));',
    { response: { status: 200, body: text, headers: {} } },
  );
  assert.deepEqual(r.variables.rows, [
    ["name", "note"],
    ["Ada", "a,b"],
    ["Bob", 'a"b\nc'],
  ]);
  const edges = await runScript(
    'apt.setVar("empty",csv2array(""));apt.setVar("blank",csv2array(" "));apt.setVar("tail",csv2array("1,"));apt.setVar("literal",csv2array("__proto__,=1+1"));',
    {},
  );
  assert.deepEqual(edges.variables.empty, []);
  assert.deepEqual(edges.variables.blank, [[" "]]);
  assert.deepEqual(edges.variables.tail, [["1", ""]]);
  assert.deepEqual(edges.variables.literal, [["__proto__", "=1+1"]]);
});
test("CSV utility rejects malformed input options and byte row column excess inside the existing sandbox", async () => {
  const result = await runScript(
    `
 const invalid=[null, '"unfinished', '"closed"junk', 'a"b'];
 for(const [i,value] of invalid.entries())pm.test("invalid"+i,()=>pm.expect(()=>csv2array(value)).to.throw(/CSV/));
 pm.test("options",()=>pm.expect(()=>csv2array("a;b",{separator:";"})).to.throw(/CSV/));
 pm.test("bytes",()=>pm.expect(()=>csv2array("中".repeat(22000))).to.throw(/CSV/));
 pm.test("rows",()=>pm.expect(()=>csv2array(Array(1001).fill("a").join("\\n"))).to.throw(/CSV/));
 pm.test("cols",()=>pm.expect(()=>csv2array(Array(101).fill("a").join(","))).to.throw(/CSV/));
 `,
    {},
  );
  assert.equal(result.tests.length, 8);
  assert(
    result.tests.every((t) => t.passed),
    JSON.stringify(result.tests),
  );
});
