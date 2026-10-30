// Definition interchange and Workbench runtime only; no vendor runtime oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
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
      const handled = await handler(req, res);
      seen.push(req.url);
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
  const root = await mkdtemp(join(tmpdir(), "digest-policy-owner-"));
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

async function cliRun(f, projectId, planId) {
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

const formats = ["apipost", "apipost-directory"];
const algorithms = [
  "MD5",
  "MD5-sess",
  "SHA-256",
  "SHA-256-sess",
  "SHA-512-256",
  "SHA-512-256-sess",
];
const credentials = {
  username: "fixture-user",
  password: "fixture-private-password",
};
const entity = "exact raw \0 雪 \r\n";
const nativeDefinition = (algorithm, disableRetryRequest = false) => ({
  username: "{{digestUser}}",
  password: "{{digestPassword}}",
  realm: "",
  nonce: "",
  algorithm,
  qop: "",
  nc: "",
  cnonce: "",
  opaque: "",
  disableRetryRequest,
});
const canonical = (native) => ({
  type: "digest",
  username: native.username,
  password: native.password ?? "",
  challengePolicy: {
    algorithm: native.algorithm || "MD5",
    retry: !(native.disableRetryRequest ?? false),
  },
});
function nativeAuths(document, mutate) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "digest" && node.digest) mutate(node.digest);
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
function destination() {
  const challenges = new Map(),
    cnonces = new Set();
  let sequence = 0;
  return async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.deepEqual(bytes, Buffer.from(entity));
    const name = new URL(req.url, "http://fixture").pathname.slice(1);
    const algorithm = algorithms.includes(name) ? name : "SHA-256";
    if (!req.headers.authorization) {
      const nonce = "nonce-" + ++sequence;
      challenges.set(nonce, {
        url: req.url,
        body: bytes,
        contentType: req.headers["content-type"],
        length: req.headers["content-length"],
      });
      let challenge = `Digest realm="fixture", nonce="${nonce}", algorithm=${algorithm}, qop="auth-int"`;
      if (name === "disabled") challenge = "Digest malformed-private-challenge";
      if (name === "mismatch")
        challenge +=
          ', Digest realm="fixture", nonce="weaker", algorithm=MD5, qop="auth-int"';
      res.writeHead(401, { "WWW-Authenticate": challenge });
      res.end("challenge");
      return true;
    }
    assert(req.headers.authorization.startsWith("Digest "));
    const params = Object.fromEntries(
      [
        ...req.headers.authorization.matchAll(
          /([\w-]+)=(?:"([^"]*)"|([^,\s]+))/g,
        ),
      ].map((m) => [m[1], m[2] ?? m[3]]),
    );
    const first = challenges.get(params.nonce);
    assert(first);
    challenges.delete(params.nonce);
    assert.equal(first.url, req.url);
    assert.deepEqual(bytes, first.body);
    assert.equal(req.headers["content-type"], first.contentType);
    assert.equal(req.headers["content-length"], first.length);
    assert.equal(params.username, credentials.username);
    assert.equal(params.uri, req.url);
    assert.equal(params.qop, "auth-int");
    assert.equal(params.nc, "00000001");
    assert.equal(params.algorithm.toUpperCase(), algorithm.toUpperCase());
    assert(params.cnonce);
    assert(!cnonces.has(params.cnonce));
    cnonces.add(params.cnonce);
    const hash = (value) =>
      createHash(
        { MD5: "md5", "SHA-256": "sha256", "SHA-512-256": "sha512-256" }[
          algorithm.replace(/-sess$/i, "")
        ],
      )
        .update(value)
        .digest("hex");
    let identity = hash(
      credentials.username + ":fixture:" + credentials.password,
    );
    if (algorithm.endsWith("-sess"))
      identity = hash(identity + ":" + params.nonce + ":" + params.cnonce);
    const response = hash(
      [
        identity,
        params.nonce,
        params.nc,
        params.cnonce,
        "auth-int",
        hash(req.method + ":" + req.url + ":" + hash(bytes)),
      ].join(":"),
    );
    if (name === "bad") {
      assert.notEqual(params.response, response);
      res.writeHead(401, {
        "WWW-Authenticate":
          'Digest realm="fixture",nonce="no-third",algorithm=SHA-256,qop="auth-int"',
      });
      res.end("bad credentials");
      return true;
    }
    assert.equal(params.response, response);
    return false;
  };
}
async function seed(f, definitions) {
  const p = await f.app.store.create("Native Digest definitions");
  for (const env of p.environments)
    Object.assign(env.variables, {
      digestUser: credentials.username,
      digestPassword: credentials.password,
    });
  p.requests = definitions.map(([name, auth]) =>
    normalizeRequest({
      id: name,
      name,
      method: "POST",
      url: f.url + "/" + name,
      bodyType: "raw",
      body: entity,
      headers: [
        {
          key: "Content-Type",
          value: "text/plain; charset=utf-8",
          enabled: true,
        },
      ],
      auth,
      inheritAuth: false,
    }),
  );
  await f.call("/api/projects/" + p.id, "PUT", p);
  return f.app.store.get(p.id);
}
async function imported(f, document) {
  const p = await f.app.store.create("Native Digest imported");
  return f.call("/api/projects/" + p.id + "/import", "POST", { document });
}

