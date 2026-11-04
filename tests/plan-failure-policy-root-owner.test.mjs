// Root cross-contract, not another OAuth mode or failure-policy unit matrix.
// Only the owner explicitly acquires/saves fictional credentials. The real
// loopback POST, variable commit, ordinary failure and history are not mocked.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import {
  findExecutionResult,
  listExecutionHistory,
} from "../src/execution-history.mjs";
import { storedJSON } from "./helpers/stored-json.mjs";

const clientId = "failure-policy-fixture-client";
const clientSecret = "failure-policy-fixture-secret";
const accessToken = "failure-policy-fixture-access";
const refreshToken = "failure-policy-fixture-transient-refresh";
const acceptedEffect = "accepted-before-ordinary-failure";

function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function bytes(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await bytes(file)
      : (await readFile(file)).toString("base64");
  }
  return result;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "failure-policy-root-owner-"));
  const exchanges = [],
    resources = [],
    errors = [],
    appended = [];
  const appendTerminal = Promise.withResolvers();
  let app,
    projectId,
    durableAtFailure,
    effects = 0,
    runRequested = false,
    appendSettled = false;
  const peer = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.url === "/token") {
        exchanges.push(request.url);
        assert.equal(request.method, "POST");
        assert.equal(
          request.headers.authorization,
          "Basic " +
            Buffer.from(clientId + ":" + clientSecret).toString("base64"),
        );
        assert.deepEqual(
          [...new URLSearchParams(body)],
          [
            ["grant_type", "client_credentials"],
            ["scope", "resource:write"],
          ],
        );
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            access_token: accessToken,
            token_type: "Bearer",
            refresh_token: refreshToken,
            expires_in: 60,
          }),
        );
        return;
      }
      resources.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization,
        tenant: request.headers["x-tenant"],
        effect: request.headers["x-effect"],
        body,
      });
      assert.equal(request.headers["x-tenant"], "selected-environment");
      if (request.url === "/accepted") {
        assert.equal(request.method, "POST");
        assert.equal(request.headers.authorization, "Bearer " + accessToken);
        assert.deepEqual(JSON.parse(body), { tenant: "selected-environment" });
        effects++;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ effect: acceptedEffect }));
        return;
      }
      assert.equal(request.url, "/ordinary-failure");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers["x-effect"], acceptedEffect);
      // Read the real disk boundary before returning the next ordinary failure.
      // The successful response's environment update must already be durable.
      durableAtFailure = await new Store(root).get(projectId);
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"owned ordinary failure"}');
    } catch (error) {
      errors.push(error);
      response.writeHead(500);
      response.end("owned fixture validation failed");
    }
  });
  const closeApp = async () => {
    if (!app) return;
    const current = app;
    app = undefined;
    const closing = new Promise((resolve, reject) =>
      current.server.close((error) => (error ? reject(error) : resolve())),
    );
    current.server.closeIdleConnections();
    try {
      await bounded(closing, "owner app did not close");
    } catch (error) {
      current.server.closeAllConnections();
      throw error;
    }
  };
  t.after(async () => {
    const failures = [];
    const settle = async (operation) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    await settle(closeApp);
    if (runRequested && !appendSettled)
      await settle(() =>
        bounded(appendTerminal.promise, "owner append did not settle"),
      );
    peer.closeAllConnections();
    if (peer.listening)
      await settle(() => new Promise((resolve) => peer.close(resolve)));
    // Never race an uncertain server handler against removal of its project.
    if (!failures.length) await rm(root, { recursive: true, force: true });
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  app = await createApp({ root, port: 0 });
  const call = async (route, body, method = "POST") => {
    const response = await fetch(app.url + "/api/" + route, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const get = async (id) => {
    const response = await call(`projects/${id}`, undefined, "GET");
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return response.value;
  };
  return {
    root,
    exchanges,
    resources,
    errors,
    appended,
    call,
    get,
    base: `http://127.0.0.1:${peer.address().port}`,
    get store() {
      return app.store;
    },
    get effects() {
      return effects;
    },
    get durableAtFailure() {
      return durableAtFailure;
    },
    async run(id, planId) {
      projectId = id;
      const originalAppend = app.store.append;
      app.store.append = async function (targetId, field, record, ...rest) {
        const observed = targetId === id && field === "runs";
        if (observed) appended.push(structuredClone(record));
        try {
          return await originalAppend.call(
            this,
            targetId,
            field,
            record,
            ...rest,
          );
        } finally {
          if (observed) {
            appendSettled = true;
            appendTerminal.resolve();
          }
        }
      };
      runRequested = true;
      return call(`projects/${id}/run`, { planId });
    },
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
  };
}

test(
  "owner frozen OAuth2 stop preserves an accepted POST and durable extraction through ordinary failure, history, backup and restart without replay",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const project = await f.store.create("Explicit OAuth2 failure stop"),
      other = await f.store.create("Isolated peer project");
    project.environments[0].variables = {
      tenant: "selected-environment",
      acceptedEffect: "not-yet-committed",
    };
    project.environments.push({
      id: "unselected",
      name: "Unselected environment",
      variables: { tenant: "unselected", acceptedEffect: "peer-marker" },
    });
    await f.store.save(project);
    const before = await f.get(project.id),
      otherBefore = await f.get(other.id),
      otherBytes = await bytes(f.store.directory(other.id));
    const exchanged = await f.call("oauth/token", {
      tokenEndpoint: f.base + "/token",
      clientAuthentication: "basic",
      clientId,
      clientSecret,
      grantType: "client_credentials",
      scope: "resource:write",
    });
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.value));
    assert.equal(exchanged.value.accessToken, accessToken);
    assert.equal(exchanged.value.tokenType, "Bearer");
    assert.deepEqual(
      await f.get(project.id),
      before,
      "exchange alone cannot save credentials",
    );
    assert.deepEqual(f.exchanges, ["/token"]);
    assert.deepEqual(f.resources, []);

    const request = (id, target) => ({
      id,
      name: id,
      method: "GET",
      url: f.base + target,
      timeout: 3000,
      headers: [{ key: "X-Tenant", value: "{{tenant}}" }],
      auth: { type: "none" },
    });
    const accepted = {
      ...request("accepted-api", "/accepted"),
      method: "POST",
      bodyType: "json",
      body: '{"tenant":"{{tenant}}"}',
      auth: { type: "oauth2", token: exchanged.value.accessToken },
      extract: [
        {
          name: "acceptedEffect",
          source: "json",
          path: "$.effect",
          scope: "environment",
        },
      ],
    };
    const failed = request("failed-api", "/ordinary-failure");
    failed.headers.push({ key: "X-Effect", value: "{{acceptedEffect}}" });
    const explicit = await f.get(project.id);
    explicit.requests = [accepted, failed];
    const saved = await f.call(`projects/${project.id}`, explicit, "PUT");
    assert.equal(saved.status, 200, JSON.stringify(saved.value));
    const made = await f.call(`projects/${project.id}/plans`, {
      name: "Frozen OAuth2 failure stop",
      environmentId: project.environments[0].id,
      failurePolicy: "stop",
      statusPolicy: "strict200",
      steps: [
        {
          id: "repeat",
          type: "repeat",
          count: 2,
          steps: [
            { id: "accepted", request: saved.value.requests[0] },
            {
              id: "committed-gate",
              type: "if",
              condition: {
                op: "eq",
                left: { scope: "environment", name: "acceptedEffect" },
                right: { literal: acceptedEffect },
              },
              steps: [
                { id: "failed", request: saved.value.requests[1] },
                {
                  id: "never-child",
                  request: request("never-child-api", "/never-child"),
                },
              ],
            },
            {
              id: "never-repeat-tail",
              request: request("never-repeat-api", "/never-repeat-tail"),
            },
          ],
        },
        {
          id: "never-tail",
          request: request("never-tail-api", "/never-tail"),
        },
      ],
    });
    assert.equal(made.status, 200, JSON.stringify(made.value));
    const frozen = (await f.get(project.id)).plans.find(
      (plan) => plan.id === made.value.id,
    );
    assert.equal(frozen.failurePolicy, "stop");
    const live = await f.get(project.id);
    live.requests[0].url = f.base + "/edited-must-not-send";
    live.requests[0].auth.token = "edited-live-token-must-not-send";
    assert.equal(
      (await f.call(`projects/${project.id}`, live, "PUT")).status,
      200,
    );
    assert.deepEqual((await f.get(project.id)).plans[0], frozen);

    const response = await f.run(project.id, frozen.id);
    assert.equal(response.status, 200, JSON.stringify(response.value));
    assert.deepEqual(f.errors, []);
    const run = response.value;
    assert.equal(run.status, "failed");
    assert.equal(run.stopReason, "step-failure");
    assert.equal(run.recordSaved, true, run.persistenceError);
    assert.equal(run.recordId, run.id);
    assert.equal(run.attemptedRecordId, run.id);
    assert.deepEqual(run.snapshot, frozen);
    assert.deepEqual(
      run.results.map((entry) => entry.stepId),
      ["accepted", "failed"],
    );
    assert.equal(run.results[0].status, "passed");
    assert.equal(run.results[0].response.status, 200);
    assert.deepEqual(JSON.parse(run.results[0].response.body), {
      effect: acceptedEffect,
    });
    assert.equal(run.results[0].request.auth.token, accessToken);
    assert.equal(run.results[0].request.url, f.base + "/accepted");
    assert.equal(run.results[1].status, "failed");
    assert.equal(run.results[1].response.status, 503);
    assert.equal(
      run.results[1].response.body,
      '{"error":"owned ordinary failure"}',
    );
    for (const result of run.results) {
      assert.equal(result.repeat.groupId, "repeat");
      assert.equal(result.repeat.iteration, 0);
    }
    assert.deepEqual(run.failureStop, {
      stepId: "failed",
      repeat: run.results[1].repeat,
    });
    assert.deepEqual(
      run.conditionResults.map((entry) => [entry.stepId, entry.matched]),
      [["committed-gate", true]],
    );
    assert.equal(run.variables.acceptedEffect, acceptedEffect);
    assert.equal(f.effects, 1);
    assert.deepEqual(
      f.resources.map((entry) => [entry.method, entry.url]),
      [
        ["POST", "/accepted"],
        ["GET", "/ordinary-failure"],
      ],
    );
    assert.equal(
      f.durableAtFailure.environments[0].variables.acceptedEffect,
      acceptedEffect,
    );
    assert.equal(f.durableAtFailure.runs.length, 0);
    assert.equal(
      f.appended.length,
      1,
      "one terminal history append, never a request retry",
    );
    const recorded = await f.get(project.id);
    const stored = findExecutionResult(recorded, run.id);
    assert.equal(recorded.runs.length, 1);
    assert.deepEqual(stored, storedJSON(f.appended[0]));
    assert.deepEqual(stored.results, run.results);
    assert.deepEqual(stored.snapshot, run.snapshot);
    assert.equal(stored.planHash, run.planHash);
    assert.deepEqual(stored.failureStop, run.failureStop);
    assert.equal(stored.stopReason, "step-failure");
    assert.equal(
      recorded.environments[0].variables.acceptedEffect,
      acceptedEffect,
    );
    assert.deepEqual(recorded.environments[1], before.environments[1]);
    const summaries = listExecutionHistory(recorded, {
      scope: "flow",
      source: "manual",
      planId: frozen.id,
    });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].status, "failed");
    assert.equal(summaries[0].failedStepCount, 1);
    assert.equal(summaries[0].stopReason, "step-failure");
    assert.deepEqual(summaries[0].failureStop, run.failureStop);
    assert.equal(JSON.stringify(summaries).includes(accessToken), false);

    const backup = await f.call(
      `projects/${project.id}/export`,
      undefined,
      "GET",
    );
    assert.equal(backup.status, 200);
    for (const transient of [clientId, clientSecret, refreshToken])
      assert.equal(JSON.stringify(backup.value).includes(transient), false);
    assert.deepEqual(findExecutionResult(backup.value, run.id), stored);
    const restored = await f.call("restore", { document: backup.value });
    assert.equal(restored.status, 201, JSON.stringify(restored.value));
    assert.notEqual(restored.value.id, project.id);
    await f.restart();
    assert.deepEqual(await new Store(f.root).get(project.id), recorded);
    const copy = await f.get(restored.value.id);
    assert.equal(copy.runs.length, 1);
    assert.deepEqual(findExecutionResult(copy, run.id), stored);
    assert.deepEqual(copy.plans, recorded.plans);
    assert.deepEqual(copy.environments, recorded.environments);
    assert.deepEqual(await f.get(other.id), otherBefore);
    assert.deepEqual(await bytes(f.store.directory(other.id)), otherBytes);
    assert.equal(
      f.effects,
      1,
      "history/restore/restart cannot roll back or repeat the accepted POST",
    );
    assert.deepEqual(
      f.exchanges,
      ["/token"],
      "failure/restore/restart cannot exchange or refresh credentials",
    );
    assert.deepEqual(
      f.resources.map((entry) => entry.url),
      ["/accepted", "/ordinary-failure"],
    );
    assert.equal(f.appended.length, 1);
  },
);
