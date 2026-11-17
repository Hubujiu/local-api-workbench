// Full owner HTTP workflow against an independent real TCP RESP peer.
// Real Redis storage/TTL behavior belongs to the provider integration suite.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/server.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseRESP } from "../src/redis.mjs";
import { nativeRedisFixture } from "./fixtures/apipost-redis.mjs";

async function fixture(
  t,
  { phase = "before", hold = false, holdStage, reply = "+OK\r\n" } = {},
) {
  const commands = [],
    sockets = [],
    requests = [];
  let reached, blocked, release;
  const stageReached = new Promise((resolve) => {
    blocked = resolve;
  });
  const setReached = new Promise((resolve) => {
    reached = resolve;
  });
  const redis = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      const frame = parseRESP(bytes);
      if (!frame) return;
      assert.equal(frame.bytes, bytes.length);
      bytes = Buffer.alloc(0);
      const command = frame.value.map((part) => part.toString());
      commands.push(command);
      const response = command[0] === "SET" ? reply : "+OK\r\n";
      release = () =>
        response === null ? socket.end() : socket.write(response);
      if (command[0] === "SET") reached();
      if (command[0] === holdStage) blocked();
      else if (!(hold && command[0] === "SET")) release();
    });
  });
  await new Promise((resolve) => redis.listen(0, "127.0.0.1", resolve));
  const echo = http.createServer((req, res) => {
    requests.push({ url: req.url, value: req.headers["x-native-value"] });
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "native-owner-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    echo.closeAllConnections();
    await new Promise((resolve) => echo.close(resolve));
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => redis.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Native owner fixture");
  async function api(
    path,
    data = {},
    { method = "POST", token = app.token } = {},
  ) {
    const response = await fetch(app.url + path, {
      method,
      headers: { "x-local-token": token, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, data: await response.json() };
  }
  const base = `/api/projects/${project.id}`;
  const document = nativeRedisFixture(
    `http://127.0.0.1:${echo.address().port}/effect`,
    {
      method: "set",
      query: JSON.stringify({ key: "fictional:key", value: "fictional-value" }),
    },
  );
  const request = document.apis.find(
    (api) => api.target_type === "api",
  ).request;
  const write = request.pre_tasks.find((task) => task.type === "database");
  const script = (id, data) => ({
    id,
    name: id,
    type: "customScript",
    enabled: 1,
    data,
  });
  request.pre_tasks = [];
  request.post_tasks = [];
  request[phase === "before" ? "pre_tasks" : "post_tasks"] = [
    script("start", 'pm.environment.set("owner_script_started","yes");'),
    write,
    script(
      "next",
      'pm.test("SET scalar",()=>pm.expect(pm.environment.get("native_value")).to.equal("OK"));pm.environment.set("owner_script_finished","yes");' +
        (phase === "before"
          ? 'apt.setRequestHeader("x-native-value",pm.environment.get("native_value"));'
          : ""),
    ),
  ];
  const imported = await api(base + "/import", { document });
  assert.equal(imported.status, 200, JSON.stringify(imported));
  const saved = imported.data;
  const granted = await api(base + "/database-connections", {
    name: "Explicit runtime target",
    type: "redis",
    host: "127.0.0.1",
    port: redis.address().port,
    database: "2",
    password: "private-runtime-password",
    bindingId: saved.settings.apipostDatabases[0].id,
  });
  assert.equal(granted.status, 200, JSON.stringify(granted));
  const owner = (action, data, options) =>
    api(base + "/native-write/" + action, data, options);
  async function prepare() {
    const result = await owner("prepare", { requestId: saved.requests[0].id });
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.data;
  }
  async function authorize(prepared) {
    const result = await owner("authorize", {
      preparationId: prepared.preparationId,
      digest: prepared.digest,
      phase: prepared.review.phase,
      ordinal: prepared.review.ordinal,
      acknowledgeReplacement: true,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    return { preparationId: prepared.preparationId, token: result.data.token };
  }
  return {
    app,
    api,
    base,
    saved,
    grant: granted.data,
    owner,
    prepare,
    authorize,
    commands,
    requests,
    sockets,
    setReached,
    stageReached,
    release: () => release(),
  };
}
function receipt(result, outcome) {
  assert.equal(result.writeReceipts.length, 1, JSON.stringify(result));
  assert.equal(result.writeReceipts[0].outcome, outcome);
  return result.writeReceipts[0];
}
async function terminal(f, preparationId) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const result = await f.owner("status", { preparationId });
    assert.equal(result.status, 200, JSON.stringify(result));
    if (result.data.state === "completed") return result.data;
    await delay(20);
  }
  assert.fail("owner terminal receipt was not retained");
}
for (const phase of ["before", "after"]) {
  test(
    `native owner ${phase}: import, explicit one-use authorization, ordered SET, saved receipt and replay denial`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, { phase });
      const denied = await f.api(f.base + "/execute", {
        request: f.saved.requests[0],
      });
      assert.equal(denied.status, 400);
      assert.equal(f.commands.length, 0);
      assert.equal(f.requests.length, 0);
      assert.equal(
        (await f.app.store.get(f.saved.id)).environments[0].variables
          .owner_script_started,
        undefined,
      );
      const prepared = await f.prepare();
      assert.equal(prepared.review.phase, phase);
      assert.equal(prepared.review.ordinal, 1);
      assert.equal(
        JSON.stringify(prepared).includes("private-runtime-password"),
        false,
      );
      assert.match(prepared.review.warning, /TTL/);
      const grant = await f.authorize(prepared);
      assert.equal(
        f.commands.length,
        0,
        "preparation and authorization perform no database connection",
      );
      assert.equal(f.requests.length, 0);
      const result = await f.owner("execute", grant);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.data.status, "passed", JSON.stringify(result));
      const written = receipt(result.data, "acknowledged-applied");
      assert.equal(written.phase, phase);
      assert.equal(result.data.recordSaved, true);
      assert.deepEqual(
        f.commands.map((command) => command[0]),
        ["AUTH", "SELECT", "SET"],
      );
      assert.deepEqual(f.commands.at(-1), [
        "SET",
        "fictional:key",
        "fictional-value",
      ]);
      assert.equal(f.requests.length, 1);
      if (phase === "before") assert.equal(f.requests[0].value, "OK");
      const current = await f.app.store.get(f.saved.id);
      assert.equal(current.environments[0].variables.native_value, "OK");
      assert.equal(
        current.environments[0].variables.owner_script_finished,
        "yes",
      );
      assert.deepEqual(
        current.history.find(
          (entry) => entry.id === result.data.attemptedRecordId,
        ).writeReceipts,
        result.data.writeReceipts,
      );
      assert.equal(JSON.stringify(current).includes(grant.token), false);
      assert.equal(
        JSON.stringify(current).includes("private-runtime-password"),
        false,
      );
      assert.equal((await f.owner("execute", grant)).status, 400);
      assert.equal(
        f.commands.filter((command) => command[0] === "SET").length,
        1,
      );
      assert.deepEqual(
        (await terminal(f, prepared.preparationId)).writeReceipts,
        result.data.writeReceipts,
      );
    },
  );
}

