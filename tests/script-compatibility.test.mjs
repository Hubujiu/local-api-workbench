import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";
test("pm variables resolve narrowest scope while set/unset remain request-local", async () => {
  const result = await runScript(
    `
  pm.test("fallback",()=>pm.expect(pm.variables.get("n")).to.equal(4));
  pm.test("global",()=>pm.expect(pm.variables.has("g")).to.equal(true));
  pm.variables.set("n",0);pm.test("zero",()=>pm.expect(pm.variables.get("n")).to.equal(0));
  pm.variables.unset("n");pm.test("revealed",()=>pm.expect(pm.variables.get("n")).to.equal(4));
  postman.setEnvironmentVariable("saved",9);postman.setGlobalVariable("zero",0);
  pm.test("object",()=>pm.expect(pm.variables.toObject()).to.have.property("saved",9));
 `,
    {
      variables: {},
      scopes: {
        globals: { g: 1, n: 2 },
        environment: { n: 3 },
        runtime: { n: 4 },
        hidden: [],
      },
    },
  );
  assert(
    result.tests.every((item) => item.passed),
    JSON.stringify(result.tests),
  );
  assert.equal(result.scopes.environment.saved, 9);
  assert.equal(result.scopes.globals.zero, 0);
  assert.equal(result.localVariables.n, undefined);
});
test("Postman header/raw-body facade edits the request without leaking API methods into serialization", async () => {
  const result = await runScript(
    `
 pm.request.headers.upsert({key:"x-id",value:"new"});
 pm.request.headers.add({key:"x-extra",value:"yes"});
 pm.request.headers.remove("X-Remove");
 pm.test("case",()=>pm.expect(pm.request.headers.get("X-ID")).to.equal("new"));
 pm.request.method="post";pm.request.body.update({mode:"raw",raw:'{"x":1}',options:{raw:{language:"json"}}});
 `,
    {
      variables: {},
      request: {
        method: "GET",
        url: "https://example.test",
        headers: [
          { key: "X-ID", value: "old", description: "kept" },
          { key: "X-Remove", value: "gone" },
        ],
        body: "",
        bodyType: "none",
      },
    },
  );
  assert.equal(result.request.method, "POST");
  assert.equal(result.request.bodyType, "json");
  assert.equal(result.request.headers[0].description, "kept");
  assert.equal(result.request.headers[0].value, "new");
  assert(!result.request.headers.some((row) => row.key === "X-Remove"));
  assert(result.tests.every((item) => item.passed));
});
test("legacy response/raw/json/cookies and apt.assert preserve failure evidence inside the VM", async () => {
  const result = await runScript(
    `
 apt.assert('response.raw.status === 200 && response.json.x === 1');
 apt.assert('response.raw.responseTime === 12');
 apt.assert('response.raw.status === 500');
 pm.test("header",()=>pm.expect(pm.response.headers.get("X-Test")).to.equal("yes"));
 pm.test("cookie",()=>pm.expect(pm.cookies.get("sid")).to.equal("a b"));
 apt.setVar("cookie",postman.getResponseCookie("sid").value);
 apt.assert('typeof process === "undefined"');
 `,
    {
      variables: {},
      response: {
        status: 200,
        duration: 12,
        body: '{"x":1}',
        headers: { "X-Test": "yes", "set-cookie": ["sid=a%20b; Path=/"] },
      },
    },
  );
  assert.deepEqual(
    result.tests.map((item) => item.passed),
    [true, true, false, true, true, true],
  );
  assert.equal(result.variables.cookie, "a b");
});
test("header facade affects a real HTTP request and legacy assertions affect final outcome", async (t) => {
  const http = await import("node:http");
  const { executeRequest } = await import("../src/runtime.mjs");
  let captured;
  const server = http.createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    captured = {
      headers: request.headers,
      body: Buffer.concat(parts).toString(),
    };
    response.setHeader("content-type", "application/json");
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: "http://127.0.0.1:" + server.address().port,
          method: "POST",
          beforeScript:
            'pm.request.headers.upsert({key:"x-proof",value:"wire"}); pm.request.body.update({mode:"raw",raw:\'{"sent":true}\',options:{raw:{language:"json"}}});',
          afterScript:
            'apt.assert("response.raw.status === 200 && response.json.ok === true");',
        },
      },
    ],
  });
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(captured.headers["x-proof"], "wire");
  assert.equal(captured.body, '{"sent":true}');
  assert.equal(result.status, "passed");
  plan.steps[0].request.afterScript =
    'apt.assert("response.raw.status === 201");';
  assert.equal((await runPlan(plan, {}, executeRequest)).status, "failed");
});
test("unsupported async assertions never report a false pass and assertion count is bounded", async () => {
  const result = await runScript(
    'pm.test("promise",async()=>{throw Error("must not pass")});pm.test("callback",done=>{});',
    { variables: {} },
  );
  assert.deepEqual(
    result.tests.map((item) => item.passed),
    [false, false],
  );
  assert(result.tests.every((item) => item.error.includes("异步断言")));
  await assert.rejects(
    runScript('for(let i=0;i<1001;i++)pm.test("bounded",()=>{});', {
      variables: {},
    }),
    /最多1000/,
  );
});
