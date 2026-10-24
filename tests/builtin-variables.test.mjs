import test from "node:test";
import assert from "node:assert/strict";
import { interpolate, runPlan, snapshotPlan } from "../src/core.mjs";
import { runScript } from "../src/scripts.mjs";
import { executeRequest } from "../src/runtime.mjs";
import http from "node:http";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
test("common builtin variables generate bounded typed-string values without hiding user overrides", () => {
  assert.match(interpolate("{{$guid}}"), uuid);
  assert.match(interpolate("{{$randomUUID}}"), uuid);
  assert.equal(interpolate("{{$guid}}", { $guid: "explicit" }), "explicit");
  const now = Date.now();
  assert(Math.abs(Number(interpolate("{{$timestamp}}")) * 1000 - now) < 2000);
  assert(Number.isFinite(Date.parse(interpolate("{{$isoTimestamp}}"))));
  for (let i = 0; i < 20; i++) {
    const n = Number(interpolate("{{$randomInt}}"));
    assert(Number.isInteger(n) && n >= 0 && n <= 1000);
  }
  assert.match(interpolate("{{$randomBoolean}}"), /^(true|false)$/);
  assert.match(interpolate("{{$randomHexColor}}"), /^#[0-9a-f]{6}$/);
  assert.equal(interpolate("{{$randomPassword}}").length, 15);
  assert.match(interpolate("{{$randomIP}}"), /^(\d{1,3}\.){3}\d{1,3}$/);
  assert.match(
    interpolate("{{$randomIPV6}}"),
    /^([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$/,
  );
  assert.match(
    interpolate("{{$randomMACAddress}}"),
    /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/,
  );
  assert.match(interpolate("{{$randomProtocol}}"), /^https?$/);
  assert.match(interpolate("{{$randomSemver}}"), /^\d+\.\d+\.\d+$/);
  assert.throws(() => interpolate("{{$notSupported}}"), /未定义/);
});
test("script replaceIn uses current scopes and builtin variables inside QuickJS", async () => {
  const result = await runScript(
    `pm.variables.set('local',false); apt.variables.set('value',0); apt.setVar('resolved',apt.variables.replaceIn('{{local}}:{{value}}:{{$guid}}')); apt.setVar('pm',pm.variables.replaceIn('{{$randomInt}}'));`,
    { variables: {} },
  );
  const [local, value, id] = result.variables.resolved.split(":");
  assert.equal(local, "false");
  assert.equal(value, "0");
  assert.match(id, uuid);
  assert(Number(result.variables.pm) >= 0);
  await assert.rejects(
    runScript("apt.variables.replaceIn('{{missing}}')", { variables: {} }),
    /未定义/,
  );
});
test("builtin values reach actual request construction and JSON boolean contexts", async (t) => {
  let received;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    received = { header: req.headers["x-id"], body: JSON.parse(body) };
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: `http://127.0.0.1:${server.address().port}/`,
          method: "POST",
          headers: [{ key: "X-ID", value: "{{$guid}}" }],
          bodyType: "json",
          body: '{"enabled":{{$randomBoolean}},"id":"{{$randomUUID}}"}',
        },
      },
    ],
  });
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "passed");
  assert.match(received.header, uuid);
  assert.equal(typeof received.body.enabled, "boolean");
  assert.match(received.body.id, uuid);
});

test("post-script replaceIn observes extracted variables without pre-interpolating script source", async (t) => {
  const server = http.createServer((req, res) =>
    res.end('{"token":"post-token"}'),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: `http://127.0.0.1:${server.address().port}/`,
          extract: [{ name: "responseToken", source: "json", path: "$.token" }],
          afterScript:
            "pm.test('post scope',()=>pm.expect(apt.variables.replaceIn('{{responseToken}}')).to.equal('post-token'));",
        },
      },
    ],
  });
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "passed");
  assert.equal(result.results[0].assertions.at(-1).passed, true);
});

