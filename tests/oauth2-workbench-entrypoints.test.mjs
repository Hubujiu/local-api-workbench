// Combined workbench acceptance, not another OAuth protocol-mode matrix. All
// credentials and services are fictional loopback fixtures. Token exchange is an
// owner HTTP operation; MCP only executes an explicitly saved OAuth2 definition.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";

const clientId = " fixture:client +%中&=~!*()' ";
const clientSecret = " fixture:secret +%文&=~!*()' ";
const accessToken = "fictional-workbench-access";
// Independent RFC form encoding, not the implementation's URLSearchParams path.
const formEncode = (value) =>
  encodeURIComponent(value)
    .replace(
      /[!'()~]/g,
      (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
    )
    .replace(/%20/g, "+");
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const names = async (client) =>
  (await client.listTools()).tools.map((tool) => tool.name).sort();
const tool = (client, name, args) => client.callTool({ name, arguments: args });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "oauth2-entrypoints-"));
  const exchanges = [],
    resources = [],
    errors = [],
    clients = [];
  const peer = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/token" || req.url === "/wrong-type") {
        const fields = new URLSearchParams(body);
        exchanges.push({
          url: req.url,
          authorization: req.headers.authorization,
          fields: [...fields],
        });
        assert.equal(req.method, "POST");
        assert.equal(
          req.headers.authorization,
          "Basic " +
            Buffer.from(
              formEncode(clientId) + ":" + formEncode(clientSecret),
            ).toString("base64"),
        );
        assert.deepEqual(
          [...fields],
          [
            ["grant_type", "client_credentials"],
            ["scope", "resource:read"],
          ],
        );
        assert(!fields.has("client_id"));
        assert(!fields.has("client_secret"));
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            access_token:
              req.url === "/token"
                ? accessToken
                : "wrong-scheme-token-must-not-save",
            token_type: req.url === "/token" ? "Bearer" : "DPoP",
            refresh_token: "fictional-transient-refresh",
            expires_in: 60,
          }),
        );
        return;
      }
      resources.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.authorization,
        tenant: req.headers["x-tenant"],
        body,
      });
      assert.equal(req.url, "/resource");
      assert.equal(req.headers.authorization, "Bearer " + accessToken);
      assert.equal(req.headers["x-tenant"], "selected-environment");
      res.writeHead(200, {
        "content-type": "application/json",
        "x-fixture": "bearer-confirmed",
      });
      res.end('{"authorized":true}');
    } catch (error) {
      errors.push(error);
      res.writeHead(500);
      res.end("fixture validation failed");
    }
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    for (const client of clients.splice(0))
      await client.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await stop();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const call = async (route, body, method = "POST") => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  return {
    root,
    exchanges,
    resources,
    call,
    base: `http://127.0.0.1:${peer.address().port}`,
    get store() {
      return app.store;
    },
    get url() {
      return app.url;
    },
    async connect(projectId, { write = false, execute = false } = {}) {
      const configured = await call("/api/mcp/config", {
        enabled: true,
        projects: [projectId],
        write,
        execute,
        remember: false,
      });
      assert.equal(configured.status, 200);
      const client = new Client(
        { name: "oauth2-workbench-acceptance", version: "1" },
        { capabilities: {} },
      );
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: {
            headers: { Authorization: "Bearer " + configured.value.token },
          },
        }),
      );
      return { client, token: configured.value.token };
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
  };
}

function cli(root, projectId, planId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        projectId,
        "--plan",
        planId,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = setTimeout(() => {
      failure = Error("OAuth entrypoint CLI fixture timed out");
      child.kill();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        failure = Error("CLI fixture output exceeds bound");
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      failure ? reject(failure) : resolve({ code, signal, stdout, stderr });
    });
  });
}

