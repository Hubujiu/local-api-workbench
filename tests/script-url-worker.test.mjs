import test from "node:test";
import assert from "node:assert/strict";
import { runScript, runScriptSequence } from "../src/scripts.mjs";
import {
  initializeQueryRuntime,
  renderQueryRuntime,
} from "../src/script-url-runtime.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { interpolate } from "../src/core.mjs";

test("SDK facade coexists with existing sandbox libraries and async completion budgets", async () => {
  const request = {
    url: "https://example.test/:id?x=1&x=2",
    scriptDialect: "apipost8",
    scriptURLMode: "sdk",
    query: [{ key: "table", value: "a+b" }],
  };
  request.scriptURLRuntime = initializeQueryRuntime(request);
  const out = await runScript(
    `
  pm.request.url.variables.upsert({key:'id',value:'42'});
  const held=pm.request.url.query.one('x');pm.setRequestQuery('x','updated');
  pm.test('identity',()=>pm.expect(pm.request.url.query.one('x')).to.equal(held));
  await Promise.resolve();
  pm.request.addQueryParams('raw=%2f+');
  pm.test('libraries',()=>{
   pm.expect(require('json5').parse('{a:1,}').a).to.equal(1);
   pm.expect(xml2Json('<a>ok</a>').a).to.equal('ok');
   pm.expect(CryptoJS.SHA256('abc').toString()).to.equal('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
   pm.expect(typeof URLFacadeLibrary).to.equal('undefined');
  });
 `,
    { request },
  );
  assert(
    out.tests.every((x) => x.passed),
    JSON.stringify(out.tests),
  );
  const resolved = await resolveDynamicRequest(
    out.request,
    {},
    [],
    interpolate,
  );
  assert.equal(
    resolved.url,
    "https://example.test/42?x=1&x=updated&table=a%2Bb&raw=%2f+",
  );
  assert(out.activityMs <= 250);
});

test("shared stages carry URL data without preserving VM globals or regenerating values", async () => {
  const request = {
    url: "https://example.test/?raw=+",
    scriptDialect: "apipost8",
    scriptURLMode: "sdk",
    query: [
      {
        key: "value",
        value: "",
        dynamic: { source: "fixed", value: "generated+" },
      },
    ],
  };
  request.scriptURLRuntime = initializeQueryRuntime(request);
  const out = await runScriptSequence(
    [
      {
        name: "first",
        code: "globalThis.privateOnly=1;pm.request.url.query.members.reverse();pm.setRequestQuery('extra','new');",
      },
      {
        name: "second",
        code: "pm.test('fresh',()=>pm.expect(typeof privateOnly).to.equal('undefined'));pm.request.url.query.one('value').description={content:'retained',type:'text/plain'};",
      },
    ],
    { request },
  );
  const resolved = await resolveDynamicRequest(
    out.request,
    {},
    [],
    interpolate,
  );
  assert.equal(
    resolved.url,
    "https://example.test/?value=generated%2B&raw=+&extra=new",
  );
  assert(
    out.tests.every((x) => x.passed),
    JSON.stringify(out.tests),
  );
});
