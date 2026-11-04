// Definition interchange and Workbench runtime only; no vendor runtime oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHmac } from "node:crypto";
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
  const root = await mkdtemp(join(tmpdir(), "ntlm-native-owner-"));
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
  const environment = project.environments.find(
    (env) =>
      env.variables?.ntlmUser === credentials.username &&
      env.variables?.ntlmPassword === credentials.password,
  );
  assert(
    environment,
    "native import must retain the exact credential environment",
  );
  return environment.id;
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

const formats = ["apipost", "apipost-directory"];
const credentials = { username: "User", password: "Password" };
const entity = "native NTLM exact \0 雪\r\n";
const nativeDefinition = () => ({
  username: "{{ntlmUser}}",
  password: "{{ntlmPassword}}",
  domain: "Domain",
  workstation: "COMPUTER",
  disableRetryRequest: false,
});
const canonical = () => ({
  type: "ntlm",
  username: "{{ntlmUser}}",
  password: "{{ntlmPassword}}",
  domain: "Domain",
  workstation: "COMPUTER",
});
function nativeAuths(document, mutate) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "ntlm" && node.ntlm) mutate(node.ntlm);
    for (const value of Object.values(node)) visit(value);
  };
  if (document.files)
    for (const file of document.files) {
      const value = JSON.parse(file.text);
      visit(value);
      file.text = JSON.stringify(value);
    }
  else visit(document);
}
function destination() {
  const pending = new Map(),
    completed = new Set(),
    clientNonces = new Set();
  let sequence = 0;
  const targetInfo = Buffer.from(
    "02000c0044006f006d00610069006e0001000c0053006500720076006500720000000000",
    "hex",
  );
  // Independently published MS-NLMP User/Password/Domain response key vector,
  // not a call into a production signer or its identity/key helper.
  const key = Buffer.from("0c868a403bfd7a93a3001ef22ef02e3f", "hex");
  const hmac = (bytes) => createHmac("md5", key).update(bytes).digest();
  function field(token, at) {
    const len = token.readUInt16LE(at),
      max = token.readUInt16LE(at + 2),
      offset = token.readUInt32LE(at + 4);
    assert.equal(len, max);
    assert(offset + len <= token.length);
    return token.subarray(offset, offset + len);
  }
  return async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    assert.deepEqual(body, Buffer.from(entity));
    assert(req.headers.authorization?.startsWith("NTLM "));
    const token = Buffer.from(req.headers.authorization.slice(5), "base64");
    assert(token.subarray(0, 8).equals(Buffer.from("NTLMSSP\0")));
    const type = token.readUInt32LE(8);
    if (type === 1) {
      assert(!pending.has(req.socket));
      assert(
        !completed.has(req.socket),
        "each execution uses its own isolated connection",
      );
      assert.equal(field(token, 16).toString("ascii"), "DOMAIN");
      assert.equal(field(token, 24).toString("ascii"), "COMPUTER");
      const nonce = Buffer.alloc(8);
      nonce.writeUInt32LE(++sequence);
      pending.set(req.socket, {
        nonce,
        url: req.url,
        body,
        contentType: req.headers["content-type"],
        length: req.headers["content-length"],
      });
      const response = Buffer.alloc(48 + targetInfo.length);
      response.write("NTLMSSP\0");
      response.writeUInt32LE(2, 8);
      response.writeUInt32LE(req.url === "/downgrade" ? 0x201 : 0xa0888205, 20);
      nonce.copy(response, 24);
      response.writeUInt16LE(targetInfo.length, 40);
      response.writeUInt16LE(targetInfo.length, 42);
      response.writeUInt32LE(48, 44);
      targetInfo.copy(response, 48);
      res.writeHead(401, {
        "WWW-Authenticate": "NTLM " + response.toString("base64"),
        connection: "keep-alive",
      });
      res.end("challenge");
      return true;
    }
    assert.equal(type, 3);
    const first = pending.get(req.socket);
    assert(first, "Type3 must follow this socket's own Type1");
    pending.delete(req.socket);
    completed.add(req.socket);
    assert.equal(req.url, first.url);
    assert.deepEqual(body, first.body);
    assert.equal(req.headers["content-type"], first.contentType);
    assert.equal(req.headers["content-length"], first.length);
    assert.equal(field(token, 28).toString("utf16le"), "Domain");
    assert.equal(field(token, 36).toString("utf16le"), credentials.username);
    assert.equal(field(token, 44).toString("utf16le"), "COMPUTER");
    const nt = field(token, 20),
      blob = nt.subarray(16),
      proof = hmac(Buffer.concat([first.nonce, blob]));
    assert(blob.length >= 32);
    assert.equal(blob.readUInt32LE(0), 0x101);
    const clientNonce = blob.subarray(16, 24).toString("hex");
    assert(!clientNonces.has(clientNonce));
    clientNonces.add(clientNonce);
    assert.deepEqual(blob.subarray(28, 28 + targetInfo.length), targetInfo);
    if (req.url === "/bad") {
      assert(!proof.equals(nt.subarray(0, 16)));
      res.writeHead(401, { "WWW-Authenticate": "NTLM no-third-replay" });
      res.end("rejected");
      return true;
    }
    assert.deepEqual(nt.subarray(0, 16), proof);
    const lm = field(token, 12);
    assert.equal(lm.length, 24);
    assert.deepEqual(lm.subarray(16), blob.subarray(16, 24));
    assert.deepEqual(
      lm.subarray(0, 16),
      hmac(Buffer.concat([first.nonce, lm.subarray(16)])),
    );
    return false;
  };
}
async function seed(f) {
  const p = await f.app.store.create("Native NTLM credentials");
  for (const env of p.environments)
    Object.assign(env.variables, {
      ntlmUser: credentials.username,
      ntlmPassword: credentials.password,
    });
  p.requests = [
    normalizeRequest({
      id: "ntlm",
      name: "ntlm",
      method: "POST",
      url: f.url + "/ntlm",
      bodyType: "raw",
      body: entity,
      headers: [
        {
          key: "Content-Type",
          value: "text/plain; charset=utf-8",
          enabled: true,
        },
      ],
      auth: canonical(),
      inheritAuth: false,
    }),
  ];
  await f.call("/api/projects/" + p.id, "PUT", p);
  return f.app.store.get(p.id);
}
async function imported(f, document) {
  const p = await f.app.store.create("Native NTLM imported");
  return f.call("/api/projects/" + p.id + "/import", "POST", { document });
}
test(
  "native NTLM both owner formats preserve explicit credentials through independent same-socket wire proof, frozen restore/reopen, SDK and CLI",
  { timeout: 60000 },
  async (t) => {
    const f = await owner(t, destination()),
      source = await seed(f),
      foreign = await seed(f),
      sourceBefore = await f.app.store.get(source.id),
      foreignBefore = await f.app.store.get(foreign.id);
    let last;
    for (const format of formats) {
      const count = f.seen.length,
        doc = await f.call(
          "/api/projects/" + source.id + "/export?format=" + format,
        );
      let selected = 0;
      nativeAuths(doc, (value) => {
        assert.deepEqual(value, nativeDefinition());
        selected++;
      });
      assert.equal(selected, 1);
      const first = await imported(f, doc),
        second = await imported(
          f,
          await f.call(
            "/api/projects/" + first.id + "/export?format=" + format,
          ),
        );
      assert.deepEqual(authByName(first), { ntlm: canonical() });
      assert.deepEqual(authByName(second), { ntlm: canonical() });
      assert.equal(f.seen.length, count);
      await f.restart();
      assert.deepEqual(authByName(await f.app.store.get(second.id)), {
        ntlm: canonical(),
      });
      const plan = await f.call(
        "/api/projects/" + second.id + "/plans",
        "POST",
        {
          name: "Frozen native NTLM",
          environmentId: credentialEnvironment(second),
          statusPolicy: "strict200",
          steps: second.requests.map((request) => ({ request })),
        },
      );
      assert.deepEqual(plan.steps[0].request.auth, canonical());
      const live = await f.app.store.get(second.id);
      live.requests[0].auth.password = "later-live-password";
      await f.call("/api/projects/" + live.id, "PUT", live);
      const run = await f.call("/api/projects/" + second.id + "/run", "POST", {
        planId: plan.id,
      });
      assert.equal(
        run.status,
        "passed",
        JSON.stringify({ run, errors: f.errors }),
      );
      assert.equal(f.seen.length, count + 2);
      const backup = await f.call("/api/projects/" + second.id + "/export"),
        restored = await f.call(
          "/api/restore",
          "POST",
          { document: backup },
          201,
        );
      await f.restart();
      const disk = await f.app.store.get(restored.id);
      assert.deepEqual(disk.plans[0].steps[0].request.auth, canonical());
      const replay = await f.call("/api/projects/" + disk.id + "/run", "POST", {
        planId: disk.plans[0].id,
        environmentId: credentialEnvironment(disk),
      });
      assert.equal(
        replay.status,
        "passed",
        JSON.stringify({ replay, errors: f.errors }),
      );
      assert.equal(f.seen.length, count + 4);
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
    });
    const client = new Client(
      { name: "native-ntlm-owner", version: "1" },
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
          target_id: last.requests[0].id,
          environment_id: credentialEnvironment(last),
        },
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
    assert.equal(f.seen.length, 12);
    await client.close();
    await cliRun(f, last.id, last.plans[0].id, credentialEnvironment(last));
    assert.equal(f.seen.length, 14);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(await f.app.store.get(source.id), sourceBefore);
    assert.deepEqual(await f.app.store.get(foreign.id), foreignBefore);
  },
);
test(
  "native NTLM reimported credentials retain failed-proof and downgrade refusal without replay",
  { timeout: 30000 },
  async (t) => {
    const f = await owner(t, destination()),
      source = await seed(f);
    const doc = await f.call(
        "/api/projects/" + source.id + "/export?format=apipost",
      ),
      project = await imported(f, doc);
    for (const [name, password, increment] of [
      ["bad", "wrong-password", 2],
      ["downgrade", "{{ntlmPassword}}", 1],
    ]) {
      const request = structuredClone(project.requests[0]);
      request.url = f.url + "/" + name;
      request.auth.password = password;
      const before = f.seen.length,
        result = await f.call(
          "/api/projects/" + project.id + "/execute",
          "POST",
          { request, environmentId: credentialEnvironment(project) },
        );
      assert.equal(f.seen.length, before + increment);
      if (name === "bad") {
        assert.equal(result.status, 401);
        assert.equal(result.authHandshake.roundTrips, 2);
      } else {
        assert.equal(result.outcome, "failed", JSON.stringify(result));
        assert.match(JSON.stringify(result), /NTLMv2/);
      }
    }
    assert.equal(f.seen.length, 3);
    assert.deepEqual(f.errors, []);
  },
);
test(
  "native NTLM unsupported definitions reject atomically across both owner formats",
  { timeout: 30000 },
  async (t) => {
    const f = await owner(t, destination()),
      source = await seed(f);
    for (const format of formats) {
      const original = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
      );
      for (const mutate of [
        (value) => (value.disableRetryRequest = true),
        (value) => (value.disableRetryRequest = 1),
        (value) => (value.entity = "private-native-alias"),
        (value) => (value.domain = ""),
        (value) => (value.password = null),
      ]) {
        const document = structuredClone(original);
        nativeAuths(document, mutate);
        const target = await f.app.store.create("Reject native NTLM"),
          before = await f.app.store.get(target.id);
        const result = await f.call(
          "/api/projects/" + target.id + "/import",
          "POST",
          { document },
          400,
        );
        assert(!JSON.stringify(result).includes("private-native-alias"));
        assert(!Object.hasOwn(result, "apis"));
        assert(!Object.hasOwn(result, "files"));
        assert.deepEqual(await f.app.store.get(target.id), before);
        assert.equal(f.seen.length, 0);
      }
      const unsupported = await seed(f);
      unsupported.requests[0].auth.disableRetryRequest = false;
      await f.call("/api/projects/" + unsupported.id, "PUT", unsupported);
      const before = await f.app.store.get(unsupported.id);
      const result = await f.call(
        "/api/projects/" + unsupported.id + "/export?format=" + format,
        "GET",
        undefined,
        400,
      );
      assert(!Object.hasOwn(result, "apis"));
      assert(!Object.hasOwn(result, "files"));
      assert.deepEqual(await f.app.store.get(unsupported.id), before);
    }
    assert.equal(f.seen.length, 0);
    assert.deepEqual(f.errors, []);
  },
);
