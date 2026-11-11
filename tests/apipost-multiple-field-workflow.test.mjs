import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { normalizeRequest, runPlan, snapshotPlan } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const headerField =
  "Bearer {{token|upper}}/{{'literal'|upper}}/{{token|upper}}";
const textField = "prefix {{payload|concat()}} / {{suffix|upper}} end";
const jsonField =
  '{"first":"{{token|upper}}","second":"{{suffix|lower}}","repeat":"{{token|upper}}"}';
const payload = "&+=%中\n";
const textExpected = "prefix " + payload + " / MIXED end";
const jsonExpected = '{"first":"ACTUAL","second":"mixed","repeat":"ACTUAL"}';
const beforeScript =
  'apt.setVar("token","actual");apt.setVar("suffix","MiXeD");apt.setVar("payload",' +
  JSON.stringify(payload) +
  ");";
function source(origin, mode) {
  const doc = modernApipostFixture();
  doc.global.envs[0].server_list[0].uri = origin;
  doc.global.custom_func = [];
  doc.apis[1].method = "POST";
  doc.apis[1].url = origin + "/echo";
  doc.apis[1].request.query.parameter = [];
  doc.apis[1].request.header.parameter[0].value = headerField;
  doc.apis[1].request.body = ["urlencoded", "form-data"].includes(mode)
    ? {
        mode,
        parameter: [
          {
            key: "payload",
            value: textField,
            is_checked: 1,
            field_type: "String",
          },
        ],
      }
    : { mode, raw: mode === "json" ? jsonField : textField };
  return doc;
}
async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "multiple-field-workflow-"),
  );
  const seen = [];
  const peer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = {
      path: request.url,
      header: request.headers["x-test"],
      type: request.headers["content-type"],
      body: Buffer.concat(chunks).toString(),
    };
    seen.push(entry);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(entry));
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await closeApp();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (url, method = "GET", data, status = 200) => {
    const response = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const out = await response.json();
    assert.equal(response.status, status, JSON.stringify(out));
    return out;
  };
  return {
    root,
    seen,
    call,
    origin: "http://127.0.0.1:" + peer.address().port,
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
  };
}
function checkRun(run, mode) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].response.status, 200);
  const wire = JSON.parse(run.results[0].response.body);
  assert.equal(wire.path, "/echo");
  assert.equal(wire.header, "Bearer ACTUAL/LITERAL/ACTUAL");
  if (mode === "urlencoded") {
    assert.match(wire.type, /application\/x-www-form-urlencoded/);
    assert.equal(new URLSearchParams(wire.body).get("payload"), textExpected);
  } else if (mode === "form-data") {
    assert.match(wire.type, /multipart\/form-data; boundary=/);
    assert(
      wire.body.includes('name="payload"\r\n\r\n' + textExpected + "\r\n"),
    );
  } else {
    assert.equal(wire.body, mode === "json" ? jsonExpected : textExpected);
    assert.match(
      wire.type,
      mode === "json" ? /application\/json/ : /text\/plain/,
    );
  }
}

test(
  "multiple whitelisted fields import passively and reach actual Header, urlencoded, multipart, raw and JSON transports",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    for (const mode of ["urlencoded", "form-data", "plain", "json"]) {
      let p = await f.call(
        "/api/projects",
        "POST",
        { name: "Multiple " + mode },
        201,
      );
      const url = `/api/projects/${p.id}`,
        doc = source(f.origin, mode),
        count = f.seen.length;
      p = await f.call(url + "/import", "POST", { document: doc });
      assert.equal(f.seen.length, count);
      const request = p.requests[0];
      request.beforeScript = beforeScript;
      assert.equal(
        request.headers.find((row) => row.key === "X-Test").dynamic.value,
        headerField,
      );
      if (["urlencoded", "form-data"].includes(mode))
        assert.equal(request.form[0].dynamic.value, textField);
      else
        assert.equal(
          request.bodyDynamic.apipost_body.value,
          mode === "json" ? jsonField : textField,
        );
      const before = structuredClone(request);
      checkRun(
        await runPlan(
          snapshotPlan({ functions: [], steps: [{ request }] }),
          { token: "stale", suffix: "stale", payload: "stale" },
          executeRequest,
        ),
        mode,
      );
      assert.deepEqual(request, before);
      assert.equal(f.seen.length, count + 1);
    }
  },
);