test(
  "native owner source edit rejects previously authorized admission with zero effects",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      prepared = await f.prepare(),
      grant = await f.authorize(prepared);
    const current = await f.app.store.get(f.saved.id);
    current.settings.apipostDatabases[0].name = "changed source definition";
    await f.app.store.save(current);
    assert.equal((await f.owner("execute", grant)).status, 400);
    assert.equal(f.commands.length, 0);
    assert.equal(f.requests.length, 0);
  },
);

test(
  "native owner rejects wrong owner/project, missing acknowledgement and revoked target without side effects",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      prepared = await f.prepare();
    assert.equal(
      (
        await f.owner(
          "status",
          { preparationId: prepared.preparationId },
          { token: "wrong-owner" },
        )
      ).status,
      403,
    );
    const other = await f.app.store.create("Other owner project");
    assert.equal(
      (
        await f.api(`/api/projects/${other.id}/native-write/status`, {
          preparationId: prepared.preparationId,
        })
      ).status,
      400,
    );
    const denied = await f.owner("authorize", {
      preparationId: prepared.preparationId,
      digest: prepared.digest,
      phase: prepared.review.phase,
      ordinal: prepared.review.ordinal,
      acknowledgeReplacement: false,
    });
    assert.equal(denied.status, 400);
    const grant = await f.authorize(prepared);
    assert.equal(
      (await f.api(`/api/projects/${other.id}/native-write/execute`, grant))
        .status,
      400,
    );
    assert.equal(
      (
        await f.api(
          f.base + "/database-connections",
          { id: f.grant.id },
          { method: "DELETE" },
        )
      ).status,
      200,
    );
    assert.equal((await f.owner("execute", grant)).status, 400);
    assert.equal(f.commands.length, 0);
    assert.equal(f.requests.length, 0);
  },
);

