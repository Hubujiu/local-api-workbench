import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
test("script can set variables and record deterministic assertions", async () => {
  const result = await runScript(
    'apt.setVar("token", pm.response.json().token); pm.test("status", () => pm.expect(pm.response.code).to.equal(200)); console.log("done");',
    { variables: {}, response: { status: 200, body: '{"token":"abc"}' } },
  );
  assert.equal(result.variables.token, "abc");
  assert.equal(result.tests[0].passed, true);
  assert.equal(result.logs[0], "done");
});
test("script VM does not expose process, filesystem or network", async () => {
  const result = await runScript(
    'apt.setVar("types", [typeof process,typeof require,typeof fetch]);',
    { variables: {} },
  );
  assert.deepEqual(result.variables.types, [
    "undefined",
    "undefined",
    "undefined",
  ]);
});
test("infinite scripts are interrupted without hanging the runner", async () => {
  await assert.rejects(
    runScript("while(true) {}", { variables: {} }),
    /interrupt|超时|终止/i,
  );
});

test("safe apt request mutation updates and removes query/header/body fields without host APIs", async () => {
  const input = {
    variables: {},
    request: {
      url: "https://example.test/?token=old&keep=a%2Bb#part",
      query: [{ key: "token", value: "older" }],
      headers: [{ key: "X-ID", value: "old", description: "kept" }],
      bodyType: "json",
      body: '{"keep":true,"remove":1}',
    },
  };
  const result = await runScript(
    'apt.setRequestQuery("token","new"); apt.setRequestHeader("x-id","value"); apt.setRequestBody("n",2); apt.removeRequestBody("remove");',
    input,
  );
  assert.equal(result.request.url, "https://example.test/?keep=a%2Bb#part");
  assert.deepEqual(result.request.query, [
    { key: "token", value: "new", enabled: true },
  ]);
  assert.equal(result.request.headers.length, 1);
  assert.equal(result.request.headers[0].description, "kept");
  assert.deepEqual(JSON.parse(result.request.body), { keep: true, n: 2 });
  assert.equal(input.request.headers[0].value, "old");
  const removed = await runScript(
    'apt.removeRequestQuery("token"); apt.removeRequestHeader("X-ID"); apt.setRequestBody({fresh:false});',
    { variables: {}, request: result.request },
  );
  assert.equal(removed.request.headers.length, 0);
  assert.equal(removed.request.query.length, 0);
  assert.deepEqual(JSON.parse(removed.request.body), { fresh: false });
  await assert.rejects(
    runScript('apt.setRequestBody("__proto__",{});', input),
    /Invalid parameter/,
  );
  await assert.rejects(
    runScript('apt.setRequestBody("x",1);', {
      variables: {},
      request: { bodyType: "binary", body: "AA==" },
    }),
    /require JSON/,
  );
});

test("pre-script mutations reach a real HTTP fixture without modifying the saved plan", async (t) => {
  const http = await import("node:http");
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        url: req.url,
        header: req.headers["x-proof"],
        body: JSON.parse(body),
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          method: "POST",
          url: "http://127.0.0.1:" + server.address().port + "/?id=old",
          bodyType: "json",
          body: "{}",
          beforeScript:
            'apt.setRequestQuery("id","new"); apt.setRequestHeader("x-proof","yes"); apt.setRequestBody("enabled",true);',
          assertions: [{ target: "$.header", op: "eq", value: "yes" }],
        },
      },
    ],
  });
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "passed");
  assert.deepEqual(JSON.parse(result.results[0].response.body), {
    url: "/?id=new",
    header: "yes",
    body: { enabled: true },
  });
  assert.equal(plan.steps[0].request.body, "{}");
  assert(plan.steps[0].request.url.endsWith("?id=old"));
  await assert.rejects(
    runScript('apt.setRequestBody("upload","text");', {
      variables: {},
      request: {
        bodyType: "form-data",
        form: [{ key: "upload", type: "file", data: "AA==" }],
      },
    }),
    /File fields/,
  );
});

test("request-local pm.variables shadow interpolation only for the current step and survive pre-to-post", async () => {
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const urls = [];
  const result = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            url: "http://fixture.test/{{id}}",
            beforeScript:
              'pm.variables.set("id","local"); pm.variables.set("temp",42);',
            afterScript:
              'pm.test("same request",()=>pm.expect(pm.variables.get("temp")).to.equal(42));',
          },
        },
        {
          request: {
            url: "http://fixture.test/{{id}}",
            beforeScript:
              'pm.test("no leak",()=>pm.expect(pm.variables.has("temp")).to.equal(false));',
          },
        },
      ],
    }),
    { id: "environment" },
    async (request) => {
      urls.push(request.url);
      return { status: 200, body: "{}", headers: {}, duration: 1 };
    },
  );
  assert.equal(result.status, "passed");
  assert.deepEqual(urls, [
    "http://fixture.test/local",
    "http://fixture.test/environment",
  ]);
  assert.equal(result.variables.id, "environment");
  assert.equal(Object.hasOwn(result.variables, "temp"), false);
  const standalone = await runScript(
    'pm.variables.set("x",1); pm.variables.unset("x"); pm.variables.set("y",2); pm.variables.clear();',
    { variables: {} },
  );
  assert.deepEqual(standalone.localVariables, {});
  await assert.rejects(
    runScript('pm.variables.set("__proto__",1);', { variables: {} }),
    /Invalid/,
  );
});