test(
  "multiple-field frozen plans preserve source through live edits, Store reopen and backup restore",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    let p = await f.call(
      "/api/projects",
      "POST",
      { name: "Frozen multiple fields" },
      201,
    );
    const url = `/api/projects/${p.id}`;
    p = await f.call(url + "/import", "POST", {
      document: source(f.origin, "plain"),
    });
    p.requests[0].beforeScript = beforeScript;
    p = await f.call(url, "PUT", p);
    const frozen = await f.call(url + "/plans", "POST", {
      name: "Frozen",
      environmentId: p.environments.find((env) => env.name === "Imported").id,
      steps: [{ request: p.requests[0] }],
    });
    p = await f.call(url);
    p.requests[0].bodyDynamic.apipost_body.value =
      "changed {{token|lower}} and {{suffix|lower}}";
    p = await f.call(url, "PUT", p);
    await f.restart();
    assert.equal(
      (await new Store(f.root).get(p.id)).requests[0].bodyDynamic.apipost_body
        .value,
      "changed {{token|lower}} and {{suffix|lower}}",
    );
    checkRun(
      await f.call(url + "/run", "POST", { planId: frozen.id }),
      "plain",
    );
    const backup = await f.call(url + "/export");
    const restored = await f.call(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    assert.deepEqual(restored.requests, backup.requests);
    assert.deepEqual(restored.plans, backup.plans);
    await f.restart();
    checkRun(
      await f.call(`/api/projects/${restored.id}/run`, "POST", {
        planId: frozen.id,
      }),
      "plain",
    );
    assert.equal(f.seen.length, 2);
  },
);

test(
  "multiple-expression custom functions and Query remain atomic import refusals with no transport",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    let p = await f.call(
      "/api/projects",
      "POST",
      { name: "Atomic multiple rejection" },
      201,
    );
    const url = `/api/projects/${p.id}`;
    p = await f.call(url + "/import", "POST", {
      document: source(f.origin, "plain"),
    });
    const before = await new Store(f.root).get(p.id);
    const custom = "{{token|upper}} / {{$function.fn_custom(raw)}}";
    for (const location of ["header", "form", "body", "query"]) {
      const doc = source(
        f.origin,
        location === "form" ? "urlencoded" : "plain",
      );
      doc.global.custom_func = [
        {
          func_id: "custom",
          func_name: "fn_custom",
          func_body: "return text;",
        },
      ];
      if (location === "header")
        doc.apis[1].request.header.parameter[0].value = custom;
      if (location === "form")
        doc.apis[1].request.body.parameter[0].value = custom;
      if (location === "body") doc.apis[1].request.body.raw = custom;
      if (location === "query")
        doc.apis[1].request.query.parameter = [
          {
            key: "q",
            value: "{{token|upper}}/{{suffix|lower}}",
            is_checked: 1,
          },
        ];
      const original = structuredClone(doc);
      await f.call(url + "/import", "POST", { document: doc }, 400);
      assert.deepEqual(doc, original);
      assert.deepEqual(await new Store(f.root).get(p.id), before);
      assert.equal(f.seen.length, 0);
    }
  },
);

test(
  "multiple fields retain JavaScript replacement symbols and the initial ordered expression list over real HTTP",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const expression = "{{token|concat()}}";
    const field = "left " + expression + " middle " + expression + " right";
    const replacement = "$`|$&|$'|$$";
    let expected = field;
    for (let i = 0; i < 2; i++)
      expected = expected.replace(expression, replacement);
    const inserted = "{{seed|concat()}} / {{other|upper}} / {{seed|concat()}}";
    for (const [value, variables, result] of [
      [field, { token: replacement }, expected],
      [
        inserted,
        { seed: "{{other|upper}}", other: "x" },
        "X / {{other|upper}} / {{other|upper}}",
      ],
      [
        "{{seed|concat()}} / {{other|upper}}",
        { seed: "{{notInInitialList|upper}}", other: "x" },
        "{{notInInitialList|upper}} / X",
      ],
    ]) {
      const request = normalizeRequest({
        method: "POST",
        url: f.origin + "/echo",
        bodyType: "raw",
        body: "{{@value:apipost_body}}",
        bodyDynamic: {
          apipost_body: {
            source: "apipost-body-function",
            value,
            functions: [],
            format: "text",
          },
        },
      });
      const run = await runPlan(
        snapshotPlan({ steps: [{ request }] }),
        variables,
        executeRequest,
      );
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.equal(JSON.parse(run.results[0].response.body).body, result);
    }
    assert.equal(f.seen.length, 3);
  },
);
