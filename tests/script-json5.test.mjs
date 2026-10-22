import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";

test("isolated JSON5 supports comments, unquoted keys, trailing commas and serialization", async () => {
  const result = await runScript(
    `const value=JSON5.parse("{/*comment*/name:'demo',items:[1,2,],hex:0xff,}");apt.setVar('value',value);apt.setVar('roundtrip',JSON5.parse(require('json5').stringify(value,null,2)));`,
    { variables: {} },
  );
  assert.deepEqual(result.variables.value, {
    name: "demo",
    items: [1, 2],
    hex: 255,
  });
  assert.deepEqual(result.variables.roundtrip, result.variables.value);
});

test("JSON5 rejects byte excess and cannot pollute the VM object prototype", async () => {
  await assert.rejects(
    runScript(`JSON5.parse(' '.repeat(65537));`, { variables: {} }),
    /64KiB/,
  );
  await assert.rejects(
    runScript(`JSON5.stringify({text:'字'.repeat(30000)});`, { variables: {} }),
    /64KiB/,
  );
  const result = await runScript(
    `const data=JSON5.parse('{__proto__:{polluted:true}}'); apt.setVar('clean',({}).polluted===undefined);apt.setVar('own',Object.prototype.hasOwnProperty.call(data,'__proto__'));`,
    { variables: {} },
  );
  assert.equal(result.variables.clean, true);
  assert.equal(result.variables.own, true);
  await assert.rejects(
    runScript(`JSON5.parse('{broken:}');`, { variables: {} }),
    /JSON5|invalid/,
  );
});

test("JSON5 callbacks run in the VM and stringify preflight is bounded", async () => {
  const result = await runScript(
    `apt.setVar('revived',JSON5.parse('{n:2}',(key,value)=>key==='n'?value*3:value));apt.setVar('filtered',JSON5.parse(JSON5.stringify({keep:1,omit:2},['keep'])));apt.setVar('undefined',JSON5.stringify(undefined)===undefined);`,
    { variables: {} },
  );
  assert.deepEqual(result.variables.revived, { n: 6 });
  assert.deepEqual(result.variables.filtered, { keep: 1 });
  assert.equal(result.variables.undefined, true);
  await assert.rejects(
    runScript(
      `let value={};for(let i=0;i<34;i++)value={child:value};JSON5.stringify(value);`,
      { variables: {} },
    ),
    /32层/,
  );
});
