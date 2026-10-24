import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
test("isolated lodash moment and uuid expose useful globals and exact aliases", async () => {
  const r = await runScript(
    `
 pm.test('same modules',()=>{pm.expect(require('lodash')).to.equal(_);pm.expect(require('moment')).to.equal(moment);pm.expect(require('uuid')).to.equal(uuid)});
 apt.setVar('grouped',_.mapValues(_.groupBy([{k:'a',v:1},{k:'a',v:2},{k:'b',v:3}],'k'),g=>_.sumBy(g,'v')));
 apt.setVar('date',moment.utc('2024-02-28').add(1,'day').format('YYYY-MM-DD'));
 apt.setVar('chinese',moment.utc('2024-02-29').locale('zh-cn').format('MMMM'));
 const id=uuid.v4();apt.setVar('uuid',id);pm.test('uuid',()=>{pm.expect(uuid.validate(id)).to.equal(true);pm.expect(uuid.version(id)).to.equal(4)});
 apt.setVar('v5',uuid.v5('www.widgets.com',uuid.v5.DNS));
 `,
    { variables: {} },
  );
  assert.deepEqual(r.variables.grouped, { a: 3, b: 3 });
  assert.equal(r.variables.date, "2024-02-29");
  assert.equal(r.variables.chinese, "二月");
  assert.match(r.variables.uuid, /^[a-f0-9-]{36}$/);
  assert.equal(r.variables.v5, "21f7f8de-8051-5b89-8680-0195ef798b6a");
  assert(r.tests.every((x) => x.passed));
});
test("utility timers and templates retain completion and isolation boundaries", async () => {
  const r = await runScript(
    `const later=_.debounce(value=>apt.setVar('value',value),5);later(1);later(2);apt.setVar('template',_.template('Hello <%= name %>')({name:'fixture'}));pm.test('no host',()=>{pm.expect(typeof process).to.equal('undefined');pm.expect(typeof fetch).to.equal('undefined')});`,
    { variables: {} },
  );
  assert.equal(r.variables.value, 2);
  assert.equal(r.variables.template, "Hello fixture");
  assert(r.tests.every((x) => x.passed));
  await assert.rejects(
    runScript("require('node:fs')", { variables: {} }),
    /不允许/,
  );
  await assert.rejects(
    runScript("_.template('<% while(true){} %>')({})", { variables: {} }),
    /超时|interrupt|终止/,
  );
});

test("script output cap counts UTF-8 bytes rather than JavaScript code units", async () => {
  await assert.rejects(
    runScript("apt.setVar('wide','中'.repeat(200000));", { variables: {} }),
    /脚本输出超过 1 MiB/,
  );
});