test("replaceIn bounds UTF-8 input and expanded output and rejects excessive substitutions", async () => {
  await assert.rejects(
    runScript("pm.variables.replaceIn('中'.repeat(22000))", { variables: {} }),
    /64KiB/,
  );
  await assert.rejects(
    runScript("pm.variables.replaceIn('{{large}}')", {
      variables: { large: "😀".repeat(17000) },
    }),
    /64KiB/,
  );
  await assert.rejects(
    runScript("pm.variables.replaceIn('{{x}}'.repeat(1001))", {
      variables: { x: "a" },
    }),
    /1000/,
  );
});

test("documented Apipost Faker aliases and mockExp use the bounded explicit catalogue", async () => {
  assert(interpolate("{{$fakerjs.Company.name}}").length > 0);
  assert(interpolate("{{$fakerjs.Internet.displayName}}").length > 0);
  assert(interpolate("{{$fakerjs.Internet.password}}").length > 0);
  const result = await runScript(
    'apt.setVar("company", mockExp("{{$fakerjs.Company.name}}")); apt.setVar("displayName", mockExp("{{$fakerjs.Internet.displayName}}")); apt.setVar("explicit", mockExp("{{value}}"));',
    { variables: { value: "literal" } },
  );
  assert.equal(typeof result.variables.company, "string");
  assert(result.variables.company.length > 0);
  assert.equal(result.variables.explicit, "literal");
  await assert.rejects(
    runScript('mockExp("{{$fakerjs.constructor.constructor}}");', {
      variables: {},
    }),
    /未定义/,
  );
  await assert.rejects(
    runScript('mockExp({name:"value"});', { variables: {} }),
    /字符串/,
  );
});

test("Apipost millisecond timestamp and floating random aliases have exact unit and boundary semantics", async () => {
  const { builtinVariableFactory } = await import(
    "../src/builtin-variables.mjs"
  );
  const instant = 1780000000123;
  const low = builtinVariableFactory(
    (n) => new Uint8Array(n),
    () => instant,
  );
  const high = builtinVariableFactory(
    (n) => new Uint8Array(n).fill(255),
    () => instant,
  );
  assert.equal(low("$microTimestamp"), instant);
  assert.equal(low("$timestamp"), Math.floor(instant / 1000));
  assert.equal(low("$randomFloat"), 0);
  assert.equal(high("$randomFloat"), (4294967295 / 4294967296) * 1000);
  assert(high("$randomFloat") < 1000);
  assert.equal(
    interpolate("{{$microTimestamp}}:{{$randomFloat}}", {
      $microTimestamp: 0,
      $randomFloat: false,
    }),
    "0:false",
  );
});

test("Apipost dynamic aliases work inside isolated script replaceIn", async () => {
  const start = Date.now();
  const result = await runScript(
    `apt.setVar('milliseconds',pm.variables.replaceIn('{{$microTimestamp}}'));apt.setVar('fraction',apt.variables.replaceIn('{{$randomFloat}}'));`,
    { variables: {} },
  );
  const end = Date.now();
  assert(
    Number(result.variables.milliseconds) >= start &&
      Number(result.variables.milliseconds) <= end,
  );
  assert(
    Number(result.variables.fraction) >= 0 &&
      Number(result.variables.fraction) < 1000,
  );
});

test("Apipost dynamic aliases arrive as numeric JSON in a real HTTP request", async (t) => {
  let received;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    received = JSON.parse(body);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const start = Date.now();
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: `http://127.0.0.1:${server.address().port}/`,
          method: "POST",
          bodyType: "json",
          body: '{"milliseconds":{{$microTimestamp}},"fraction":{{$randomFloat}}}',
        },
      },
    ],
  });
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "passed", JSON.stringify(result.results));
  assert.equal(typeof received.milliseconds, "number");
  assert(received.milliseconds >= start && received.milliseconds <= Date.now());
  assert.equal(typeof received.fraction, "number");
  assert(received.fraction >= 0 && received.fraction < 1000);
});