test(
  "native owner post-SET revoke preserves late ACK and stops subsequent script/HTTP effects",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { hold: true }),
      prepared = await f.prepare(),
      grant = await f.authorize(prepared);
    const pending = f.owner("execute", grant);
    await f.setReached;
    const revoked = await f.owner("revoke", {
      preparationId: prepared.preparationId,
    });
    assert.equal(revoked.status, 200);
    f.release();
    const result = await pending;
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.data.status, "cancelled");
    receipt(result.data, "acknowledged-applied");
    assert.equal(f.requests.length, 0);
    assert.equal(
      f.commands.filter((command) => command[0] === "SET").length,
      1,
    );
    assert.equal(
      (await f.app.store.get(f.saved.id)).environments[0].variables
        .owner_script_finished,
      undefined,
    );
    assert.deepEqual(
      (await terminal(f, prepared.preparationId)).writeReceipts,
      result.data.writeReceipts,
    );
  },
);

test(
  "native owner response disconnect plus failed history save retains owner-queryable ACK without reading project",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { hold: true }),
      prepared = await f.prepare(),
      grant = await f.authorize(prepared);
    const append = f.app.store.append;
    f.app.store.append = async () => {
      throw Error("fictional private disk failure");
    };
    t.after(() => {
      f.app.store.append = append;
    });
    const serverDisconnected = new Promise((resolve) => {
      const observer = (req, res) => {
        if (req.url !== f.base + "/native-write/execute") return;
        f.app.server.removeListener("request", observer);
        res.once("close", resolve);
      };
      f.app.server.on("request", observer);
      t.after(() => f.app.server.removeListener("request", observer));
    });
    const request = http.request(f.app.url + f.base + "/native-write/execute", {
      method: "POST",
      headers: {
        "x-local-token": f.app.token,
        "content-type": "application/json",
      },
    });
    request.on("error", () => {});
    t.after(() => request.destroy());
    request.end(JSON.stringify(grant));
    await f.setReached;
    const closed = new Promise((resolve) => request.once("close", resolve));
    request.destroy();
    await closed;
    await serverDisconnected;
    f.release();
    const result = await terminal(f, prepared.preparationId);
    receipt(result, "acknowledged-applied");
    assert.equal(result.recordSaved, false);
    assert.equal(result.persistenceOutcome.retry_safe, false);
    assert.equal(result.attemptedRecordId, result.runId);
    assert.equal(f.requests.length, 0);
    const get = f.app.store.get;
    f.app.store.get = async () => {
      throw Error("project cannot currently be read");
    };
    try {
      const status = await f.owner("status", {
        preparationId: prepared.preparationId,
      });
      assert.equal(status.status, 200);
      assert.deepEqual(status.data.writeReceipts, result.writeReceipts);
      assert.equal(
        JSON.stringify(status.data).includes("fictional-value"),
        false,
      );
      assert.equal(JSON.stringify(status.data).includes("private"), false);
    } finally {
      f.app.store.get = get;
    }
    assert.equal(
      f.commands.filter((command) => command[0] === "SET").length,
      1,
    );
  },
);

