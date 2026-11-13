import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../../src/server.mjs";

// Synthetic accounts only. Explicit stop prevents login after failed registration;
// it cannot undo registration, or promise exactly-once remote business effects.
export async function registerLoginScenario(t, failRegistration) {
  const root = await mkdtemp(path.join(tmpdir(), "register-login-"));
  const app = await createApp({ root, port: 0 });
  const seen = [];
  const peer = http.createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      user: req.headers["x-created-user"],
    });
    const registration = req.url === "/register";
    res.writeHead(
      registration
        ? failRegistration
          ? 409
          : 201
        : req.headers["x-created-user"] === "synthetic-created-user"
          ? 200
          : 401,
      { "content-type": "application/json" },
    );
    res.end(
      JSON.stringify(
        registration
          ? { userId: "synthetic-created-user" }
          : {
              authenticated:
                req.headers["x-created-user"] === "synthetic-created-user",
            },
      ),
    );
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const client = new Client({
    name: "register-login-acceptance",
    version: "1.0.0",
  });
  t.after(async () => {
    await client.close();
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all([
      new Promise((r) => app.server.close(r)),
      new Promise((r) => peer.close(r)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Synthetic registration and login");
  const owner = async (route, body) => {
    const response = await fetch(app.url + "/api/" + route, {
      method: body ? "POST" : "GET",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const config = await owner("mcp/config", {
    enabled: true,
    projects: [project.id],
    write: true,
    execute: true,
    remember: false,
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + config.token } },
    }),
  );
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const url = `http://127.0.0.1:${peer.address().port}`;
  const plan = await call("localapi_save_plan", {
    projectId: project.id,
    plan: {
      name: "Register then login (synthetic)",
      statusPolicy: "assertions",
      failurePolicy: "stop",
      steps: [
        {
          id: "register",
          expectedStatus: 201,
          request: {
            name: "Register synthetic account",
            method: "POST",
            url: url + "/register",
            extract: [
              { name: "createdUser", source: "json", path: "$.userId" },
            ],
            assertions: [{ target: "status", op: "eq", value: 201 }],
          },
        },
        {
          id: "login",
          request: {
            name: "Login using returned user",
            method: "POST",
            url: url + "/login",
            headers: [{ key: "x-created-user", value: "{{createdUser}}" }],
            assertions: [{ target: "status", op: "eq", value: 200 }],
          },
        },
      ],
    },
  });
  const run = await call("localapi_run_plan", {
    projectId: project.id,
    planId: plan.id,
  });
  assert.equal(run.recordSaved, true);
  assert.equal(run.snapshot.failurePolicy, "stop");
  assert.equal(
    run.status,
    failRegistration ? "failed" : "passed",
    JSON.stringify(run),
  );
  assert.deepEqual(
    seen.map((x) => [x.method, x.url]),
    failRegistration
      ? [["POST", "/register"]]
      : [
          ["POST", "/register"],
          ["POST", "/login"],
        ],
  );
  assert.deepEqual(
    run.results.map((x) => x.stepId),
    failRegistration ? ["register"] : ["register", "login"],
  );
  if (failRegistration) {
    assert.equal(run.stopReason, "step-failure");
    assert.equal(run.failureStop.stepId, "register");
  } else {
    assert.equal(seen[1].user, JSON.parse(run.results[0].response.body).userId);
    assert.equal(JSON.parse(run.results[1].response.body).authenticated, true);
  }
  const stored = await owner("projects/" + project.id);
  const evidence = stored.runs.find((x) => x.id === run.id);
  assert.ok(
    evidence,
    "same persisted run must be available to desktop history",
  );
  assert.deepEqual(evidence.results, run.results);
  assert.equal(evidence.planHash, run.planHash);
  assert.equal(
    stored.plans.find((x) => x.id === plan.id).failurePolicy,
    "stop",
  );
  assert.equal(
    seen.length,
    failRegistration ? 1 : 2,
    "read-only desktop source must not replay",
  );
  return { app, project, plan, run, seen };
}
