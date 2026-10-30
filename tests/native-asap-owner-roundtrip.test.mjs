// Definition interchange and Workbench runtime only; no vendor runtime oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateKeyPairSync, verify, constants } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

async function owner(t, handler) {
  const errors = [],
    seen = [];
  const peer = http.createServer((req, res) => {
    try {
      handler(req);
      seen.push(req.url);
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    } catch (error) {
      errors.push(error.message);
      res.statusCode = 401;
      res.end("independent verification failed");
    }
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "native-asap-owner-"));
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

const formats = ["apipost", "apipost-directory"];
const algorithms = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
];
function configurations() {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = Object.fromEntries(
    [256, 384, 512].map((bits) => [
      bits,
      generateKeyPairSync("ec", {
        namedCurve: { 256: "prime256v1", 384: "secp384r1", 512: "secp521r1" }[
          bits
        ],
      }),
    ]),
  );
  return algorithms.map((alg, index) => {
    const pair = alg.startsWith("ES") ? ec[Number(alg.slice(2))] : rsa;
    let privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    if (index % 2) privateKey = privateKey.replaceAll("\n", "\r\n");
    return {
      name: alg,
      publicKey: pair.publicKey,
      auth: {
        type: "asap",
        alg,
        iss: "fixture/service",
        kid: "fixture/service/key-" + index,
        aud: " audience-" + index + " ",
        sub: "subject-" + index,
        privateKey,
        ttlSeconds: index % 2 ? "120" : 90,
        claims: ' {\n "custom":"雪-private-claim", "n":0, "nbf":0\n } ',
      },
    };
  });
}
function verifier(configs) {
  const jtis = new Set();
  return (req) => {
    const url = new URL(req.url, "http://fixture");
    assert.equal(url.search, "", "ASAP never uses query token placement");
    const expected = configs.find((c) => "/" + c.name === url.pathname);
    assert(expected);
    assert(req.headers.authorization?.startsWith("Bearer "));
    const parts = req.headers.authorization.slice(7).split(".");
    assert.equal(parts.length, 3);
    const [h, p, s] = parts,
      auth = expected.auth;
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), {
      typ: "JWT",
      kid: auth.kid,
      alg: auth.alg,
    });
    const payload = JSON.parse(Buffer.from(p, "base64url"));
    assert(Number.isSafeInteger(payload.iat));
    assert(Math.abs(payload.iat - Math.floor(Date.now() / 1000)) <= 10);
    assert.equal(payload.exp - payload.iat, Number(auth.ttlSeconds));
    assert.match(
      payload.jti,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert(!jtis.has(payload.jti), "fresh jti for every explicit execution");
    jtis.add(payload.jti);
    assert.deepEqual(payload, {
      ...JSON.parse(auth.claims),
      iss: auth.iss,
      aud: auth.aud,
      sub: auth.sub,
      iat: payload.iat,
      exp: payload.exp,
      jti: payload.jti,
    });
    const bits = Number(auth.alg.slice(2));
    assert(
      verify(
        "sha" + bits,
        Buffer.from(h + "." + p),
        {
          key: expected.publicKey,
          ...(auth.alg.startsWith("PS")
            ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: bits / 8 }
            : {}),
          ...(auth.alg.startsWith("ES") ? { dsaEncoding: "ieee-p1363" } : {}),
        },
        Buffer.from(s, "base64url"),
      ),
    );
  };
}
async function seed(f, configs, name = "ASAP definitions") {
  const p = await f.app.store.create(name);
  p.requests = configs.map((c) =>
    normalizeRequest({
      id: c.name,
      name: c.name,
      url: f.url + "/" + c.name,
      auth: c.auth,
      inheritAuth: false,
    }),
  );
  await f.call("/api/projects/" + p.id, "PUT", p);
  return p;
}
async function importDocument(f, document) {
  const p = await f.app.store.create("Reimported ASAP");
  return f.call("/api/projects/" + p.id + "/import", "POST", { document });
}
// Mutate actual exported native request envelopes, including directory JSON text.
function nativeAuths(document, mutate) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "asap" && node.asap) mutate(node.asap);
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

