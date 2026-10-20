import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
const response = {
  status: 201,
  statusText: "Created",
  duration: 8,
  body: '{"value":7}',
  headers: {
    "content-type": "application/json",
    "set-cookie": ["session=hello%20world; Path=/"],
  },
};
test("Apipost response uses parsed JSON and keyed headers/cookies while Postman keeps callable readers", async () => {
  const result = await runScript(
    `
 apt.test("json property",()=>apt.expect(apt.response.json.value).to.equal(7));
 apt.test("header key",()=>apt.expect(apt.response.headers["Content-Type"]).to.equal("application/json"));
 apt.test("cookie key",()=>apt.expect(apt.response.cookies.session).to.equal("hello world"));
 pm.test("postman methods",()=>{pm.expect(pm.response.json().value).to.equal(7);pm.expect(pm.response.headers.get("CONTENT-TYPE")).to.equal("application/json");pm.expect(pm.cookies.get("session")).to.equal("hello world");});
 apt.test("metadata",()=>{apt.expect(apt.response.code).to.equal(201);apt.expect(apt.response.status).to.equal("Created");apt.expect(apt.response.responseTime).to.equal(8);apt.expect(apt.response.text()).to.equal('{"value":7}');});
 `,
    { response },
  );
  assert.equal(result.tests.length, 5);
  assert(
    result.tests.every((t) => t.passed),
    JSON.stringify(result.tests),
  );
});
test("bounded response assertion chains record positive negative and unsupported checks accurately", async () => {
  const result = await runScript(
    `
 apt.test("status",()=>apt.response.to.have.status(201));
 apt.test("status name",()=>apt.response.to.have.status("Created"));
 apt.test("category",()=>apt.response.to.be.success);
 apt.test("not error",()=>apt.response.to.not.be.error);
 apt.test("header",()=>apt.response.to.have.header("Content-Type","application/json"));
 apt.test("missing header",()=>apt.response.to.not.have.header("Missing"));
 apt.test("body",()=>apt.response.to.have.body('{"value":7}'));
 apt.test("wrong status",()=>apt.response.to.have.status(200));
 apt.test("wrong category",()=>apt.response.to.be.notFound);
 apt.test("wrong negative",()=>apt.response.to.not.be.success);
 apt.test("unsupported",()=>apt.response.to.be.nonexistent);
 apt.test("postman alias",()=>pm.response.to.have.status(201));
 `,
    { response },
  );
  assert.deepEqual(
    result.tests.map((t) => t.passed),
    [
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      true,
    ],
  );
});
test("missing responses and malformed JSON do not create false successful checks", async () => {
  const absent = await runScript(
    'apt.test("absent",()=>apt.response.to.not.be.error);',
    {},
  );
  assert.equal(absent.tests[0].passed, false);
  const invalid = await runScript(
    'apt.test("invalid",()=>apt.expect(apt.response.json).to.equal(undefined));pm.test("parse fails",()=>pm.expect(()=>pm.response.json()).to.throw());',
    { response: { ...response, body: "not json" } },
  );
  assert(
    invalid.tests.every((t) => t.passed),
    JSON.stringify(invalid.tests),
  );
});

test("response assertions use real HTTP evidence and a mismatch fails the plan", async (t) => {
  const http = await import("node:http");
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const server = http.createServer((req, res) => {
    res.writeHead(201, {
      "content-type": "application/json",
      "set-cookie": "wire=yes; Path=/",
    });
    res.end('{"wire":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: `http://127.0.0.1:${server.address().port}`,
          afterScript:
            'apt.test("wire",()=>{apt.response.to.have.status(201);apt.response.to.be.success;apt.response.to.have.header("Content-Type","application/json");apt.expect(apt.response.json.wire).to.equal(true);apt.expect(apt.response.cookies.wire).to.equal("yes");});',
        },
      },
    ],
  });
  assert.equal((await runPlan(plan, {}, executeRequest)).status, "passed");
  plan.steps[0].request.afterScript =
    'apt.test("wrong wire status",()=>apt.response.to.be.notFound);';
  assert.equal((await runPlan(plan, {}, executeRequest)).status, "failed");
});
