import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { executeGrpc } from "../src/grpc.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";

test(
  "data rows and nested repeats reach real gRPC and TCP scripts without disclosing credentials",
  { timeout: 20000 },
  async (t) => {
    const tcpSeen = [],
      grpcSeen = [];
    const tcp = createServer((socket) =>
      socket.once("data", (data) => {
        tcpSeen.push(data.toString());
        socket.end(data);
      }),
    );
    await new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const rpc = new grpc.Server();
    const fixture = new URL("./fixtures/grpc.proto", import.meta.url);
    const proto = await readFile(fixture, "utf8");
    const service = grpc.loadPackageDefinition(
      loader.loadSync(fileURLToPath(fixture)),
    ).fixture.Echo.service;
    rpc.addService(service, {
      Unary(call, callback) {
        grpcSeen.push([
          call.request.text,
          call.metadata.get("authorization")[0],
        ]);
        const metadata = new grpc.Metadata();
        metadata.set("server-private", "private-header-marker");
        call.sendMetadata(metadata);
        callback(null, call.request);
      },
    });
    const port = await new Promise((resolve, reject) =>
      rpc.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (error, bound) => (error ? reject(error) : resolve(bound)),
      ),
    );
    t.after(async () => {
      rpc.forceShutdown();
      await new Promise((resolve) => tcp.close(resolve));
    });
    const before =
      "pm.test('iteration',()=>pm.expect(pm.info.iteration).to.equal(pm.iterationData.get('index')));apt.setVar('wireValue',pm.iterationData.get('name'));";
    const g = {
      id: "g",
      type: "grpc",
      grpc: {
        definition: {
          target: `grpc://127.0.0.1:${port}`,
          proto,
          service: "fixture.Echo",
          method: "Unary",
          requiredMetadata: ["authorization"],
        },
        messages: [{ text: "{{wireValue}}" }],
      },
      grpcScripts: {
        version: 1,
        before,
        after:
          "pm.test('native echo',()=>{pm.expect(grpc.result.messages[0].text).to.equal(pm.iterationData.get('name'));pm.expect(grpc.request.metadata).to.equal(undefined);pm.expect(grpc.result.metadata).to.equal(undefined);});",
      },
    };
    const w = {
      id: "w",
      type: "protocol",
      protocol: {
        definition: { type: "tcp", url: "127.0.0.1", port: tcp.address().port },
        message: "{{wireValue}}",
      },
      protocolScripts: {
        version: 1,
        before,
        after:
          "pm.test('native echo',()=>pm.expect(wire.result.result.body).to.equal(pm.iterationData.get('name')));",
      },
    };
    const plan = snapshotPlan({
      steps: [
        {
          id: "rows",
          type: "repeat",
          count: 2,
          rows: [
            { name: "first", index: 0 },
            { name: "second", index: 1 },
          ],
          steps: [{ id: "fixed", type: "repeat", count: 2, steps: [g, w] }],
        },
      ],
    });
    const options = {
      executeGrpc,
      executeProtocol: executeWireFlow,
      grpcCredentials: {
        g: {
          metadata: [{ key: "authorization", value: "private-auth-marker" }],
        },
      },
    };
    const result = await runPlan(
      plan,
      {},
      async () => {
        throw Error("unexpected HTTP");
      },
      options,
    );
    assert.equal(
      result.status,
      "passed",
      JSON.stringify(
        result.results.map((row) => ({ id: row.stepId, error: row.error })),
      ),
    );
    assert.deepEqual(grpcSeen, [
      ["first", "private-auth-marker"],
      ["first", "private-auth-marker"],
      ["second", "private-auth-marker"],
      ["second", "private-auth-marker"],
    ]);
    assert.deepEqual(tcpSeen, ["first", "first", "second", "second"]);
    assert.equal(result.results.length, 8);
    assert(!JSON.stringify(result).includes("private-auth-marker"));
    assert(!JSON.stringify(result).includes("private-header-marker"));
    const beforeCount = grpcSeen.length;
    await assert.rejects(
      () =>
        runPlan(
          plan,
          {},
          async () => {
            throw Error("unexpected HTTP");
          },
          { executeGrpc, executeProtocol: executeWireFlow },
        ),
      /缺少|认证|metadata|Metadata/,
    );
    assert.equal(grpcSeen.length, beforeCount);
  },
);