test(
  "native owner unacknowledged dispatched SET stays unknown and cannot replay",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { reply: null }),
      prepared = await f.prepare(),
      grant = await f.authorize(prepared);
    const result = await f.owner("execute", grant);
    assert.equal(result.status, 200, JSON.stringify(result));
    receipt(result.data, "unknown");
    assert.equal(result.data.status, "failed");
    assert.equal(f.requests.length, 0);
    assert.equal((await f.owner("execute", grant)).status, 400);
    assert.equal(
      f.commands.filter((command) => command[0] === "SET").length,
      1,
    );
  },
);

test(
  "native owner restored static intent and completed receipt never restore authority",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      prepared = await f.prepare(),
      grant = await f.authorize(prepared);
    const executed = await f.owner("execute", grant);
    assert.equal(executed.status, 200);
    receipt(executed.data, "acknowledged-applied");
    const backup = await f.app.store.get(f.saved.id);
    const restored = await f.api("/api/restore", { document: backup });
    assert.equal(restored.status, 201, JSON.stringify(restored));
    assert.notEqual(restored.data.id, f.saved.id);
    assert.deepEqual(
      restored.data.history[0].writeReceipts,
      executed.data.writeReceipts,
    );
    assert.deepEqual(
      restored.data.requests[0].nativeTasks.before.find(
        (task) => task.type === "database",
      ).data.query,
      '["SET","fictional:key","fictional-value"]',
    );
    const base = `/api/projects/${restored.data.id}`;
    assert.equal(
      (await f.api(base + "/execute", { request: restored.data.requests[0] }))
        .status,
      400,
    );
    assert.equal(
      (await f.api(base + "/native-write/execute", grant)).status,
      400,
    );
    assert.equal(
      (
        await f.api(base + "/native-write/prepare", {
          requestId: restored.data.requests[0].id,
        })
      ).status,
      400,
    );
    assert.equal(
      f.commands.filter((command) => command[0] === "SET").length,
      1,
    );
    assert.equal(f.requests.length, 1);
  },
);

test(
  "native owner write intent fails whole-plan preflight for legacy run/load and ordinary MCP execution permission",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const current = await f.app.store.get(f.saved.id);
    current.plans = [
      snapshotPlan({
        id: "write-plan",
        name: "No capability",
        steps: [
          { request: { name: "must not run", url: f.saved.requests[0].url } },
          { request: f.saved.requests[0] },
        ],
      }),
    ];
    await f.app.store.save(current);
    assert.equal(
      (await f.api(f.base + "/run", { planId: "write-plan" })).status,
      400,
    );
    assert.equal(
      (
        await f.api(f.base + "/load", {
          request: f.saved.requests[0],
          count: 1,
          concurrency: 1,
        })
      ).status,
      400,
    );
    const config = await f.api("/api/mcp/config", {
      enabled: true,
      projects: [f.saved.id],
      write: true,
      execute: true,
      remember: false,
    });
    assert.equal(config.status, 200);
    const client = new Client(
      { name: "native-write-denied", version: "1.0.0" },
      { capabilities: {} },
    );
    t.after(async () => {
      await client.close().catch(() => {});
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer " + config.data.token },
        },
      }),
    );
    const result = await client.callTool({
      name: "localapi_run_plan",
      arguments: { projectId: f.saved.id, planId: "write-plan" },
    });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "localapi_execute_api",
      ),
    );
    const single = await client.callTool({
      name: "localapi_execute_api",
      arguments: { projectId: f.saved.id, apiId: f.saved.requests[0].id },
    });
    assert.equal(single.isError, true, JSON.stringify(single));
    assert.equal(f.commands.length, 0);
    assert.equal(
      f.requests.length,
      0,
      "earlier ordinary request must not run before later forbidden write",
    );
    assert.equal(
      (await f.app.store.get(f.saved.id)).environments[0].variables
        .owner_script_started,
      undefined,
    );
  },
);

