import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";

const response = {
  status: 200,
  body: '{"name":"Ada","email":"ada@example.test"}',
  headers: {},
};
const schema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 2 },
    email: { type: "string", format: "email" },
  },
  required: ["name", "email"],
  additionalProperties: false,
};

test("response and data jsonSchema assertions distinguish positive, negative and mismatched data", async () => {
  const result = await runScript(
    `
    const schema=${JSON.stringify(schema)};
    pm.test('response',()=>pm.response.to.have.jsonSchema(schema));
    pm.test('data',()=>pm.expect(pm.response.json()).to.have.jsonSchema(schema).and.have.property('name'));
    pm.test('invalid',()=>pm.expect({name:'A',email:'bad'}).to.have.jsonSchema(schema));
    pm.test('negative',()=>pm.expect({name:'A',email:'bad'}).not.to.have.jsonSchema(schema));
    pm.test('wrong negative',()=>pm.response.to.not.have.jsonSchema(schema));
  `,
    { response },
  );
  assert.deepEqual(
    result.tests.map((item) => item.passed),
    [true, true, false, true, false],
  );
  assert.match(result.tests[2].error, /schema|Schema/);
});

test("legacy and apipost8 aliases validate local references, booleans and formats without mutating data", async () => {
  for (const scriptDialect of ["legacy", "apipost8"]) {
    const result = await runScript(
      `
      const schema={$id:'urn:test:alpha-beta',type:'object',definitions:{'name-part':{type:'string',minLength:2}},properties:{name:{$ref:'#/definitions/name-part'},email:{type:'string',format:'email'}},required:['name','email']};
      apt.test('response',()=>apt.response.to.have.jsonSchema(schema));
      apt.test('data',()=>apt.expect({name:'Ada',email:'ada@example.test'}).to.have.jsonSchema(schema));
      pm.test('false',()=>pm.expect(1).not.to.have.jsonSchema(false));
      pm.test('true',()=>pm.expect(null).to.have.jsonSchema(true));
      const data={count:'2'};pm.test('nonmutating',()=>pm.expect(data).not.to.have.jsonSchema({type:'object',properties:{count:{type:'number'}}}));
      apt.setVar('data',data);apt.setVar('host',typeof process);
    `,
      { response, request: { scriptDialect } },
    );
    assert.ok(
      result.tests.every((item) => item.passed),
      JSON.stringify(result.tests),
    );
    assert.deepEqual(result.variables.data, { count: "2" });
    assert.equal(result.variables.host, "undefined");
  }
});

test("malformed schemas, unsupported dialects and external references cannot succeed through negation", async () => {
  const result = await runScript(
    `
    for (const schema of [
      {type:'unknown'}, {minLength:-1}, {pattern:'['},
      {$schema:'https://json-schema.org/draft/2020-12/schema'},
      {unevaluatedProperties:false}, {format:'unknown-format'},
      {$ref:'https://example.invalid/schema.json'}, {$async:true}
    ]) pm.test('invalid schema',()=>pm.expect('x').not.to.have.jsonSchema(schema));
    pm.test('invalid options',()=>pm.expect('2').not.to.have.jsonSchema({type:'number'},{coerceTypes:true}));
  `,
    { response, allowNetwork: true },
  );
  assert.ok(
    result.tests.every((item) => !item.passed),
    JSON.stringify(result.tests),
  );
  assert.equal(result.networkRequests.length, 0);
});

test("bounded schema caches retain semantics after eviction and treat annotation payloads as data", async () => {
  const result = await runScript(
    `
    pm.test('cache eviction',()=>{
      for(let i=0;i<10;i++) pm.expect(i).to.have.jsonSchema({$id:'urn:test:cache',type:'integer',minimum:i,maximum:i});
      pm.expect(0).to.have.jsonSchema({$id:'urn:test:cache',type:'integer',minimum:0,maximum:0});
      pm.expect(2).not.to.have.jsonSchema({$id:'urn:test:cache',type:'integer',minimum:0,maximum:0});
    });
    pm.test('literal payloads',()=>pm.expect({$ref:'literal'}).to.have.jsonSchema({type:'object',properties:{$ref:{type:'string'}},default:{$ref:'https://literal.invalid/schema'},'x-note':{unevaluatedProperties:false}}));
    pm.test('own properties',()=>pm.expect({}).not.to.have.jsonSchema({required:['toString']}));
  `,
    {},
  );
  assert.ok(
    result.tests.every((item) => item.passed),
    JSON.stringify(result.tests),
  );
  assert.equal(result.tests.length, 3);
});

test("missing or malformed JSON responses do not count as negative schema matches", async () => {
  for (const input of [
    {},
    { response: { status: 200, body: "not json", headers: {} } },
  ]) {
    const result = await runScript(
      "pm.test('missing JSON',()=>pm.response.to.not.have.jsonSchema({type:'object'}));",
      input,
    );
    assert.equal(result.tests[0].passed, false);
  }
});

test("schema size, depth, JSON validity and options remain bounded", async () => {
  const result = await runScript(
    `
    const deep={};let cursor=deep;for(let i=0;i<40;i++){cursor.properties={a:{}};cursor=cursor.properties.a;}
    const cyclic={};cyclic.not=cyclic;
    for(const schema of [deep,cyclic,{description:'雪'.repeat(30000)},{type:undefined}])
      pm.test('invalid bounded schema',()=>pm.expect('x').not.to.have.jsonSchema(schema));
    pm.test('unsupported loader',()=>pm.expect('x').not.to.have.jsonSchema({}, {loadSchema:()=>({})}));
  `,
    { response },
  );
  assert.ok(
    result.tests.every((item) => !item.passed),
    JSON.stringify(result.tests),
  );
});

test("real HTTP plans report schema assertion failures without replacing transport evidence", async (t) => {
  const http = await import("node:http");
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        name: "Ada",
        email: req.url === "/bad" ? "invalid" : "ada@example.test",
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const plan = snapshotPlan({
    steps: ["/good", "/bad"].map((path) => ({
      request: {
        url: url + path,
        afterScript: `pm.test('schema match',()=>pm.response.to.have.jsonSchema(${JSON.stringify(schema)}));`,
      },
    })),
  });
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.results.map((item) => item.status),
    ["passed", "failed"],
  );
  assert.equal(result.results[1].response.status, 200);
  assert.equal(JSON.parse(result.results[1].response.body).email, "invalid");
  assert.ok(
    result.results[1].assertions.some(
      (item) => item.name === "schema match" && !item.passed,
    ),
  );
});
