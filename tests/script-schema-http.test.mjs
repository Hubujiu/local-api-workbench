import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runScript } from "../src/scripts.mjs";

test("Schema assertions recognize brokered callback and Promise responses without duck typing", async (t) => {
  const body = JSON.stringify({ token: "fictional-test-token" });
  const server = http.createServer((req, res) =>
    res.end(req.url === "/invalid" ? "not json" : body),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const scriptDialect of ["legacy", "apipost8"]) {
    const result = await runScript(
      `
      const schema={type:'object',properties:{token:{type:'string'}},required:['token'],additionalProperties:false};
      await new Promise((resolve,reject)=>pm.sendRequest(${JSON.stringify(url)},(error,reply)=>{
        if(error){reject(error);return;}
        pm.test('callback',()=>pm.expect(reply).to.have.jsonSchema(schema));
        pm.test('negative',()=>pm.expect(reply).not.to.have.jsonSchema({type:'array'}));
        resolve();
      }));
      const reply=await apt.sendRequest(${JSON.stringify(url)});
      apt.test('promise',()=>apt.expect(reply).to.have.jsonSchema(schema));
      pm.test('main response retained',()=>pm.expect(pm.response).to.have.jsonSchema(schema));
      const invalid=await pm.sendRequest(${JSON.stringify(url + "/invalid")});
      pm.test('nonJSON is error',()=>pm.expect(invalid).not.to.have.jsonSchema(schema));
      let fakeCalls=0;
      pm.test('fake response is data',()=>pm.expect({json:()=>{fakeCalls++;return {token:'fake'}}}).to.have.jsonSchema(schema));
      apt.setVar('fakeCalls',fakeCalls);
      apt.setVar('registrationAPI',typeof globalThis.__registerSchemaResponse);
    `,
      {
        allowNetwork: true,
        request: { scriptDialect },
        response: { status: 200, body, headers: {} },
      },
    );
    const results = Object.fromEntries(
      result.tests.map((item) => [item.name, item.passed]),
    );
    assert.deepEqual(results, {
      callback: true,
      negative: true,
      promise: true,
      "main response retained": true,
      "nonJSON is error": false,
      "fake response is data": false,
    });
    assert.equal(result.variables.fakeCalls, 0);
    assert.equal(result.variables.registrationAPI, "undefined");
    assert.equal(result.networkRequests.length, 3);
    assert.deepEqual(
      result.networkRequests.map((item) => item.response.body),
      [body, body, "not json"],
    );
  }
});
