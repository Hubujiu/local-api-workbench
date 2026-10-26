import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import protobuf from "protobufjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import {
  extendedProtocolFixture,
  extendedProto,
} from "./fixtures/apipost-extended-protocols.mjs";
test(
  "native verified TLS declaration closes mTLS metadata SDK persistence and restart without importing certificate authority",
  { timeout: 20000 },
  async (t) => {
    const cert = await readFile(
        new URL("./fixtures/localhost.crt", import.meta.url),
        "utf8",
      ),
      key = await readFile(
        new URL("./fixtures/localhost.key", import.meta.url),
        "utf8",
      );
    const pkg = grpc.loadPackageDefinition(
        loader.fromJSON(protobuf.parse(extendedProto).root.toJSON(), {
          longs: String,
          bytes: String,
          defaults: true,
        }),
      ),
      server = new grpc.Server(),
      seen = [];
    server.addService(pkg.sample.Echo.service, {
      Unary(call, cb) {
        seen.push(call.metadata.get("authorization")[0]);
        if (
          call.metadata.get("authorization")[0] !== "Bearer runtime-tls-token"
        )
          return cb({ code: 16, details: "unauthenticated" });
        cb(null, call.request);
      },
    });
    const port = await new Promise((r, j) =>
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createSsl(
          Buffer.from(cert),
          [{ private_key: Buffer.from(key), cert_chain: Buffer.from(cert) }],
          true,
        ),
        (e, p) => (e ? j(e) : r(p)),
      ),
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "native-grpc-tls-"));
    let app = await createApp({ root, port: 0 });
    const client = new Client(
      { name: "native-grpc-tls", version: "1" },
      { capabilities: {} },
    );
    t.after(async () => {
      await client.close().catch(() => {});
      server.forceShutdown();
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const source = extendedProtocolFixture({ grpc: "localhost:" + port });
    source.apis = source.apis.filter((n) => n.target_type === "grpc");
    const method = source.apis[0].protos[0].services[0].methods[0];
    method.ssl = method.tls = 1;
    method.request.metadata.parameter = [
      { key: "authorization", value: "SOURCE-TLS-TOKEN", is_checked: 1 },
    ];
    const original = JSON.stringify(source),
      p = await app.store.create("Native TLS");
    importIntoProject(p, source);
    await app.store.save(p);
    assert.equal(JSON.stringify(source), original);
    assert.match(p.settings.grpcDefinitions[0].target, /^grpcs:\/\/localhost:/);
    assert.doesNotMatch(
      JSON.stringify(p),
      /SOURCE-TLS-TOKEN|BEGIN.*PRIVATE KEY|BEGIN CERTIFICATE/,
    );
    const invalid = structuredClone(source);
    invalid.apis[0].protos[0].services[0].methods[0].ssl = -1;
    const before = JSON.stringify(p);
    assert.throws(() => importIntoProject(p, invalid), /证书验证/);
    assert.equal(JSON.stringify(p), before);
    const restored = restoreProject(p);
    await app.store.save(restored);
    const metadata = [
        { key: "authorization", value: "Bearer runtime-tls-token" },
      ],
      owner = {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      definition = p.settings.grpcDefinitions[0],
      body = {
        definitionId: definition.id,
        messages: [{ text: "secure", big: "9007199254740993" }],
        metadata,
      };
    const execute = async (input) => {
      const r = await fetch(app.url + "/api/projects/" + p.id + "/grpc-run", {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ ...body, ...input }),
      });
      return { status: r.status, data: await r.json() };
    };
    const untrusted = await execute({});
    assert.equal(untrusted.status, 200);
    assert.notEqual(untrusted.data.status.code, 0);
    const missingClient = await execute({ tls: { ca: cert } });
    assert.equal(missingClient.status, 200);
    assert.notEqual(missingClient.data.status.code, 0);
    assert.equal(seen.length, 0);
    const trusted = await execute({ tls: { ca: cert, key, cert } });
    assert.equal(trusted.status, 200);
    assert.equal(trusted.data.status.code, 0);
    const rejected = await execute({ tls: { rejectUnauthorized: false } });
    assert.equal(rejected.status, 400);
    const config = await (
      await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: owner,
        body: JSON.stringify({
          enabled: true,
          projects: [p.id],
          write: true,
          execute: true,
          remember: false,
        }),
      })
    ).json();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    const plan = p.plans[0],
      binding = {
        [plan.steps[0].id]: { metadata, tls: { ca: cert, key, cert } },
      };
    const run = await client.callTool({
      name: "localapi_execute_flow",
      arguments: { projectId: p.id, planId: plan.id, grpcCredentials: binding },
    });
    assert.notEqual(run.isError, true, run.content[0].text);
    assert.equal(JSON.parse(run.content[0].text).status, "passed");
    assert.equal(seen.length, 2);
    const saved = await app.store.get(p.id);
    assert.doesNotMatch(
      JSON.stringify(saved),
      /SOURCE-TLS-TOKEN|runtime-tls-token|BEGIN.*PRIVATE KEY|BEGIN CERTIFICATE/,
    );
    await client.close();
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    app = await createApp({ root, port: 0 });
    assert.equal(
      (await app.store.get(restored.id)).settings.grpcDefinitions[0].target,
      definition.target,
    );
    const forgotten = await fetch(
      app.url + "/api/projects/" + restored.id + "/grpc-run",
      {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(forgotten.status, 200);
    assert.notEqual((await forgotten.json()).status.code, 0);
    assert.equal(seen.length, 2);
  },
);