test(
  "native Digest six auth-int/session algorithms independently roundtrip across both owner formats, frozen restore/reopen, SDK and CLI",
  { timeout: 60000 },
  async (t) => {
    const f = await owner(t, destination());
    const definitions = algorithms.map((a) => [
      a,
      canonical(nativeDefinition(a)),
    ]);
    const source = await seed(f, definitions),
      expected = authByName(source),
      sourceBefore = await f.app.store.get(source.id);
    const foreign = await seed(f, [
        ["MD5", canonical(nativeDefinition("MD5"))],
      ]),
      foreignBefore = await f.app.store.get(foreign.id);
    let last;
    for (const format of formats) {
      const count = f.seen.length;
      const doc = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
      );
      const replaced = new Set();
      nativeAuths(doc, (native) => {
        const a = native.algorithm;
        assert(algorithms.includes(a));
        assert(!replaced.has(a));
        const fixture = nativeDefinition(a);
        assert.deepEqual(native, fixture);
        replaced.add(a);
        for (const key of Object.keys(native)) delete native[key];
        Object.assign(native, fixture);
      });
      assert.equal(replaced.size, 6);
      const first = await imported(f, doc);
      assert.deepEqual(authByName(first), expected);
      const second = await imported(
        f,
        await f.call("/api/projects/" + first.id + "/export?format=" + format),
      );
      assert.deepEqual(authByName(second), expected);
      assert.equal(f.seen.length, count);
      await f.restart();
      assert.deepEqual(authByName(await f.app.store.get(second.id)), expected);
      const oas = await f.call(
        "/api/projects/" + second.id + "/export?format=openapi",
      );
      // Existing OpenAPI exporter has no Digest mechanism projection. Assert
      // same-auth public document secrecy without inventing a security scheme.
      const publicAuth = JSON.stringify(oas);
      for (const auth of Object.values(expected)) {
        assert(!publicAuth.includes(auth.username));
        assert(!publicAuth.includes(auth.password));
      }
      assert(!publicAuth.includes(credentials.password));
      const plan = await f.call(
        "/api/projects/" + second.id + "/plans",
        "POST",
        {
          name: "Frozen imported Digest",
          statusPolicy: "strict200",
          steps: second.requests.map((request) => ({ request })),
        },
      );
      const edited = await f.app.store.get(second.id);
      for (const request of edited.requests)
        request.auth.challengePolicy.retry = false;
      await f.call("/api/projects/" + second.id, "PUT", edited);
      const run = await f.call("/api/projects/" + second.id + "/run", "POST", {
        planId: plan.id,
      });
      assert.equal(
        run.status,
        "passed",
        JSON.stringify({ run, errors: f.errors }),
      );
      assert.equal(f.seen.length, count + 12);
      const backup = await f.call("/api/projects/" + second.id + "/export");
      const restored = await f.call(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      await f.restart();
      const disk = await f.app.store.get(restored.id);
      assert.deepEqual(
        disk.plans[0].steps.map((s) => s.request.auth),
        second.requests.map((r) => r.auth),
      );
      const rerun = await f.call("/api/projects/" + disk.id + "/run", "POST", {
        planId: disk.plans[0].id,
      });
      assert.equal(
        rerun.status,
        "passed",
        JSON.stringify({ rerun, errors: f.errors }),
      );
      assert.equal(f.seen.length, count + 24);
      const fresh = await f.app.store.get(disk.id);
      fresh.requests = fresh.plans[0].steps.map((s) => s.request);
      await f.call("/api/projects/" + fresh.id, "PUT", fresh);
      last = await f.app.store.get(fresh.id);
    }
    const config = await f.call("/api/mcp/config", "POST", {
      enabled: true,
      projects: [last.id],
      write: true,
      execute: true,
      remember: false,
    });
    const client = new Client(
      { name: "native-digest-owner", version: "1" },
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
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const [name, args] of [
      [
        "localapi_execute_api",
        { projectId: last.id, apiId: last.requests[0].id },
      ],
      [
        "apipost_execute_api",
        { project_id: last.id, target_id: last.requests[0].id },
      ],
    ]) {
      assert(tools.has(name));
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(JSON.parse(result.content[0].text).status, "passed");
    }
    const denied = await client.callTool({
      name: "localapi_execute_api",
      arguments: { projectId: foreign.id, apiId: foreign.requests[0].id },
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /项目未授权/);
    assert.equal(f.seen.length, 52);
    await client.close();
    await cliRun(f, last.id, last.plans[0].id);
    assert.equal(f.seen.length, 64);
    assert.deepEqual(
      authByName(await f.app.store.get(last.id)),
      expected,
      "response state never enters saved credentials",
    );
    assert.deepEqual(await f.app.store.get(source.id), sourceBefore);
    assert.deepEqual(await f.app.store.get(foreign.id), foreignBefore);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "native Digest defaults and retry-disable, mismatch no-downgrade, bad credentials obey 401-only bounded bootstrap",
  { timeout: 30000 },
  async (t) => {
    const f = await owner(t, destination());
    for (const format of formats) {
      const source = await seed(f, [
        ["MD5", canonical(nativeDefinition("MD5"))],
        ["disabled", canonical(nativeDefinition("SHA-256", true))],
        ["mismatch", canonical(nativeDefinition("MD5"))],
        [
          "bad",
          {
            ...canonical(nativeDefinition("SHA-256")),
            password: "wrong-password",
          },
        ],
      ]);
      const doc = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
      );
      let changed = false;
      nativeAuths(doc, (a) => {
        if (!changed && a.algorithm === "MD5") {
          delete a.algorithm;
          delete a.disableRetryRequest;
          for (const key of ["realm", "nonce", "qop", "nc", "cnonce", "opaque"])
            delete a[key];
          changed = true;
        }
      });
      assert(changed);
      const p = await imported(f, doc);
      assert.deepEqual(authByName(p), authByName(source));
      const start = f.seen.length;
      for (const [name, increment] of [
        ["MD5", 2],
        ["disabled", 1],
        ["mismatch", 1],
        ["bad", 2],
      ]) {
        const before = f.seen.length;
        const request = p.requests.find((r) => r.name === name);
        const result = await f.call(
          "/api/projects/" + p.id + "/execute",
          "POST",
          { request },
        );
        assert.equal(f.seen.length, before + increment);
        if (name === "MD5") assert.equal(result.outcome, "passed");
        else if (name === "mismatch") assert.equal(result.outcome, "failed");
        else assert.equal(result.status, 401);
      }
      assert.equal(f.seen.length, start + 6);
      assert.deepEqual(
        authByName(await f.app.store.get(p.id)),
        authByName(source),
      );
    }
    assert.deepEqual(f.errors, []);
  },
);

test(
  "native Digest nonempty prestate, unknown and ambiguous fields reject atomically; legacy automatic Workbench auth cannot be exported",
  { timeout: 30000 },
  async (t) => {
    const f = await owner(t, () => assert.fail("conversion cannot dispatch"));
    for (const format of formats) {
      const source = await seed(f, [
          ["MD5", canonical(nativeDefinition("MD5"))],
        ]),
        target = await f.app.store.create("Atomic Digest target"),
        before = await f.app.store.get(target.id);
      const good = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
      );
      for (const mutate of [
        ...["realm", "nonce", "qop", "nc", "cnonce", "opaque"].map(
          (key) => (a) => {
            a[key] = "private-prestate";
          },
        ),
        (a) => {
          a.privateUnknown = "private-value";
        },
        (a) => {
          a.algorithm = "{{algorithm}}";
        },
        (a) => {
          a.disableRetryRequest = "false";
        },
      ]) {
        const doc = structuredClone(good);
        nativeAuths(doc, mutate);
        const error = await f.call(
          "/api/projects/" + target.id + "/import",
          "POST",
          { document: doc },
          400,
        );
        const text = JSON.stringify(error);
        for (const privateValue of [
          "private-prestate",
          "privateUnknown",
          "private-value",
          "{{digestPassword}}",
        ])
          assert(!text.includes(privateValue));
        assert.deepEqual(await f.app.store.get(target.id), before);
      }
      for (const auth of [
        { type: "digest", ...credentials },
        {
          type: "digest",
          ...credentials,
          challengePolicy: { algorithm: "MD5", retry: true },
          algorithm: "MD5",
        },
      ]) {
        const edited = await f.app.store.get(source.id);
        edited.requests[0].auth = auth;
        await f.call("/api/projects/" + source.id, "PUT", edited);
        const snapshot = await f.app.store.get(source.id);
        const error = await f.call(
          "/api/projects/" + source.id + "/export?format=" + format,
          "GET",
          undefined,
          400,
        );
        assert(!JSON.stringify(error).includes(credentials.password));
        assert(!Object.hasOwn(error, "apis"));
        assert(!Object.hasOwn(error, "files"));
        assert.deepEqual(await f.app.store.get(source.id), snapshot);
      }
    }
    assert.deepEqual(f.seen, []);
    assert.deepEqual(f.errors, []);
  },
);
