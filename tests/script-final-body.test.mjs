import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { finalBodyLiteral } from "../src/script-final-body.mjs";
import { once } from "node:events";
import { runScript } from "../src/scripts.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";

test("final raw body helper returns and writes the resolved phase source without post-response exposure", async () => {
  const output = await runScript(
    `const first=pm.getFinalRequestRawBody();pm.variables.set('name','Grace');const second=pm.getFinalRequestRawBody();apt.setVar('first',first);apt.setVar('second',second);`,
    {
      variables: { name: "Ada" },
      request: { bodyType: "json", body: '{"name":"{{name}}"}' },
    },
  );
  assert.equal(output.variables.first, '{"name":"Ada"}');
  assert.equal(output.variables.second, '{"name":"Grace"}');
  assert.equal(output.request.body, output.variables.second);
  assert.deepEqual(output.finalBody, {
    body: output.variables.second,
    bodyType: "json",
  });
  const after = await runScript(
    "apt.setVar('present',typeof pm.getFinalRequestRawBody)",
    { response: { status: 200, body: "{}" } },
  );
  assert.equal(after.variables.present, "undefined");
});

test("final body proof is invalidated by later edits and unsupported bodies fail explicitly", async () => {
  const result = await runScript(
    "pm.getFinalRequestRawBody();pm.setRequestBody('changed {{name}}')",
    {
      variables: { name: "Ada" },
      request: { bodyType: "raw", body: "hello {{name}}" },
    },
  );
  assert.equal(result.finalBody, undefined);
  for (const request of [
    { bodyType: "form-data", form: [] },
    {
      bodyType: "raw",
      body: "{{@value:a}}",
      bodyDynamic: { a: { source: "fixed", value: "x", format: "text" } },
    },
  ]) {
    await assert.rejects(
      runScript("pm.getFinalRequestRawBody()", { request }),
      /正文|动态/,
    );
  }
});

test("actual HTTP sends final body bytes once, retaining literal template-like variable output across shared phases", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (part) => (body += part));
    req.on("end", () => {
      seen.push({ body, signature: req.headers["x-signature"] });
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const request = {
      url: `http://127.0.0.1:${server.address().port}/body`,
      method: "POST",
      bodyType: "raw",
      body: "{{name}}",
      sharedBeforeScripts: [
        {
          name: "project",
          code: "apt.setVar('signed',pm.getFinalRequestRawBody());pm.setRequestHeader('x-signature',CryptoJS.HmacSHA256(pm.variables.get('signed'),'fixture-key').toString())",
        },
      ],
      beforeScript:
        "pm.test('preserved',()=>pm.expect(pm.getFinalRequestRawBody()).to.equal(pm.variables.get('signed')))",
    };
    const run = await runPlan(
      snapshotPlan({
        steps: [
          { request },
          { request: { ...request, scriptURLMode: "sdk" } },
          {
            request: {
              ...request,
              sharedBeforeScripts: [],
              beforeScript:
                "pm.getFinalRequestRawBody();pm.setRequestBody('after {{newValue}}')",
            },
          },
        ],
      }),
      { name: "{{literal}}+&", newValue: "change" },
      executeRequest,
    );
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.deepEqual(seen, [
      {
        body: "{{literal}}+&",
        signature: createHmac("sha256", "fixture-key")
          .update("{{literal}}+&")
          .digest("hex"),
      },
      {
        body: "{{literal}}+&",
        signature: createHmac("sha256", "fixture-key")
          .update("{{literal}}+&")
          .digest("hex"),
      },
      { body: "after change", signature: undefined },
    ]);
    assert.equal(run.results[0].request.finalBody, undefined);
    assert.equal(request.body, "{{name}}");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("execution-only final-body records reject accessors, unknown fields and oversized text", () => {
  let called = false;
  const accessor = {
    bodyType: "raw",
    get body() {
      called = true;
      return "x";
    },
  };
  assert.throws(() =>
    finalBodyLiteral(accessor, { body: "x", bodyType: "raw" }),
  );
  assert.equal(called, false);
  assert.throws(() =>
    finalBodyLiteral({ body: "x", bodyType: "raw", extra: true }, {}),
  );
  assert.throws(() =>
    finalBodyLiteral({ body: "中".repeat(22000), bodyType: "raw" }, {}),
  );
  assert.equal(
    finalBodyLiteral(
      { body: "x", bodyType: "raw" },
      { body: "changed", bodyType: "raw" },
    ),
    undefined,
  );
});