for (const position of ["before-set", "after-ack"]) {
  test(
    `native owner ${position} script exception preserves truthful receipt and rejects partial phase scopes`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t);
      const project = await f.app.store.get(f.saved.id);
      const tasks = project.requests[0].nativeTasks.before;
      tasks[position === "before-set" ? 0 : 2].data =
        'pm.environment.set("uncommitted_scope","must-not-save");throw Error("fictional script failure");';
      await f.app.store.save(project);
      const prepared = await f.prepare(),
        grant = await f.authorize(prepared);
      const result = await f.owner("execute", grant);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.data.status, "failed");
      receipt(
        result.data,
        position === "before-set" ? "not-sent" : "acknowledged-applied",
      );
      assert.equal(
        f.commands.filter((command) => command[0] === "SET").length,
        position === "before-set" ? 0 : 1,
      );
      if (position === "before-set") assert.equal(f.commands.length, 0);
      assert.equal(f.requests.length, 0);
      const current = await f.app.store.get(f.saved.id);
      assert.equal(
        current.environments[0].variables.uncommitted_scope,
        undefined,
      );
      assert.equal(
        current.environments[0].variables.owner_script_started,
        undefined,
      );
      assert.equal(current.environments[0].variables.native_value, undefined);
      assert.deepEqual(
        (await terminal(f, prepared.preparationId)).writeReceipts,
        result.data.writeReceipts,
      );
      assert.equal((await f.owner("execute", grant)).status, 400);
    },
  );
}

for (const phase of ["before", "after"]) {
  test(
    `native owner ${phase} assertion failure after ACK keeps mutation facts and existing phase semantics`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, { phase });
      const project = await f.app.store.get(f.saved.id);
      project.requests[0].nativeTasks[phase][2].data =
        'pm.environment.set("assertion_scope","value");pm.test("fictional failed assertion",()=>pm.expect(1).to.equal(2));';
      await f.app.store.save(project);
      const prepared = await f.prepare(),
        grant = await f.authorize(prepared);
      const result = await f.owner("execute", grant);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.data.status, "failed");
      receipt(result.data, "acknowledged-applied");
      assert.equal(
        result.data.assertions.some((assertion) => !assertion.passed),
        true,
      );
      // Existing before assertions stop HTTP and reject the phase scope, whereas
      // after assertions run after HTTP and retain the completed after scope.
      assert.equal(f.requests.length, phase === "before" ? 0 : 1);
      const current = await f.app.store.get(f.saved.id);
      assert.equal(
        current.environments[0].variables.assertion_scope,
        phase === "before" ? undefined : "value",
      );
      assert.equal(
        current.environments[0].variables.native_value,
        phase === "before" ? undefined : "OK",
      );
      assert.deepEqual(
        (await terminal(f, prepared.preparationId)).writeReceipts,
        result.data.writeReceipts,
      );
      assert.equal(
        f.commands.filter((command) => command[0] === "SET").length,
        1,
      );
    },
  );
}

test(
  "native owner deleting its database session after SET retains late ACK and stops subsequent effects",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { hold: true }),
      prepared = await f.prepare(),
      grant = await f.authorize(prepared);
    const pending = f.owner("execute", grant);
    await f.setReached;
    const revoked = await f.api(
      f.base + "/database-connections",
      { id: f.grant.id },
      { method: "DELETE" },
    );
    assert.equal(revoked.status, 200);
    f.release();
    const result = await pending;
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.data.status, "cancelled");
    receipt(result.data, "acknowledged-applied");
    assert.equal(f.requests.length, 0);
    assert.equal(
      (await f.app.store.get(f.saved.id)).environments[0].variables
        .owner_script_finished,
      undefined,
    );
    assert.deepEqual(
      (await terminal(f, prepared.preparationId)).writeReceipts,
      result.data.writeReceipts,
    );
    assert.equal((await f.owner("execute", grant)).status, 400);
    assert.equal(
      f.commands.filter((command) => command[0] === "SET").length,
      1,
    );
  },
);