test(
  "data rows reach real WebSocket and SSE scripts without leaking runtime grants",
  { timeout: 20000 },
  async (t) => {
    const { createServer: createHTTP } = await import("node:http");
    const { WebSocketServer } = await import("ws");
    const { once } = await import("node:events");
    const wsSeen = [],
      sseSeen = [];
    const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(ws, "listening");
    ws.on("connection", (socket, req) =>
      socket.once("message", (data) => {
        wsSeen.push([data.toString(), req.headers["x-grant"]]);
        socket.send(data.toString(), () => socket.close(1000, "done"));
      }),
    );
    const sse = createHTTP(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      sseSeen.push([body, req.headers["x-grant"]]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("event: echo\ndata: " + body + "\n\n");
    });
    await new Promise((resolve) => sse.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const client of ws.clients) client.terminate();
      await new Promise((resolve) => ws.close(resolve));
      sse.closeAllConnections();
      await new Promise((resolve) => sse.close(resolve));
    });
    const before =
      "pm.test('row+phase',()=>{pm.expect(pm.info.iteration).to.equal(pm.iterationData.get('i'));pm.expect(wire.phase).to.equal('before');pm.expect(wire.request.headers).to.equal(undefined);pm.expect(pm.response).to.equal(undefined);pm.expect(()=>apt.sendRequest('http://127.0.0.1:1')).to.throw();});apt.setVar('value',pm.iterationData.get('name'));";
    const w = {
      id: "ws",
      type: "protocol",
      protocol: {
        definition: {
          type: "websocket",
          url: `ws://127.0.0.1:${ws.address().port}`,
          handshake: { requiredHeaders: ["x-grant"] },
        },
        message: "{{value}}",
      },
      protocolScripts: {
        version: 1,
        before,
        after:
          "pm.test('post row+native',()=>{pm.expect(wire.phase).to.equal('after');pm.expect(wire.result.result.messages[0].data).to.equal(pm.iterationData.get('name'));pm.expect(wire.request.message).to.equal(pm.iterationData.get('name'));pm.expect(pm.info.protocol).to.equal('websocket');});",
      },
    };
    const s = {
      id: "sse",
      type: "protocol",
      protocol: {
        definition: {
          type: "sse",
          url: `http://127.0.0.1:${sse.address().port}`,
          method: "POST",
          body: "{{value}}",
          templateMode: "variables",
          handshake: { requiredHeaders: ["x-grant"] },
        },
      },
      protocolScripts: {
        version: 1,
        before,
        after:
          "pm.test('post row+native',()=>{pm.expect(wire.phase).to.equal('after');pm.expect(wire.result.result.events[0].data).to.equal(pm.iterationData.get('name'));pm.expect(wire.request.body).to.equal(pm.iterationData.get('name'));pm.expect(pm.info.protocol).to.equal('sse');});",
      },
    };
    const plan = snapshotPlan({
      steps: [
        {
          id: "rows",
          type: "repeat",
          count: 2,
          rows: [
            { name: "one", i: 0 },
            { name: "two", i: 1 },
          ],
          steps: [{ id: "nested", type: "repeat", count: 2, steps: [w, s] }],
        },
      ],
    });
    const credentials = {
      ws: { headers: { "x-grant": "private-grant-marker" } },
      sse: { headers: { "x-grant": "private-grant-marker" } },
    };
    const result = await runPlan(
      plan,
      {},
      async () => {
        throw Error("HTTP main forbidden");
      },
      { executeProtocol: executeWireFlow, protocolCredentials: credentials },
    );
    assert.equal(
      result.status,
      "passed",
      JSON.stringify(
        result.results.map((item) => ({
          error: item.error,
          assertions: item.assertions,
        })),
      ),
    );
    assert.deepEqual(
      wsSeen.map((item) => item[0]),
      ["one", "one", "two", "two"],
    );
    assert.deepEqual(
      sseSeen.map((item) => item[0]),
      ["one", "one", "two", "two"],
    );
    assert(
      [...wsSeen, ...sseSeen].every(
        (item) => item[1] === "private-grant-marker",
      ),
    );
    assert(!JSON.stringify(result).includes("private-grant-marker"));
    assert.equal(result.results.length, 8);
    let dispatched = 0;
    await assert.rejects(() =>
      runPlan(plan, {}, async () => dispatched++, {
        executeProtocol: async () => dispatched++,
        protocolCredentials: { ws: credentials.ws },
      }),
    );
    assert.equal(dispatched, 0);
  },
);
