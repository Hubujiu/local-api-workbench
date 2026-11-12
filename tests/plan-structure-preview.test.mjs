import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { createApp } from "../src/server.mjs";
async function files(dir) {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      for (const [key, value] of Object.entries(await files(full)))
        result[entry.name + "/" + key] = value;
    else result[entry.name] = (await readFile(full)).toString("base64");
  }
  return result;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-preview-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (
    url,
    data,
    status = 200,
    token = app.token,
    method = "POST",
  ) => {
    const response = await fetch(app.url + url, {
      method,
      headers: { "x-local-token": token, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const p = await call(
    "/api/projects",
    { name: "Read-only plan preview" },
    201,
  );
  const snapshot = () => files(root);
  return {
    app,
    p,
    call,
    snapshot,
    url: `/api/projects/${p.id}/plans-validate`,
  };
}
test("actual HTTP plan validation returns only acknowledgement and never saves or executes", async (t) => {
  const c = await fixture(t);
  let hits = 0;
  const target = http.createServer((req, res) => {
    hits++;
    res.end("unexpected");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => target.close(r)));
  const input = {
    id: "candidate",
    name: "Unsaved",
    projectConfigRevision: c.p.configRevision,
    steps: [
      {
        id: "step-a",
        request: {
          method: "GET",
          url: `http://127.0.0.1:${target.address().port}/`,
          preScript: "throw Error('must not execute')",
        },
      },
    ],
  };
  const before = await c.snapshot(),
    original = structuredClone(input),
    stored = structuredClone(await c.app.store.get(c.p.id));
  const save = c.app.store.save;
  let saves = 0;
  c.app.store.save = () => {
    saves++;
    throw Error("preview attempted save");
  };
  try {
    assert.deepEqual(await c.call(c.url, input), {
      valid: true,
      project_id: c.p.id,
      projectConfigRevision: c.p.configRevision,
    });
  } finally {
    c.app.store.save = save;
  }
  assert.equal(saves, 0);
  assert.equal(hits, 0);
  assert.deepEqual(input, original);
  assert.deepEqual(await c.app.store.get(c.p.id), stored);
  assert.deepEqual(await c.snapshot(), before);
});
test("invalid plan graph and stale revision fail without candidate persistence", async (t) => {
  const c = await fixture(t),
    before = await c.snapshot();
  const step = { id: "same", request: { url: "http://127.0.0.1:1/" } };
  for (const input of [
    { name: "stale", steps: [], projectConfigRevision: -1 },
    {
      name: "unknown",
      steps: [{ id: "group", type: "unknown-group", steps: [step] }],
    },
    { name: "duplicate", steps: [step, structuredClone(step)] },
    {
      name: "missing reference",
      steps: [{ id: "grpc", type: "grpc", grpc: { definitionId: "absent" } }],
    },
  ]) {
    await c.call(c.url, input, 400);
    assert.deepEqual(await c.snapshot(), before);
  }
});
test("owner authentication and exact preview/save paths cannot become writes", async (t) => {
  const c = await fixture(t),
    before = await c.snapshot(),
    input = { name: "No write", steps: [] };
  await c.call(c.url, input, 403, "wrong-token");
  for (const url of [
    c.url + "/extra",
    c.url + "?preview=1",
    c.url.replace("plans-validate", "plans/validate"),
    c.url.replace("plans-validate", "plans") + "?preview=1",
  ])
    await c.call(url, input, 400);
  await c.call(c.url, input, 400, c.app.token, "GET");
  assert.deepEqual(await c.snapshot(), before);
});

test("protocol candidate validation creates no TCP connection or execution record", async (t) => {
  const c = await fixture(t);
  let connections = 0;
  const target = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => target.close(resolve)));
  const before = await c.snapshot();
  const result = await c.call(c.url, {
    name: "Inert wire candidate",
    steps: [
      {
        id: "wire",
        type: "protocol",
        protocol: {
          definition: {
            type: "tcp",
            url: "127.0.0.1",
            port: target.address().port,
          },
          message: "must not send",
        },
      },
    ],
  });
  assert.equal(result.valid, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections, 0);
  assert.deepEqual(await c.snapshot(), before);
});

test("existing and archived project previews preserve owner save policy without changing plans", async (t) => {
  const c = await fixture(t);
  const saved = await c.call(c.url.replace("plans-validate", "plans"), {
    name: "Existing",
    steps: [{ id: "leaf", request: { url: "http://127.0.0.1:1/" } }],
  });
  let project = await c.app.store.get(c.p.id);
  project.archived = true;
  await c.app.store.save(project);
  project = await c.app.store.get(c.p.id);
  const before = await c.snapshot();
  const result = await c.call(c.url, {
    ...saved,
    name: "Unsaved revision",
    projectConfigRevision: project.configRevision,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(await c.snapshot(), before);
  assert.equal((await c.app.store.get(c.p.id)).plans[0].name, "Existing");
});
