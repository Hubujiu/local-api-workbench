import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
const execute = (code, request) =>
  runScript(code, {
    variables: {},
    request: { scriptDialect: "apipost8", ...request },
  });
test("modern JSON body shortcuts update nested paths atomically while legacy keeps literal keys", async () => {
  const r = await execute(
    `pm.setRequestBody({users:[{id:1}],keep:true});apt.setRequestBody('users[0].id',0);pm.setRequestBody('new.value',false);pm.removeRequestBody('keep');`,
    { bodyType: "none" },
  );
  assert.deepEqual(JSON.parse(r.request.body), {
    users: [{ id: 0 }],
    new: { value: false },
  });
  assert.equal(r.request.bodyType, "json");
  const legacy = await execute(`apt.setRequestBody('a.b',1)`, {
    scriptDialect: "legacy",
    bodyType: "json",
    body: "{}",
  });
  assert.deepEqual(JSON.parse(legacy.request.body), { "a.b": 1 });
});
test("raw replacement and invalid JSON language fallback preserve literal text", async () => {
  const r = await execute(`pm.setRequestBody('literal <body>');`, {
    bodyType: "json",
    body: "{}",
  });
  assert.equal(r.request.bodyType, "raw");
  assert.equal(r.request.body, "literal <body>");
  const j = await execute(`pm.setRequestBody('[0,false,null]');`, {
    bodyType: "json",
    body: "{}",
  });
  assert.equal(j.request.bodyType, "json");
  assert.equal(j.request.body, "[0,false,null]");
});
test("form map merging preserves selected files, replacement clears explicitly, and invalid maps never partly apply", async () => {
  const input = {
    bodyType: "form-data",
    form: [
      { key: "file", type: "file", filename: "safe.txt", value: "c2FmZQ==" },
      { key: "tag", value: "old" },
    ],
  };
  const r = await execute(
    `pm.setRequestBody({tag:'new',other:'yes'},undefined,false);pm.setRequestBody('tag',0);pm.removeRequestBody('other');`,
    input,
  );
  assert.equal(r.request.form[0].value, "c2FmZQ==");
  assert.equal(r.request.form.find((x) => x.key === "tag").value, "0");
  assert.equal(r.request.form.length, 2);
  const bad = await execute(
    `try{pm.setRequestBody({first:'valid',file:'overwrite'},undefined,false)}catch(e){apt.setVar('rejected',true)}`,
    input,
  );
  assert.equal(bad.variables.rejected, true);
  assert.deepEqual(bad.request.form, input.form);
  const replaced = await execute(`pm.setRequestBody({only:'text'});`, input);
  assert.equal(replaced.request.form.length, 1);
  assert.equal(replaced.request.form[0].key, "only");
});
test("path validation rejects prototype segments, excessive indices and unsupported modes without mutation", async () => {
  for (const path of [
    "__proto__.x",
    "a.constructor.x",
    "a[1000000]",
    "a.".repeat(33) + "x",
  ]) {
    const r = await execute(
      `try{pm.setRequestBody(${JSON.stringify(path)},1)}catch(e){apt.setVar('rejected',true)}`,
      { bodyType: "json", body: '{"keep":1}' },
    );
    assert.equal(r.variables.rejected, true, path);
    assert.equal(r.request.body, '{"keep":1}');
  }
  await assert.rejects(
    execute(`pm.setRequestBody('a',1)`, { bodyType: "binary", body: "AA==" }),
    /JSON|表单/,
  );
  const r = await execute(
    `try{pm.setRequestBody('x','中'.repeat(30000))}catch(e){apt.setVar('rejected',true)}`,
    { bodyType: "json", body: "{}" },
  );
  assert.equal(r.variables.rejected, true);
  assert.equal(r.request.body, "{}");
});
test("removing an array slot keeps indices and literal dotted keys take precedence", async () => {
  const r = await execute(
    `pm.removeRequestBody('list[0]');pm.setRequestBody('a.b',2);`,
    { bodyType: "json", body: '{"list":[1,2],"a.b":1}' },
  );
  assert.deepEqual(JSON.parse(r.request.body), { list: [null, 2], "a.b": 2 });
});

test("invalid map values, null overload, unknown flags and deleted file selection remain explicit", async () => {
  const input = {
    bodyType: "form-data",
    form: [
      { key: "upload", type: "file", filename: "f", value: "YQ==" },
      { key: "keep", value: "old" },
    ],
  };
  for (const code of [
    "pm.setRequestBody({first:'new',bad:4},undefined,false)",
    "pm.setRequestBody({x:'new'},undefined,'yes')",
    "pm.setRequestBody('keep',null)",
  ]) {
    const r = await execute(
      `try{${code}}catch(e){apt.setVar('rejected',true)}`,
      input,
    );
    assert.equal(r.variables.rejected, true);
    assert.deepEqual(r.request.form, input.form);
  }
  const removed = await execute("pm.removeRequestBody('upload')", input);
  assert.deepEqual(removed.request.form, [{ key: "keep", value: "old" }]);
});

test("modern JSON and multipart updates reach real HTTP while selected file bytes and saved definitions stay intact", async (t) => {
  const http = await import("node:http");
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        raw: Buffer.concat(chunks).toString(),
        type: req.headers["content-type"],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = "http://127.0.0.1:" + server.address().port;
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url,
          method: "POST",
          scriptDialect: "apipost8",
          bodyType: "json",
          body: '{"user":{"id":1}}',
          beforeScript:
            "apt.setRequestBody('user.id',0);pm.setRequestBody('list[0]',false);",
        },
      },
      {
        request: {
          url,
          method: "POST",
          scriptDialect: "apipost8",
          bodyType: "form-data",
          form: [
            {
              key: "upload",
              type: "file",
              filename: "safe.txt",
              value: "c2FmZQ==",
            },
          ],
          beforeScript: "pm.setRequestBody({note:'中文'},undefined,false);",
        },
      },
    ],
  });
  const saved = structuredClone(plan);
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.deepEqual(
    JSON.parse(JSON.parse(result.results[0].response.body).raw),
    { user: { id: 0 }, list: [false] },
  );
  const multipart = JSON.parse(result.results[1].response.body);
  assert.match(multipart.type, /multipart\/form-data/);
  assert.match(multipart.raw, /filename="safe.txt"/);
  assert.match(multipart.raw, /safe/);
  assert.match(multipart.raw, /中文/);
  assert.deepEqual(plan, saved);
});