test(
  "owner ASAP nine algorithms canonical dual-native definitions survive reopen, frozen backup restore, SDK and CLI execution",
  { timeout: 60000 },
  async (t) => {
    const configs = configurations(),
      f = await owner(t, verifier(configs));
    const source = await seed(f, configs),
      expected = authByName(source);
    const foreign = await f.app.store.create("Isolated ASAP project"),
      foreignBefore = await f.app.store.get(foreign.id);
    await f.restart();
    assert.deepEqual(authByName(await f.app.store.get(source.id)), expected);
    const sourceBefore = await f.app.store.get(source.id);
    let restoredForEntrypoints;
    for (const format of formats) {
      const count = f.seen.length;
      const document = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
      );
      assert(JSON.stringify(document).includes("PRIVATE KEY"));
      const replaced = new Set();
      nativeAuths(document, (native) => {
        const config = configs.find((entry) => entry.auth.alg === native.alg);
        assert(config, "export contains only the nine fixture algorithms");
        assert(
          !replaced.has(native.alg),
          "one native definition per algorithm",
        );
        const auth = config.auth;
        // Independently authored native eight-field fixture: never invoke the
        // production converter to derive the import input or export oracle.
        const fixture = {
          alg: auth.alg,
          iss: auth.iss,
          aud: auth.aud,
          kid: auth.kid,
          privateKey: auth.privateKey,
          sub: auth.sub,
          claims: auth.claims,
          exp: auth.ttlSeconds,
        };
        assert.deepEqual(native, fixture);
        replaced.add(native.alg);
        for (const key of Object.keys(native)) delete native[key];
        Object.assign(native, fixture);
      });
      assert.equal(replaced.size, 9, format + " native fixture replacements");
      const imported = await importDocument(f, document);
      assert.deepEqual(authByName(imported), expected);
      const second = await f.call(
        "/api/projects/" + imported.id + "/export?format=" + format,
      );
      const again = await importDocument(f, second);
      assert.deepEqual(authByName(again), expected);
      const openapi = await f.call(
        "/api/projects/" + again.id + "/export?format=openapi",
      );
      const publicText = JSON.stringify(openapi);
      assert(openapi.components.securitySchemes);
      assert(!publicText.includes("PRIVATE KEY"));
      assert(!publicText.includes("雪-private-claim"));
      for (const c of configs) assert(!publicText.includes(c.auth.privateKey));
      assert.equal(f.seen.length, count, "conversion is never execution");
      const plan = await f.call(
        "/api/projects/" + again.id + "/plans",
        "POST",
        {
          name: "Frozen ASAP",
          steps: again.requests.map((request) => ({ request })),
          statusPolicy: "strict200",
        },
      );
      const edited = await f.app.store.get(again.id);
      for (const request of edited.requests)
        request.auth = { type: "bearer", token: "live-edit" };
      await f.call("/api/projects/" + again.id, "PUT", edited);
      const run = await f.call("/api/projects/" + again.id + "/run", "POST", {
        planId: plan.id,
      });
      assert.equal(
        run.status,
        "passed",
        JSON.stringify({ run, errors: f.errors }),
      );
      assert.deepEqual(
        run.snapshot.steps.map((s) => s.request.auth),
        again.requests.map((r) => r.auth),
      );
      const backup = await f.call("/api/projects/" + again.id + "/export");
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
        again.requests.map((r) => r.auth),
      );
      const rerun = await f.call("/api/projects/" + disk.id + "/run", "POST", {
        planId: disk.plans[0].id,
      });
      assert.equal(
        rerun.status,
        "passed",
        JSON.stringify({ rerun, errors: f.errors }),
      );
      assert.equal(f.seen.length, count + 18);
      // Restore live definitions from the *restored frozen snapshots*, not hand-built auth.
      disk.requests = disk.plans[0].steps.map((s) => s.request);
      await f.call("/api/projects/" + disk.id, "PUT", disk);
      restoredForEntrypoints = disk;
    }
    const target = restoredForEntrypoints,
      importedRequest = target.requests[0];
    const config = await f.call("/api/mcp/config", "POST", {
      enabled: true,
      projects: [target.id],
      write: true,
      execute: true,
      remember: false,
    });
    const client = new Client(
      { name: "asap-roundtrip", version: "1" },
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
    for (const [name, args] of [
      [
        "localapi_execute_api",
        { projectId: target.id, apiId: importedRequest.id },
      ],
      [
        "apipost_execute_api",
        { project_id: target.id, target_id: importedRequest.id },
      ],
    ]) {
      assert(tools.has(name));
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(JSON.parse(result.content[0].text).status, "passed");
    }
    const denied = await client.callTool({
      name: "localapi_execute_api",
      arguments: { projectId: foreign.id, apiId: importedRequest.id },
    });
    assert.equal(denied.isError, true);
    await client.close();
    await cliRun(f, target.id, target.plans[0].id);
    assert.equal(f.seen.length, 47);
    assert.deepEqual(await f.app.store.get(source.id), sourceBefore);
    assert.deepEqual(await f.app.store.get(foreign.id), foreignBefore);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "ASAP native subject/expiry and Workbench algorithm/TTL defaults canonicalize without token signing until explicit execute",
  { timeout: 30000 },
  async (t) => {
    const original = configurations()[0];
    const nativeExpected = {
      ...original,
      name: "native-default",
      auth: {
        ...original.auth,
        sub: original.auth.iss,
        ttlSeconds: 3600,
        claims: "{}",
      },
    };
    const wbExpected = {
      ...original,
      name: "workbench-default",
      auth: { ...original.auth, alg: "RS256", ttlSeconds: 60, claims: "{}" },
    };
    const f = await owner(t, verifier([nativeExpected, wbExpected]));
    for (const format of formats) {
      const source = await seed(f, [
        { ...original, name: nativeExpected.name },
      ]);
      const doc = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
      );
      nativeAuths(doc, (a) => {
        if (format === "apipost") {
          delete a.sub;
          delete a.exp;
          delete a.claims;
        } else {
          a.sub = "";
          a.exp = "";
          a.claims = "";
        }
      });
      const target = await importDocument(f, doc);
      assert.deepEqual(target.requests[0].auth, nativeExpected.auth);
      const stable = await importDocument(
        f,
        await f.call("/api/projects/" + target.id + "/export?format=" + format),
      );
      assert.deepEqual(stable.requests[0].auth, nativeExpected.auth);
      const wbAuth = { ...wbExpected.auth };
      if (format === "apipost") {
        delete wbAuth.alg;
        delete wbAuth.ttlSeconds;
        delete wbAuth.claims;
      } else {
        wbAuth.alg = "";
        wbAuth.ttlSeconds = "";
        wbAuth.claims = "";
      }
      const wb = await seed(f, [{ ...wbExpected, auth: wbAuth }]);
      const wbTarget = await importDocument(
        f,
        await f.call("/api/projects/" + wb.id + "/export?format=" + format),
      );
      assert.deepEqual(wbTarget.requests[0].auth, wbExpected.auth);
      for (const p of [stable, wbTarget]) {
        const result = await f.call(
          "/api/projects/" + p.id + "/execute",
          "POST",
          { request: p.requests[0] },
        );
        assert.equal(
          result.outcome,
          "passed",
          JSON.stringify({ result, errors: f.errors }),
        );
      }
    }
    assert.equal(f.seen.length, 4);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "ASAP unsupported conversions are atomic and redacted; accepted bad-key/nbf envelopes still execute zero HTTP",
  { timeout: 30000 },
  async (t) => {
    const original = configurations()[0],
      f = await owner(t, () => assert.fail("unsafe ASAP reached HTTP"));
    for (const format of formats) {
      const source = await seed(f, [original]);
      const good = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
      );
      const target = await f.app.store.create("Atomic import target"),
        before = await f.app.store.get(target.id);
      for (const mutate of [
        (a) => {
          a.privateUnknown = "private-error-marker";
        },
        (a) => {
          a.claims = '{"kid":"private-error-marker"}';
        },
        (a) => {
          delete a.alg;
        },
        (a) => {
          a.exp = "001";
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
        assert(!JSON.stringify(error).includes("private-error-marker"));
        assert(!JSON.stringify(error).includes("PRIVATE KEY"));
        assert.deepEqual(await f.app.store.get(target.id), before);
      }
      const invalid = await seed(f, [
        {
          ...original,
          name: "bad-key",
          auth: {
            ...original.auth,
            privateKey:
              "-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----\n",
          },
        },
        {
          ...original,
          name: "bad-nbf",
          auth: { ...original.auth, claims: '{"nbf":9007199254740991}' },
        },
      ]);
      const imported = await importDocument(
        f,
        await f.call(
          "/api/projects/" + invalid.id + "/export?format=" + format,
        ),
      );
      for (const request of imported.requests) {
        const result = await f.call(
          "/api/projects/" + imported.id + "/execute",
          "POST",
          { request },
        );
        assert.equal(result.outcome, "failed");
      }
      const unsupported = await f.app.store.get(source.id);
      unsupported.requests[0].auth.privateUnknown = "private-error-marker";
      await f.call("/api/projects/" + source.id, "PUT", unsupported);
      const snapshot = await f.app.store.get(source.id);
      const error = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
        "GET",
        undefined,
        400,
      );
      assert(!JSON.stringify(error).includes("private-error-marker"));
      assert(!JSON.stringify(error).includes("PRIVATE KEY"));
      assert(!Object.hasOwn(error, "apis"));
      assert(!Object.hasOwn(error, "files"));
      assert.deepEqual(await f.app.store.get(source.id), snapshot);
    }
    assert.deepEqual(f.seen, []);
    assert.deepEqual(f.errors, []);
  },
);
