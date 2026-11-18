import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { createApp } from "../src/server.mjs";
import {
  createGrpcStreamState,
  createGrpcStreamController,
  invalidateGrpcStream,
} from "../public/grpc-stream-workbench.js";

test(
  "real gRPC entirely lost creation response recovers through retained intent without replay",
  { timeout: 15000 },
  async (t) => {
    const protoFile = new URL("./fixtures/grpc.proto", import.meta.url);
    const definitions = loader.loadSync(fileURLToPath(protoFile));
    const peer = new grpc.Server();
    let starts = 0,
      messages = 0,
      posts = 0,
      reads = 0;
    peer.addService(
      grpc.loadPackageDefinition(definitions).fixture.Echo.service,
      {
        Chat(call) {
          starts++;
          call.on("data", () => messages++);
          call.on("end", () => call.end());
          call.on("error", () => {});
        },
      },
    );
    const port = await new Promise((resolve, reject) =>
      peer.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (error, bound) => (error ? reject(error) : resolve(bound)),
      ),
    );
    const root = await mkdtemp(tmpdir() + "/grpc-known-start-");
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      await app.close();
      peer.forceShutdown();
      await rm(root, { recursive: true, force: true });
    });
    const project = await app.store.create("known start recovery");
    const foreign = await app.store.create("not the stream owner");
    const call = async (action, method, body, projectId = project.id) => {
      const response = await fetch(
        app.url + "/api/projects/" + projectId + "/" + action,
        {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      const value = await response.json();
      if (!response.ok) throw Error(value.error);
      return value;
    };
    const { definition } = await call("grpc-definitions", "POST", {
      target: "grpc://127.0.0.1:" + port,
      proto: await readFile(protoFile, "utf8"),
      service: "fixture.Echo",
      method: "Chat",
      timeoutMs: 10000,
    });
    let saved;
    const state = createGrpcStreamState();
    state.definitionId = definition.id;
    const options = {
      state,
      creationIntents: true,
      definitions: [definition],
      assertCurrent() {},
      setBusy() {},
      inspectDefinition: () =>
        call("grpc-schema", "POST", { proto: definition.proto }),
      persistEvidence(s) {
        saved = structuredClone({
          definitionId: s.definitionId,
          creationIntentId: s.creationIntentId,
          creationInstanceId: s.creationInstanceId,
          sessionId: s.sessionId,
          sessionIdKnown: s.sessionIdKnown,
          startRecoveryId: s.startRecoveryId,
          uncertainStart: s.uncertainStart,
          uncertainSessions: s.uncertainSessions,
          persistenceProblems: s.persistenceProblems,
        });
        return true;
      },
      post: async (path, body) => {
        posts++;
        const value = await call(path, "POST", body);
        if (path === "grpc-sessions") throw Error("lost entire HTTP response");
        return value;
      },
      get: async (path) => {
        reads++;
        return call(path, "GET");
      },
    };
    await createGrpcStreamController(options).start();
    assert.equal(state.session, null);
    assert.equal(state.uncertainStart, true);
    assert.equal(saved.startRecoveryId, "");
    assert.ok(saved.creationIntentId);
    assert.equal(saved.sessionId, "");
    const restored = Object.assign(createGrpcStreamState(), saved);
    await createGrpcStreamController({ ...options, state: restored }).poll();
    assert.ok(restored.sessionId);
    assert.equal(restored.uncertainStart, false);
    assert.equal(reads, 1);
    for (let i = 0; i < 100 && starts < 1; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(starts, 1);
    assert.equal(posts, 2);
    assert.equal(messages, 0);
    const wrong = Object.assign(createGrpcStreamState(), saved, {
      uncertainStart: true,
    });
    await createGrpcStreamController({
      ...options,
      state: wrong,
      get: (path) => call(path, "GET", undefined, foreign.id),
    }).poll();
    assert.equal(wrong.uncertainStart, true);
    assert.match(wrong.notice, /不属于/);
    assert.equal(starts, 1);
    assert.equal(posts, 2);
    assert.equal(messages, 0);
  },
);