test(
  "native owner caller disconnect during real source admission before first step retains not-sent cache receipt",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      prepared = await f.prepare(),
      grant = await f.authorize(prepared);
    const originalGet = f.app.store.get;
    let unblock,
      admissionStarted,
      armed = true;
    const barrier = new Promise((resolve) => {
      unblock = resolve;
    });
    const admittedRead = new Promise((resolve) => {
      admissionStarted = resolve;
    });
    // Scheduling gate around the real disk-backed read, not a fake project,
    // database driver or successful execution. No plan step may begin yet.
    f.app.store.get = async function (...args) {
      const result = await originalGet.apply(this, args);
      if (armed && args[0] === f.saved.id) {
        armed = false;
        admissionStarted();
        await barrier;
      }
      return result;
    };
    const serverDisconnected = new Promise((resolve) => {
      const observer = (req, res) => {
        if (req.url !== f.base + "/native-write/execute") return;
        f.app.server.removeListener("request", observer);
        res.once("close", resolve);
      };
      f.app.server.on("request", observer);
      t.after(() => f.app.server.removeListener("request", observer));
    });
    const request = http.request(f.app.url + f.base + "/native-write/execute", {
      method: "POST",
      headers: {
        "x-local-token": f.app.token,
        "content-type": "application/json",
      },
    });
    request.on("error", () => {});
    t.after(() => request.destroy());
    try {
      request.end(JSON.stringify(grant));
      await admittedRead;
      request.destroy();
      await serverDisconnected;
      assert.equal(f.commands.length, 0);
      assert.equal(f.requests.length, 0);
      unblock();
      const result = await terminal(f, prepared.preparationId);
      receipt(result, "not-sent");
      assert.equal(result.status, "cancelled");
      assert.equal(result.writeReceipts[0].reason, "cancelled");
      assert.equal(f.commands.length, 0);
      assert.equal(f.requests.length, 0);
      const current = await originalGet.call(f.app.store, f.saved.id);
      assert.equal(
        current.environments[0].variables.owner_script_started,
        undefined,
      );
      assert.equal((await f.owner("execute", grant)).status, 400);
    } finally {
      unblock();
      f.app.store.get = originalGet;
    }
  },
);

for (const stage of ["AUTH", "SELECT"]) {
  test(
    `native owner revoke during blocked ${stage} prohibits SET and retains not-sent receipt`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, { holdStage: stage }),
        prepared = await f.prepare(),
        grant = await f.authorize(prepared);
      const pending = f.owner("execute", grant);
      await f.stageReached;
      assert.equal(
        (await f.owner("revoke", { preparationId: prepared.preparationId }))
          .status,
        200,
      );
      const result = await pending;
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.data.status, "cancelled");
      receipt(result.data, "not-sent");
      assert.deepEqual(
        f.commands.map((command) => command[0]),
        stage === "AUTH" ? ["AUTH"] : ["AUTH", "SELECT"],
      );
      assert.equal(f.requests.length, 0);
      assert.deepEqual(
        (await terminal(f, prepared.preparationId)).writeReceipts,
        result.data.writeReceipts,
      );
      assert.equal((await f.owner("execute", grant)).status, 400);
    },
  );
}

test(
  "native owner host close drains already dispatched SET ACK and saves evidence without claiming a live status endpoint",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { hold: true }),
      prepared = await f.prepare(),
      grant = await f.authorize(prepared);
    const pending = f.owner("execute", grant);
    await f.setReached;
    let closed = false;
    const closing = new Promise((resolve) =>
      f.app.server.close(() => {
        closed = true;
        resolve();
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      closed,
      false,
      "server shutdown still owns the pending response and mutation",
    );
    assert.equal(f.requests.length, 0);
    f.release();
    const result = await pending;
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.data.status, "cancelled");
    receipt(result.data, "acknowledged-applied");
    assert.equal(result.data.recordSaved, true);
    await closing;
    assert.equal(closed, true);
    assert.equal(f.app.server.listening, false);
    const stored = await f.app.store.get(f.saved.id);
    const history = stored.history.find(
      (entry) => entry.id === result.data.attemptedRecordId,
    );
    assert.deepEqual(history.writeReceipts, result.data.writeReceipts);
    assert.equal(history.status, "cancelled");
    assert.equal(
      stored.environments[0].variables.owner_script_finished,
      undefined,
    );
    assert.equal(f.requests.length, 0);
    assert.equal(
      f.commands.filter((command) => command[0] === "SET").length,
      1,
    );
    // No status request is made after shutdown: only confirmed disk history is
    // evidence here, not a promise that in-memory cache survives process exit.
  },
);
