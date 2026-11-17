import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const body = source.slice(
  source.indexOf('  on("#generate-body",'),
  source.indexOf('  on("#format-json",'),
);
function harness() {
  const calls = [];
  const initial = {
    id: "a",
    requests: [
      {
        id: "r",
        body: "original",
        bodyType: "raw",
        schema: { type: "object" },
      },
    ],
  };
  const create = new Function(
    "initial",
    "calls",
    `
    let project=initial,current="r",editVersion=0,projectOpenSequence=0,bodyGenerationSequence=0,dirty=false,page="apis",mode="debug";
    const request=()=>project.requests.find(r=>r.id===current);
    const collect=()=>{},render=()=>{},mark=()=>{editVersion++;dirty=true};
    const api=(url,method,data)=>new Promise((resolve,reject)=>calls.push({url,method,data,resolve,reject}));
    let run;const on=(s,e,fn)=>run=fn;
    ${body}
    return {run,state:()=>({project,current,dirty}),edit(){request().body="new draft";mark()},switchRequest(){project.requests.push({id:"other",body:"other draft",schema:{}});current="other"},switchProject(){project={id:"b",requests:[{id:"r",body:"other project",schema:{}}]};projectOpenSequence++},navigate(){page="settings"},reopen(){projectOpenSequence++}};
  `,
  );
  return { ...create(initial, calls), calls };
}
test("late generated body does not overwrite a newer draft", async () => {
  const h = harness(),
    pending = h.run();
  h.edit();
  h.calls[0].resolve({ sample: { from: "old" } });
  await assert.rejects(pending, /未应用生成结果/);
  assert.equal(h.state().project.requests[0].body, "new draft");
});
test("own generation updates only its original request and marks a draft", async () => {
  const h = harness(),
    pending = h.run();
  assert.equal(h.calls[0].url, "/projects/a/sample");
  h.calls[0].resolve({ sample: { ok: true } });
  await pending;
  assert.deepEqual(JSON.parse(h.state().project.requests[0].body), {
    ok: true,
  });
  assert.equal(h.state().dirty, true);
});
for (const change of ["switchRequest", "switchProject", "navigate", "reopen"]) {
  test(`late generation refuses changed ${change} ownership`, async () => {
    const h = harness(),
      pending = h.run();
    h[change]();
    const before = structuredClone(h.state());
    h.calls[0].resolve({ sample: { old: true } });
    await assert.rejects(pending, /未应用生成结果/);
    assert.deepEqual(h.state(), before);
  });
}
test("newest generation wins regardless of response order", async () => {
  const h = harness(),
    first = h.run(),
    second = h.run();
  h.calls[1].resolve({ sample: { second: true } });
  await second;
  h.calls[0].resolve({ sample: { first: true } });
  await assert.rejects(first, /未应用生成结果/);
  assert.deepEqual(JSON.parse(h.state().project.requests[0].body), {
    second: true,
  });
  assert.equal(h.calls.length, 2);
});
test("failed newer generation never revives an older response", async () => {
  const h = harness(),
    first = h.run(),
    second = h.run();
  h.calls[1].reject(Error("generation failed"));
  await assert.rejects(second, /generation failed/);
  h.calls[0].resolve({ sample: { first: true } });
  await assert.rejects(first, /未应用生成结果/);
  assert.equal(h.state().project.requests[0].body, "original");
  assert.equal(h.state().dirty, false);
});
test("generation sends a schema snapshot, not a live mutable object", async () => {
  const h = harness(),
    pending = h.run();
  h.state().project.requests[0].schema.type = "string";
  assert.deepEqual(h.calls[0].data.schema, { type: "object" });
  h.calls[0].reject(Error("stop"));
  await assert.rejects(pending, /stop/);
});
test("real sample endpoint does not persist project state", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "body-generation-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Read only generation");
  const before = structuredClone(await app.store.get(project.id));
  const response = await fetch(
    app.url + "/api/projects/" + project.id + "/sample",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify({
        schema: {
          type: "object",
          properties: { value: { const: "generated" } },
          required: ["value"],
        },
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sample, { value: "generated" });
  assert.deepEqual(await app.store.get(project.id), before);
});
