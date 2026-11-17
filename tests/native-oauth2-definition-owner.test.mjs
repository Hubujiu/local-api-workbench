// Definition interchange and Workbench runtime only; no vendor runtime oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

async function owner(t, handler) {
  const errors = [],
    seen = [];
  const peer = http.createServer(async (req, res) => {
    try {
      seen.push(req.url);
      const handled = await handler(req, res);
      if (handled) return;
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    } catch (error) {
      errors.push(error.message);
      res.statusCode = 401;
      res.end("independent verification failed");
    }
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "native-oauth2-owner-"));
  let app = await createApp({ root, port: 0 });
  const cleanup = [];
  async function stop() {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  }
  t.after(async () => {
    // Child transports/processes must close before their server or data root.
    for (const close of cleanup.toReversed()) await close();
    await stop();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  async function call(route, method = "GET", data, status = 200) {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  return {
    get app() {
      return app;
    },
    root,
    cleanup: (close) => cleanup.push(close),
    call,
    seen,
    errors,
    url: "http://127.0.0.1:" + peer.address().port,
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
  };
}
const authByName = (project) =>
  Object.fromEntries(
    project.requests.map((request) => [request.name, request.auth]),
  );

function credentialEnvironment(project) {
  const selected = project.environments.find(
    (env) => env.variables?.oauthSecret === secret,
  );
  assert(
    selected,
    "explicit fixture credential environment must survive persistence",
  );
  return selected.id;
}
async function cliRun(f, projectId, planId, environmentId) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
      "--project",
      projectId,
      "--plan",
      planId,
      "--environment",
      environmentId,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, LOCAL_API_DATA: f.root },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let closed = false,
    output = "",
    errors = "",
    failure;
  // External fixture deadline only; never increases or retries product work.
  const timer = setTimeout(() => {
    failure = "CLI fixture deadline";
    child.kill("SIGKILL");
  }, 10000);
  const completion = new Promise((resolve) => {
    const collect = (field, chunk) => {
      if (field === "output") output += chunk;
      else errors += chunk;
      if (Buffer.byteLength(output) + Buffer.byteLength(errors) > 1024 * 1024) {
        failure = "CLI fixture output limit";
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk) => collect("output", chunk));
    child.stderr.on("data", (chunk) => collect("errors", chunk));
    child.once("error", (error) => {
      failure = error.message;
    });
    child.once("close", (code) => {
      closed = true;
      clearTimeout(timer);
      resolve({ code, output, errors, failure });
    });
  });
  f.cleanup(async () => {
    if (!closed) child.kill("SIGKILL");
    await completion; // actual child close precedes server close/root removal
  });
  const cli = await completion;
  assert.equal(cli.failure, undefined, cli.failure);
  assert.equal(cli.code, 0, cli.errors);
  assert.equal(JSON.parse(cli.output).status, "passed");
}

const secret = "native-oauth2-environment";
const entity = "body \0 雪\r\n";
const variables = {
  oauthSecret: secret,
  headerToken: "fixture-token",
  queryToken: "a+b%2f &雪#=",
  prefix: "Custom",
};
const metadata = {
  grant_type: "authorization_code",
  redirect_uri: "{{unused}}",
  authUrl: "{{unused}}",
  accessTokenUrl: "{{unused}}",
  clientId: "{{unused}}",
  clientSecret: "{{unused}}",
  username: "{{unused}}",
  password: "{{unused}}",
  challengeAlgorithm: "S256",
  code_verifier: "{{unused}}",
  scope: "{{unused}}",
  state: "{{$randomUUID}}",
  client_authentication: "header",
  refreshTokenUrl: "{{unused}}",
  authRequestParams: [
    { param_id: "keep", name: "{{unused}}", nested: ["{{$randomUUID}}"] },
  ],
  tokenRequestParams: [{ value: "{{unused}}" }],
  refreshRequestParams: [],
};
const native = (fields) => ({
  type: "oauth2",
  nativeOAuth2: { ...structuredClone(metadata), ...fields },
});
const profiles = [
  {
    name: "default",
    auth: native({
      addTokenTo: "header",
      access_token: "{{headerToken}}",
      headerPrefix: "",
    }),
    expected: "Bearer fixture-token",
  },
  {
    name: "custom",
    auth: native({
      addTokenTo: "header",
      access_token: "{{headerToken}}",
      headerPrefix: "{{prefix}}",
    }),
    expected: "Custom fixture-token",
  },
  {
    name: "query",
    auth: native({
      addTokenTo: "queryParams",
      access_token: "{{queryToken}}",
      headerPrefix: "{{unused}}",
    }),
    expected: "Caller unchanged",
  },
  {
    name: "empty",
    auth: native({
      addTokenTo: "header",
      access_token: "",
      headerPrefix: "{{unused}}",
    }),
    expected: "Caller unchanged",
  },
  {
    name: "inactive",
    auth: native({ access_token: "{{unused}}", headerPrefix: "{{unused}}" }),
    expected: "Caller unchanged",
  },
  {
    name: "sparse",
    auth: { type: "oauth2", nativeOAuth2: {} },
    expected: "Caller unchanged",
  },
];
async function fixture(t, { hold = false } = {}) {
  let arrive;
  const arrived = new Promise((resolve) => (arrive = resolve));
  const f = await owner(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks),
      url = new URL(req.url, "http://fixture"),
      name = url.pathname.slice(1);
    const bad = name === "bad",
      profile = profiles.find((p) => p.name === (bad ? "default" : name));
    assert(profile, "known peer path");
    assert.equal(req.method, "POST");
    assert.deepEqual(body, Buffer.from(entity));
    assert.equal(Number(req.headers["content-length"]), body.length);
    assert.equal(
      req.headers.authorization,
      bad ? "Bearer wrong" : profile.expected,
    );
    assert.equal(
      url.search,
      "?access_token=old&dup=1&dup=2&row=x+y" +
        (name === "query" ? "&access_token=a+b%2f%20%26%E9%9B%AA%23=" : ""),
    );
    if (bad) {
      res.writeHead(401);
      res.end("bad credentials");
      return true;
    }
    if (hold) {
      arrive();
      await new Promise((resolve) => res.once("close", resolve));
      return true;
    }
    return false;
  });
  return {
    ...f,
    get app() {
      return f.app;
    },
    arrived,
  };
}
async function seed(f) {
  const p = await f.app.store.create("Native OAuth2 policy");
  for (const env of p.environments) Object.assign(env.variables, variables);
  p.requests = profiles.map((profile) =>
    normalizeRequest({
      id: profile.name,
      name: profile.name,
      method: "POST",
      url: f.url + "/" + profile.name + "?access_token=old&dup=1&dup=2",
      query: [{ key: "row", value: "x y" }],
      headers: [
        { key: "Authorization", value: "Caller unchanged" },
        { key: "Content-Type", value: "text/plain; charset=utf-8" },
      ],
      bodyType: "raw",
      body: entity,
      auth: structuredClone(profile.auth),
      inheritAuth: false,
      scriptURLMode: "string",
    }),
  );
  await f.call("/api/projects/" + p.id, "PUT", p);
  return f.app.store.get(p.id);
}

