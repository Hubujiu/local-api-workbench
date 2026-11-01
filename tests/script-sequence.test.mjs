import { scriptFailureDetails } from "../src/script-diagnostics.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runScript, runScriptSequence } from "../src/scripts.mjs";

test("script stages settle callback work before propagating request and variable state", async (t) => {
  const server = http.createServer((req, res) =>
    setTimeout(() => res.end('{"value":"ready"}'), 40),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const result = await runScriptSequence(
    [
      {
        name: "project",
        code: `pm.sendRequest('http://127.0.0.1:${server.address().port}',(err,res)=>{if(err)throw err;apt.setVar('value',res.json().value);pm.variables.set('local',7);});`,
      },
      {
        name: "folder",
        code: 'pm.test("state",()=>pm.expect(apt.getVar("value")).to.equal("ready"));apt.setRequestHeader("x-local",String(pm.variables.get("local")));',
      },
      {
        name: "request",
        code: 'pm.test("local persists",()=>pm.expect(pm.variables.get("local")).to.equal(7));',
      },
    ],
    {
      variables: {},
      request: { url: "https://example.test", headers: [] },
      allowNetwork: true,
    },
  );
  assert.deepEqual(
    result.tests.map((x) => x.passed),
    [true, true],
  );
  assert.equal(
    result.request.headers.find((x) => x.key === "x-local").value,
    "7",
  );
  assert.equal(result.networkRequests.length, 1);
  assert.equal(result.networkRequests[0].scope, "project");
});
test("failed assertions stop later stages and preserve failure evidence", async () => {
  const result = await runScriptSequence(
    [
      { name: "global", code: 'pm.test("stop",()=>pm.expect(1).to.equal(2));' },
      { name: "request", code: 'throw Error("must-not-run");' },
    ],
    { variables: {} },
  );
  assert.equal(result.tests.length, 1);
  assert.equal(result.tests[0].passed, false);
  assert.equal(result.tests[0].scope, "global");
});
test("script stage execution shares the original aggregate activity and wall deadlines", async () => {
  await assert.rejects(
    runScriptSequence(
      Array.from({ length: 3 }, (_, i) => ({
        name: String(i),
        code: "const start=Date.now();while(Date.now()-start<110){}",
      })),
      { variables: {} },
    ),
    /interrupt|超时/i,
  );
  await assert.rejects(
    runScriptSequence(
      Array.from({ length: 3 }, (_, i) => ({
        name: String(i),
        code: "await new Promise(resolve=>setTimeout(resolve,750));",
      })),
      { variables: {} },
    ),
    /超时/,
  );
});
test("script sequences reject oversized aggregate source and malformed scope descriptors", async () => {
  for (const options of [
    { activityBudgetMs: 251 },
    { wallBudgetMs: 2001 },
    { requestLimit: 11 },
    { timerLimit: 101 },
    { fakerLimit: 1001 },
    { jobLimit: 10001 },
    { assertionLimit: 1001 },
    { requestLimit: -1 },
  ])
    assert.throws(() => runScript("", { variables: {} }, options), /预算/);
  await assert.rejects(
    runScript(
      "for(let i=0;i<3;i++)await Promise.resolve();",
      { variables: {} },
      { jobLimit: 1 },
    ),
    /微任务最多10000/,
  );

  for (const stages of [
    [{ name: "x", code: "x".repeat(100001) }],
    [
      { name: "x", code: "x".repeat(60000) },
      { name: "y", code: "x".repeat(60000) },
    ],
    [{ name: "x", code: [] }],
    Array.from({ length: 35 }, () => ({ name: "x", code: "" })),
  ])
    await assert.rejects(async () =>
      runScriptSequence(stages, { variables: {} }),
    );
});

test("stage boundaries cannot reset network, timer, Faker, assertion or log quotas", async (t) => {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(
    runScriptSequence(
      [
        {
          name: "a",
          code: `for(let i=0;i<6;i++)await pm.sendRequest('${url}');`,
        },
        {
          name: "b",
          code: `for(let i=0;i<5;i++)await pm.sendRequest('${url}');`,
        },
      ],
      { variables: {}, allowNetwork: true },
    ),
    /最多10/,
  );
  assert.equal(count, 10);
  // Independent predeclared samples, not retries: every sample must satisfy
  // the original assertion and the first mismatch still fails this test.
  for (const [code, pattern] of [
    [
      "for(let i=0;i<60;i++)await new Promise(resolve=>setTimeout(resolve,0));",
      /最多100次/,
    ],
    [
      // Exercise the real Faker provider and the SAME host-owned quota bridge
      // used by replaceIn, without parsing the identical template 1001 times.
      // Separate mixed-entrypoint tests retain real interpolation coverage.
      'for(let i=0;i<600;i++)builtinVariable("$randomCountryCode");',
      /最多1000次/,
    ],
    ['for(let i=0;i<600;i++)pm.test("pass",()=>{});', /最多1000条/],
  ])
    for (
      let sample = 0;
      sample < (pattern.source === "最多1000次" ? 6 : 1);
      sample++
    )
      await assert.rejects(
        (async () => {
          const started = performance.now();
          try {
            return await runScriptSequence(
              [
                { name: "a", code },
                { name: "b", code },
              ],
              { variables: {} },
            );
          } catch (error) {
            // Preserve the exact acceptance assertion below. Emit only bounded
            // phase/counter evidence, never source, variables or request data.
            t.diagnostic(
              JSON.stringify({
                case: pattern.source,
                sample,
                sequenceElapsedMs: Math.round(performance.now() - started),
                ...scriptFailureDetails(error),
              }),
            );
            if (
              pattern.source === "最多1000次" &&
              pattern.test(error.message)
            ) {
              assert.equal(error.scriptScope, "b");
              assert.equal(error.sequenceActivity.length, 1);
              assert.equal(error.sequenceActivity[0].fakerCalls, 600);
              assert.equal(error.scriptDiagnostics.fakerCalls, 401);
              assert.equal(error.sequenceActivity[0].activityBudgetMs, 250);
              assert.equal(
                error.scriptDiagnostics.activityBudgetMs,
                250 - error.sequenceActivity[0].activityMs,
              );
            }
            if (
              pattern.source === "最多1000次" &&
              !pattern.test(error.message)
            ) {
              // Fixed, no-network probes diagnose the failure; they never replace
              // or relax the original rejection assertion, which still fails.
              for (const [label, probe] of [
                ["empty", ""],
                [
                  "faker-once",
                  'pm.variables.replaceIn("{{$randomCountryCode}}");',
                ],
                [
                  "faker-600",
                  'for(let i=0;i<600;i++)pm.variables.replaceIn("{{$randomCountryCode}}");',
                ],
                [
                  "faker-600-direct",
                  'for(let i=0;i<600;i++)builtinVariable("$randomCountryCode");',
                ],
              ]) {
                const probeStarted = performance.now();
                let details;
                try {
                  const result = await runScript(probe, { variables: {} });
                  details = {
                    status: "returned",
                    activityMs: result.activityMs,
                    ...scriptFailureDetails({
                      activityMetrics: result.activityMetrics,
                      scriptDiagnostics: {
                        fakerCalls: result.usage.fakerCalls,
                      },
                    }),
                  };
                } catch (probeError) {
                  details = {
                    status: "failed",
                    ...scriptFailureDetails(probeError),
                  };
                }
                t.diagnostic(
                  JSON.stringify({
                    probe: label,
                    elapsedMs: Math.round(performance.now() - probeStarted),
                    ...details,
                  }),
                );
              }
            }
            throw error;
          }
        })(),
        pattern,
      );
  const logs = await runScriptSequence(
    [
      { name: "a", code: "for(let i=0;i<70;i++)console.log(i);" },
      { name: "b", code: "for(let i=0;i<70;i++)console.log(i);" },
    ],
    { variables: {} },
  );
  assert.equal(logs.logs.length, 100);
});