// Obstruct only this fixture's activity apply, after the original locked read.
// Real save/journal/apply/error classification run; no fake Store errors/results.
function obstructActivity(t, store, projectId) {
  const originalSave = store.save,
    originalRead = store.readUnlocked;
  const directory = store.directory(projectId),
    history = path.join(directory, "history"),
    kept = path.join(directory, "history-kept");
  let attempts = 0,
    failure,
    armed = true;
  store.save = async function (value, options) {
    if (value.id !== projectId || !options?.activity)
      return originalSave.call(this, value, options);
    attempts++;
    if (armed) {
      armed = false;
      this.readUnlocked = async function (id) {
        const state = await originalRead.call(this, id);
        this.readUnlocked = originalRead;
        await rename(history, kept);
        await writeFile(history, "owned fixture obstacle");
        return state;
      };
    }
    try {
      return await originalSave.call(this, value, options);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.readUnlocked = originalRead;
    }
  };
  const restore = () => {
    store.save = originalSave;
    store.readUnlocked = originalRead;
  };
  t.after(restore);
  return {
    attempts: () => attempts,
    failure: () => failure,
    journalFile: path.join(directory, ".transaction.json"),
    async repair() {
      restore();
      await rm(history);
      await rename(kept, history);
    },
  };
}

test(
  "owner OAuth2 exchange becomes an explicitly saved frozen Bearer workflow across SDK, CLI, restore and uncertain record save",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const project = await f.store.create("Explicit OAuth2 owner save"),
      other = await f.store.create("Separate project");
    project.environments[0].variables.tenant = "selected-environment";
    project.environments.push({
      id: "other-environment",
      name: "Never selected",
      variables: { tenant: "other-environment", token: "unrelated-env-token" },
    });
    await f.store.save(project);
    const before = await f.store.get(project.id),
      otherBefore = await f.store.get(other.id);
    const oauthConfig = {
      tokenEndpoint: f.base + "/token",
      clientAuthentication: "basic",
      clientId,
      clientSecret,
      grantType: "client_credentials",
      scope: "resource:read",
    };
    const read = await f.connect(project.id),
      readTools = await names(read.client);
    assert(
      !readTools.some((name) => /oauth/i.test(name)),
      "OAuth exchange must not become an MCP tool",
    );
    assert(!readTools.includes("apipost_execute_api"));
    const ownerOnly = await fetch(f.url + "/api/oauth/token", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + read.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(oauthConfig),
    });
    assert.equal(ownerOnly.status, 403);
    assert.equal(
      (await tool(read.client, "localapi_oauth_token", oauthConfig)).isError,
      true,
    );
    assert.equal(f.exchanges.length, 0);
    const exchanged = await f.call("/api/oauth/token", oauthConfig);
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged));
    assert.equal(exchanged.value.accessToken, accessToken);
    assert.equal(exchanged.value.tokenType, "Bearer");
    assert.deepEqual(
      await f.store.get(project.id),
      before,
      "token exchange alone cannot save credentials",
    );
    assert.deepEqual(await f.store.get(other.id), otherBefore);
    assert.deepEqual(await names(read.client), readTools);
    assert.deepEqual(f.resources, []);

    // The owner deliberately persists only the returned access token in a request.
    // Client secret/refresh token remain transient and are never passed to MCP/CLI.
    const explicit = await f.store.get(project.id);
    explicit.requests = [
      {
        id: "saved-oauth-api",
        name: "Saved OAuth2 resource",
        method: "POST",
        url: f.base + "/resource",
        bodyType: "json",
        body: '{"tenant":"{{tenant}}"}',
        headers: [{ key: "X-Tenant", value: "{{tenant}}", enabled: true }],
        auth: { type: "oauth2", token: exchanged.value.accessToken },
      },
    ];
    const savedResponse = await f.call(
      `/api/projects/${project.id}`,
      explicit,
      "PUT",
    );
    assert.equal(savedResponse.status, 200, JSON.stringify(savedResponse));
    const savedAuth = structuredClone(savedResponse.value.requests[0].auth);
    assert.equal(
      (
        await tool(read.client, "apipost_execute_api", {
          project_id: project.id,
          target_id: "saved-oauth-api",
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await tool(read.client, "localapi_save_plan", {
          projectId: project.id,
          plan: { name: "Denied", steps: [] },
        })
      ).isError,
      true,
    );
    const write = await f.connect(project.id, { write: true });
    const writeTools = await names(write.client);
    assert(writeTools.includes("apipost_create_execution_flow"));
    assert(!writeTools.includes("apipost_execute_flow"));
    const flow = decode(
      await tool(write.client, "apipost_create_execution_flow", {
        project_id: project.id,
        name: "Frozen saved OAuth2",
        environment_id: project.environments[0].id,
        steps: [{ target_id: "saved-oauth-api" }],
      }),
    );
    const planId = flow.flow_id;
    assert.equal(
      (
        await tool(write.client, "apipost_execute_flow", {
          project_id: project.id,
          flow_id: planId,
        })
      ).isError,
      true,
    );
    assert.deepEqual(f.resources, []);

    const beforeInvalidToken = await f.store.get(project.id);
    const wrong = await f.call("/api/oauth/token", {
      ...oauthConfig,
      tokenEndpoint: f.base + "/wrong-type",
    });
    assert.equal(wrong.status, 400);
    assert.match(wrong.value.error, /token type.*Bearer/);
    assert.equal(wrong.value.accessToken, undefined);
    assert(
      !JSON.stringify(wrong.value).includes("wrong-scheme-token-must-not-save"),
    );
    assert.deepEqual(await f.store.get(project.id), beforeInvalidToken);
    assert.deepEqual(
      (await f.store.get(project.id)).requests[0].auth,
      savedAuth,
    );
    assert.deepEqual(await f.store.get(other.id), otherBefore);
    assert.deepEqual(await names(write.client), writeTools);
    assert.deepEqual(
      f.resources,
      [],
      "a rejected token never triggers a resource request",
    );

    const execute = await f.connect(project.id, { write: true, execute: true });
    for (const name of ["apipost_execute_api", "localapi_execute_api"])
      assert.equal(
        (
          await tool(
            execute.client,
            name,
            name.startsWith("apipost")
              ? { project_id: other.id, target_id: "saved-oauth-api" }
              : { projectId: other.id, apiId: "saved-oauth-api" },
          )
        ).isError,
        true,
      );
    const apiRun = decode(
      await tool(execute.client, "apipost_execute_api", {
        project_id: project.id,
        target_id: "saved-oauth-api",
      }),
    );
    assert.equal(apiRun.status, "passed");
    assert.equal(apiRun.record_saved, true);
    assert.equal(apiRun.record_id, apiRun.attempted_record_id);
    const flowRun = decode(
      await tool(execute.client, "apipost_execute_flow", {
        project_id: project.id,
        flow_id: planId,
      }),
    );
    assert.equal(flowRun.status, "passed");
    assert.equal(flowRun.record_saved, true);
    assert.equal(f.resources.length, 2);
    const afterSDK = await f.store.get(project.id);
    assert.equal(afterSDK.history[0].response.body, '{"authorized":true}');
    assert.equal(
      afterSDK.runs[0].results[0].response.headers["x-fixture"],
      "bearer-confirmed",
    );
    assert.deepEqual(afterSDK.environments, before.environments);

    // Editing the live definition must not alter the already saved native flow.
    // This deliberately invalid live token is never executed by the flow/CLI.
    afterSDK.requests[0].auth.token = "edited-live-token-must-not-send";
    afterSDK.requests[0].url = f.base + "/edited-live-must-not-send";
    const liveEdit = await f.call(
      `/api/projects/${project.id}`,
      afterSDK,
      "PUT",
    );
    assert.equal(liveEdit.status, 200);
    const cliResult = await cli(f.root, project.id, planId);
    assert.equal(cliResult.code, 0, cliResult.stderr);
    assert.equal(cliResult.signal, null);
    const cliRun = JSON.parse(cliResult.stdout);
    assert.equal(cliRun.status, "passed");
    assert.equal(cliRun.recordSaved, true);
    assert.deepEqual(cliRun.snapshot.steps[0].request.auth, savedAuth);
    assert.equal(f.resources.length, 3);
    const backup = await f.call(
      `/api/projects/${project.id}/export`,
      undefined,
      "GET",
    );
    assert.equal(backup.status, 200);
    for (const transient of [
      clientId,
      clientSecret,
      "fictional-transient-refresh",
      "wrong-scheme-token-must-not-save",
    ])
      assert(!JSON.stringify(backup.value).includes(transient), transient);
    const originalSaved = await f.store.get(project.id);
    const restored = await f.call("/api/restore", { document: backup.value });
    assert.equal(restored.status, 201);
    assert.notEqual(restored.value.id, project.id);
    await f.restart();
    assert.equal(
      f.exchanges.length,
      2,
      "restore/restart must not exchange or refresh tokens",
    );
    assert.equal(f.resources.length, 3);
    assert.deepEqual(await new Store(f.root).get(project.id), originalSaved);
    const restoredRead = await f.connect(restored.value.id);
    assert(
      !(await names(restoredRead.client)).includes("apipost_execute_flow"),
    );
    assert.equal(
      (
        await tool(restoredRead.client, "apipost_execute_flow", {
          project_id: restored.value.id,
          flow_id: planId,
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await tool(restoredRead.client, "localapi_get_execution_flow", {
          projectId: project.id,
          planId,
        })
      ).isError,
      true,
    );
    const replay = await cli(f.root, restored.value.id, planId);
    assert.equal(replay.code, 0, replay.stderr);
    assert.deepEqual(
      JSON.parse(replay.stdout).snapshot.steps[0].request.auth,
      savedAuth,
    );
    assert.equal(f.resources.length, 4);
    assert.deepEqual(await f.store.get(project.id), originalSaved);
    assert.deepEqual(await f.store.get(other.id), otherBefore);

    // The completed Bearer HTTP is not replayable merely because recording fails.
    const restoredExecute = await f.connect(restored.value.id, {
      write: true,
      execute: true,
    });
    const beforeFault = await f.store.get(restored.value.id);
    const fault = obstructActivity(t, f.store, restored.value.id);
    const uncertain = decode(
      await tool(restoredExecute.client, "localapi_execute_flow", {
        projectId: restored.value.id,
        planId,
      }),
    );
    assert.equal(uncertain.status, "passed");
    assert.equal(uncertain.results[0].response.body, '{"authorized":true}');
    assert.equal(uncertain.recordSaved, false);
    assert.equal(uncertain.recordId, null);
    assert.equal(uncertain.attemptedRecordId, uncertain.id);
    assert.deepEqual(uncertain.persistenceOutcome, {
      code: "PROJECT_COMMIT_UNCERTAIN",
      project_id: restored.value.id,
      commit_outcome: "unknown",
      retry_safe: false,
    });
    assert(fault.failure() instanceof ProjectCommitUncertain);
    assert.equal(fault.attempts(), 1);
    assert.equal(f.resources.length, 5);
    const receipt = JSON.stringify({
      error: uncertain.persistenceError,
      outcome: uncertain.persistenceOutcome,
    });
    for (const hidden of [
      f.root,
      JSON.stringify(f.root).slice(1, -1),
      clientSecret,
      "ENOTDIR",
      '"cause"',
    ])
      assert(!receipt.includes(hidden));
    const journal = JSON.parse(await readFile(fault.journalFile, "utf8"));
    assert.equal(journal.runs[0].id, uncertain.attemptedRecordId);
    assert.deepEqual(journal.runs[0].results, uncertain.results);
    await fault.repair();
    const recovered = await new Store(f.root).get(restored.value.id);
    assert.equal(recovered.runs.length, beforeFault.runs.length + 1);
    assert.equal(recovered.runs[0].id, uncertain.attemptedRecordId);
    assert.deepEqual(recovered.runs[0].results, uncertain.results);
    assert.deepEqual(await new Store(f.root).get(restored.value.id), recovered);
    await assert.rejects(readFile(fault.journalFile), { code: "ENOENT" });
    assert.equal(fault.attempts(), 1);
    assert.equal(f.exchanges.length, 2);
    assert.equal(f.resources.length, 5);
    assert.deepEqual(await f.store.get(project.id), originalSaved);
    assert.deepEqual(await f.store.get(other.id), otherBefore);
    assert.deepEqual(recovered.environments, before.environments);
    assert.deepEqual(
      f.resources,
      Array.from({ length: 5 }, () => ({
        url: "/resource",
        method: "POST",
        authorization: "Bearer " + accessToken,
        tenant: "selected-environment",
        body: '{"tenant":"selected-environment"}',
      })),
    );
  },
);