const formats = ["apipost", "apipost-directory"];
async function imported(f, document) {
  const p = await f.app.store.create("Native OAuth2 imported");
  return f.call("/api/projects/" + p.id + "/import", "POST", { document });
}
function nativeAuths(document, mutate) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "oauth2" && node.oauth2) mutate(node.oauth2);
    for (const value of Object.values(node)) visit(value);
  };
  if (document.files)
    for (const file of document.files) {
      const data = JSON.parse(file.text);
      visit(data);
      file.text = JSON.stringify(data);
    }
  else visit(document);
}
test(
  "native OAuth2 two-format policy roundtrip verifies header/query token and inert metadata, frozen restore/reopen, canonical/native SDK and CLI",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      source = await seed(f),
      foreign = await seed(f),
      sourceBefore = await f.app.store.get(source.id),
      foreignBefore = await f.app.store.get(foreign.id),
      expected = authByName(source);
    let last;
    for (const format of formats) {
      const start = f.seen.length,
        document = await f.call(
          "/api/projects/" + source.id + "/export?format=" + format,
        ),
        unseen = profiles.map((s) => s.auth.nativeOAuth2);
      nativeAuths(document, (n) => {
        const at = unseen.findIndex(
          (value) => JSON.stringify(value) === JSON.stringify(n),
        );
        if (at < 0) {
          const same = unseen.findIndex((value) => {
            try {
              assert.deepEqual(n, value);
              return true;
            } catch {
              return false;
            }
          });
          assert(same >= 0);
          unseen.splice(same, 1);
        } else unseen.splice(at, 1);
      });
      assert.equal(unseen.length, 0);
      const first = await imported(f, document),
        second = await imported(
          f,
          await f.call(
            "/api/projects/" + first.id + "/export?format=" + format,
          ),
        );
      assert.deepEqual(authByName(first), expected);
      assert.deepEqual(authByName(second), expected);
      assert.equal(f.seen.length, start);
      await f.restart();
      assert.deepEqual(authByName(await f.app.store.get(second.id)), expected);
      const plan = await f.call(
        "/api/projects/" + second.id + "/plans",
        "POST",
        {
          name: "Frozen native OAuth2",
          environmentId: credentialEnvironment(second),
          statusPolicy: "strict200",
          steps: second.requests.map((request) => ({ request })),
        },
      );
      const frozen = structuredClone(plan.steps);
      assert.deepEqual(
        Object.fromEntries(
          plan.steps.map((step) => [step.request.name, step.request.auth]),
        ),
        expected,
      );
      const edited = await f.app.store.get(second.id);
      for (const request of edited.requests) {
        request.auth.nativeOAuth2.access_token = "later-live-token";
      }
      await f.call("/api/projects/" + edited.id, "PUT", edited);
      const run = await f.call("/api/projects/" + second.id + "/run", "POST", {
        planId: plan.id,
      });
      assert.equal(
        run.status,
        "passed",
        JSON.stringify({ run, errors: f.errors }),
      );
      assert.equal(run.recordSaved, true);
      assert.equal(f.seen.length, start + 6);
      const backup = await f.call("/api/projects/" + second.id + "/export"),
        restored = await f.call(
          "/api/restore",
          "POST",
          { document: backup },
          201,
        );
      await f.restart();
      let disk = await f.app.store.get(restored.id);
      assert.deepEqual(disk.plans[0].steps, frozen);
      const replay = await f.call("/api/projects/" + disk.id + "/run", "POST", {
        planId: disk.plans[0].id,
        environmentId: credentialEnvironment(disk),
      });
      assert.equal(
        replay.status,
        "passed",
        JSON.stringify({ replay, errors: f.errors }),
      );
      assert.equal(replay.recordSaved, true);
      assert.equal(f.seen.length, start + 12);
      disk = await f.app.store.get(disk.id);
      disk.requests = disk.plans[0].steps.map((step) => step.request);
      await f.call("/api/projects/" + disk.id, "PUT", disk);
      last = await f.app.store.get(disk.id);
    }
    const config = await f.call("/api/mcp/config", "POST", {
        enabled: true,
        projects: [last.id],
        write: true,
        execute: true,
        remember: false,
      }),
      client = new Client(
        { name: "native-oauth2-definition-owner", version: "1" },
        { capabilities: {} },
      );
    f.cleanup(async () => {
      await client.close().catch(() => {});
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    const tools = new Set(
      (await client.listTools()).tools.map((tool) => tool.name),
    );
    const mcpRecords = [];
    for (const [name, args] of [
      [
        "localapi_execute_api",
        {
          projectId: last.id,
          apiId: last.requests[0].id,
          environmentId: credentialEnvironment(last),
        },
      ],
      [
        "apipost_execute_api",
        {
          project_id: last.id,
          target_id: last.requests[1].id,
          environment_id: credentialEnvironment(last),
        },
      ],
    ]) {
      assert(tools.has(name), name);
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const output = JSON.parse(result.content[0].text);
      assert.equal(output.status, "passed");
      const native = name === "apipost_execute_api";
      assert.equal(native ? output.record_saved : output.recordSaved, true);
      mcpRecords.push(native ? output.run_id : output.id);
    }
    const denied = await client.callTool({
      name: "localapi_execute_api",
      arguments: { projectId: foreign.id, apiId: foreign.requests[0].id },
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /项目未授权/);
    assert.equal(f.seen.length, 26);
    await client.close();
    await cliRun(f, last.id, last.plans[0].id, credentialEnvironment(last));
    assert.equal(f.seen.length, 32);
    await f.restart();
    const final = await f.app.store.get(last.id);
    for (const id of mcpRecords) {
      const saved = final.history.find((entry) => entry.id === id);
      assert(saved);
      assert.equal(saved.source, "mcp");
      assert.equal(saved.status, "passed");
    }
    assert.equal(final.runs.length, 3);
    assert(final.runs.every((run) => run.status === "passed"));
    assert.deepEqual(authByName(final), expected);
    assert.deepEqual(await f.app.store.get(source.id), sourceBefore);
    assert.deepEqual(await f.app.store.get(foreign.id), foreignBefore);
    assert.deepEqual(f.errors, []);
  },
);
test(
  "native OAuth2 malformed switches/export state reject atomically and wrong credentials are never replayed",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      source = await seed(f);
    for (const format of formats) {
      const original = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
      );
      for (const mutate of [
        (n) => (n.addTokenTo = "{{placement}}"),
        (n) => (n.access_token = 1),
        (n) => (n.tokenRequestParams = {}),
        (n) => (n.unknown = "unknown"),
        (n) => (n.headerPrefix = false),
        (n) => (n.refresh_token = "private-native-token"),
      ]) {
        const document = structuredClone(original);
        nativeAuths(document, mutate);
        const target = await f.app.store.create("Reject native OAuth2"),
          before = await f.app.store.get(target.id),
          result = await f.call(
            "/api/projects/" + target.id + "/import",
            "POST",
            { document },
            400,
          );
        assert(!JSON.stringify(result).includes("private-native-token"));
        assert(!Object.hasOwn(result, "apis"));
        assert(!Object.hasOwn(result, "files"));
        assert.deepEqual(await f.app.store.get(target.id), before);
        assert.equal(f.seen.length, 0);
      }
      for (const mutate of [
        (a) => {
          delete a.nativeOAuth2;
          a.token = "private-legacy-token";
        },
        (a) => {
          delete a.nativeOAuth2;
          a.refreshToken = "private-legacy-token";
        },
      ]) {
        const p = await seed(f);
        mutate(p.requests[0].auth);
        await f.call("/api/projects/" + p.id, "PUT", p);
        const before = await f.app.store.get(p.id),
          result = await f.call(
            "/api/projects/" + p.id + "/export?format=" + format,
            "GET",
            undefined,
            400,
          );
        assert(!JSON.stringify(result).includes("private-legacy-token"));
        assert(!Object.hasOwn(result, "apis"));
        assert(!Object.hasOwn(result, "files"));
        assert.deepEqual(await f.app.store.get(p.id), before);
        assert.equal(f.seen.length, 0);
      }
    }
    const project = await imported(
        f,
        await f.call("/api/projects/" + source.id + "/export?format=apipost"),
      ),
      request = structuredClone(
        project.requests.find((r) => r.name === "default"),
      );
    // Imported query rows already hold the original pairs; change only path.
    request.url = f.url + "/bad";
    request.auth.nativeOAuth2.access_token = "wrong";
    const result = await f.call(
      "/api/projects/" + project.id + "/execute",
      "POST",
      { request, environmentId: credentialEnvironment(project) },
    );
    assert.equal(result.status, 401);
    assert.equal(f.seen.length, 1);
    assert.deepEqual(
      authByName(await f.app.store.get(project.id)),
      authByName(project),
    );
    assert.deepEqual(f.errors, []);
  },
);
test(
  "native OAuth2 imported policy cancellation persists one token request and stops later steps",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { hold: true }),
      source = await seed(f),
      project = await imported(
        f,
        await f.call(
          "/api/projects/" + source.id + "/export?format=apipost-directory",
        ),
      ),
      plan = await f.call("/api/projects/" + project.id + "/plans", "POST", {
        name: "Cancel native OAuth2",
        environmentId: credentialEnvironment(project),
        steps: project.requests.map((request) => ({ request })),
      });
    const pending = f.call("/api/projects/" + project.id + "/run", "POST", {
        planId: plan.id,
        runId: "native-oauth2-definition-cancel",
      }),
      early = await Promise.race([
        f.arrived.then(() => ({ arrived: true })),
        pending.then(
          (result) => ({ result }),
          (error) => ({ error: error.message }),
        ),
      ]);
    assert.equal(
      early.arrived,
      true,
      JSON.stringify({ early, errors: f.errors }),
    );
    await f.call("/api/cancel", "POST", {
      id: "native-oauth2-definition-cancel",
    });
    const run = await pending;
    assert.equal(run.status, "cancelled");
    assert.equal(run.recordSaved, true);
    assert.equal(f.seen.length, 1);
    assert.equal(run.results.length, 1);
    await f.restart();
    const saved = (await f.app.store.get(project.id)).runs.find(
      (item) => item.id === run.id,
    );
    assert(saved);
    assert.equal(saved.status, "cancelled");
    assert.equal(saved.results.length, 1);
    assert.deepEqual(f.errors, []);
  },
);
