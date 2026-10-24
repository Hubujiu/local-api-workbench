import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { executeGrpc } from "../src/grpc.mjs";
const file = new URL("./fixtures/grpc.proto", import.meta.url),
  proto = await readFile(file, "utf8");
const cert = await readFile(
    new URL("./fixtures/localhost.crt", import.meta.url),
    "utf8",
  ),
  key = await readFile(
    new URL("./fixtures/localhost.key", import.meta.url),
    "utf8",
  );
async function fixture(t) {
  const server = new grpc.Server();
  const seen = [];
  const pkg = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(file), {
      longs: String,
      bytes: String,
      defaults: true,
    }),
  );
  server.addService(pkg.fixture.Echo.service, {
    Unary(call, done) {
      const token = call.metadata.get("authorization")[0];
      seen.push(token);
      if (token !== "Bearer fixture-ephemeral-secret")
        return done({ code: 16, details: "unauthenticated" });
      const headers = new grpc.Metadata();
      headers.set("x-private", "fixture-ephemeral-secret");
      call.sendMetadata(headers);
      done(null, call.request);
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createSsl(
        Buffer.from(cert),
        [{ private_key: Buffer.from(key), cert_chain: Buffer.from(cert) }],
        true,
      ),
      (e, p) => (e ? reject(e) : resolve(p)),
    ),
  );
  t.after(() => server.forceShutdown());
  return {
    seen,
    definition: {
      id: "secure",
      target: `grpcs://localhost:${port}`,
      proto,
      service: "fixture.Echo",
      method: "Unary",
    },
  };
}
const binding = {
  tls: { ca: cert, key, cert },
  metadata: [
    { key: "authorization", value: "Bearer fixture-ephemeral-secret" },
  ],
};
test("gRPC plan uses per-run mTLS and metadata without saving credentials, then forgets them", async (t) => {
  const f = await fixture(t);
  const root = await mkdtemp(path.join(tmpdir(), "grpc-credential-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("secure");
  p.plans = [
    snapshotPlan({
      steps: [
        {
          id: "secure-step",
          type: "grpc",
          grpc: { definition: f.definition, messages: [{ text: "payload" }] },
        },
      ],
    }),
  ];
  await app.store.save(p);
  const base = app.url + "/api/projects/" + p.id;
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const run = async (grpcCredentials) => {
    const r = await fetch(base + "/run", {
      method: "POST",
      headers,
      body: JSON.stringify({ planId: p.plans[0].id, grpcCredentials }),
    });
    const v = await r.json();
    assert.equal(r.status, 200, JSON.stringify(v));
    return v;
  };
  const first = await run({ "secure-step": binding });
  assert.equal(first.status, "passed");
  assert.equal(first.results[0].grpcResult.messages[0].text, "payload");
  assert.equal(first.recordSaved, true);
  for (const value of [first, await new Store(root).get(p.id)]) {
    const text = JSON.stringify(value);
    assert(!text.includes("fixture-ephemeral-secret"));
    assert(!text.includes("BEGIN PRIVATE KEY"));
    assert(!text.includes("BEGIN CERTIFICATE"));
  }
  const noToken = await run({ "secure-step": { tls: binding.tls } });
  assert.equal(noToken.status, "failed");
  assert.equal(noToken.results[0].grpcResult.status.code, 16);
  const absent = await run();
  assert.equal(absent.status, "failed");
  assert.notEqual(absent.results[0].grpcResult.status.code, 0);
  assert.equal(f.seen.length, 2);
  const [good, bad] = await Promise.all([
    run({ "secure-step": binding }),
    run({
      "secure-step": {
        tls: binding.tls,
        metadata: [{ key: "authorization", value: "wrong-fixture-token" }],
      },
    }),
  ]);
  assert.equal(good.status, "passed");
  assert.equal(bad.status, "failed");
  assert.equal(bad.results[0].grpcResult.status.code, 16);
  const enabled = await (
    await fetch(app.url + "/api/mcp/config", {
      method: "POST",
      headers,
      body: JSON.stringify({
        enabled: true,
        projects: [p.id],
        write: true,
        execute: true,
      }),
    })
  ).json();
  for (const name of ["localapi_execute_flow", "localapi_run_plan"]) {
    const result = await (
      await fetch(app.url + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + enabled.token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name,
            arguments: {
              projectId: p.id,
              planId: p.plans[0].id,
              grpcCredentials: { "secure-step": binding },
            },
          },
        }),
      })
    ).json();
    assert.notEqual(result.result.isError, true, JSON.stringify(result));
    assert.equal(JSON.parse(result.result.content[0].text).status, "passed");
  }
  const persisted = JSON.stringify(await new Store(root).get(p.id));
  assert(!persisted.includes("fixture-ephemeral-secret"));
  assert(!persisted.includes("wrong-fixture-token"));
  assert(!persisted.includes("BEGIN PRIVATE KEY"));
});
test("gRPC plan credential binding rejects unknown steps, endpoint overrides and TLS bypass before any request", async (t) => {
  const f = await fixture(t);
  const plan = snapshotPlan({
    steps: [
      {
        id: "s",
        type: "grpc",
        grpc: { definition: f.definition, messages: [{}] },
      },
    ],
  });
  for (const grpcCredentials of [
    { foreign: binding },
    { s: { ...binding, target: "grpc://127.0.0.1:1" } },
    { s: { tls: { rejectUnauthorized: false } } },
    { s: { metadata: [{ key: "bad\nkey", value: "x" }] } },
    { s: { tls: { key } } },
  ])
    await assert.rejects(
      runPlan(plan, {}, () => {}, { executeGrpc, grpcCredentials }),
    );
  assert.equal(f.seen.length, 0);
  let httpCalls = 0;
  const mixed = snapshotPlan({
    steps: [
      { request: { url: "http://fixture.invalid", method: "POST" } },
      ...plan.steps,
    ],
  });
  await assert.rejects(
    runPlan(
      mixed,
      {},
      async () => {
        httpCalls++;
        return { status: 200, body: "{}", headers: {} };
      },
      { executeGrpc, grpcCredentials: { s: { tls: { key } } } },
    ),
  );
  assert.equal(httpCalls, 0);
});
