// Definition interchange and Workbench runtime only; no vendor runtime oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createHmac,
  timingSafeEqual,
  generateKeyPairSync,
  verify,
  constants,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const secret = "fictional-roundtrip-secret-".repeat(4);
const algorithms = [
  "HS256",
  "HS384",
  "HS512",
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
const formats = ["apipost", "apipost-directory"];
function configurations() {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const curves = Object.fromEntries(
    [256, 384, 512].map((bits) => [
      bits,
      generateKeyPairSync("ec", {
        namedCurve: { 256: "prime256v1", 384: "secp384r1", 512: "secp521r1" }[
          bits
        ],
      }),
    ]),
  );
  return algorithms.flatMap((algorithm, index) =>
    ["header", "queryParam"].map((placement, location) => {
      const bits = Number(algorithm.slice(2));
      const pair = algorithm.startsWith("ES") ? curves[bits] : rsa;
      const flag = [false, "false", true, "true"][(index + location) % 4];
      let key = algorithm.startsWith("HS")
        ? secret
        : pair.privateKey.export({ type: "pkcs8", format: "pem" });
      if (!algorithm.startsWith("HS") && location)
        key = key.replaceAll("\n", "\r\n");
      const encoded = algorithm.startsWith("HS")
        ? flag
        : location
          ? "false"
          : false;
      return {
        name: algorithm + "-" + placement,
        publicKey: pair.publicKey,
        auth: {
          type: "jwt",
          algorithm,
          secret:
            encoded === true || encoded === "true"
              ? Buffer.from(key).toString("base64")
              : key,
          isSecretBase64Encoded: encoded,
          payload:
            ' {\n "sub" : "' + algorithm + '", "unicode":"雪", "n":0\n } ',
          headerPrefix: location || index === 0 ? "" : "Fixture",
          queryParamKey: "signed",
          header: ' {\r\n "kid" : "fixture-key"\r\n } ',
          addTokenTo: placement,
        },
      };
    }),
  );
}
function verifyToken(token, expected) {
  assert.equal(typeof token, "string");
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const [header, payload, signature] = parts;
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    typ: "JWT",
    kid: "fixture-key",
    alg: expected.auth.algorithm,
  });
  assert.equal(
    Buffer.from(payload, "base64url").toString(),
    expected.auth.payload,
    "payload text bytes, not parsed/re-serialized JSON",
  );
  const input = header + "." + payload,
    bits = Number(expected.auth.algorithm.slice(2));
  if (expected.auth.algorithm.startsWith("HS")) {
    const actual = Buffer.from(signature, "base64url");
    const expectedBytes = createHmac("sha" + bits, secret)
      .update(input)
      .digest();
    assert.equal(actual.length, expectedBytes.length);
    assert(timingSafeEqual(actual, expectedBytes));
  } else {
    assert.equal(
      verify(
        "sha" + bits,
        Buffer.from(input),
        {
          key: expected.publicKey,
          ...(expected.auth.algorithm.startsWith("PS")
            ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: bits / 8 }
            : {}),
          ...(expected.auth.algorithm.startsWith("ES")
            ? { dsaEncoding: "ieee-p1363" }
            : {}),
        },
        Buffer.from(signature, "base64url"),
      ),
      true,
    );
  }
}
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
  const root = await mkdtemp(join(tmpdir(), "native-jwt-owner-"));
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

test(
  "owner JWT twelve algorithms Header/Query dual-native roundtrip freezes definitions across save, restart, restore and explicit execution",
  { timeout: 60000 },
  async (t) => {
    const configs = configurations();
    const f = await owner(t, (req) => {
      const url = new URL(req.url, "http://fixture");
      const expected = configs.find(
        (entry) => "/" + entry.name === url.pathname,
      );
      assert(expected);
      let token;
      if (expected.auth.addTokenTo === "queryParam") {
        assert.equal(req.headers.authorization, undefined);
        assert.equal(
          url.searchParams.getAll("signed").length,
          1,
          "all colliding configured token parameters are replaced",
        );
        token = url.searchParams.get("signed");
      } else {
        const prefix = expected.auth.headerPrefix
          ? expected.auth.headerPrefix + " "
          : "";
        assert(req.headers.authorization.startsWith(prefix));
        token = req.headers.authorization.slice(prefix.length);
      }
      assert.equal(url.searchParams.get("untouched"), "yes");
      verifyToken(token, expected);
    });
    const source = await f.app.store.create("JWT definitions");
    source.requests = configs.map(({ name, auth }) =>
      normalizeRequest({
        name,
        id: name,
        url: f.url + "/" + name + "?signed=old&signed=older&untouched=yes",
        auth,
        inheritAuth: false,
      }),
    );
    await f.call("/api/projects/" + source.id, "PUT", source);
    const expected = authByName(source);
    await f.restart();
    assert.deepEqual(authByName(await f.app.store.get(source.id)), expected);
    const foreign = await f.app.store.create("Isolated project"),
      foreignBefore = await f.app.store.get(foreign.id);
    const sourceBefore = await f.app.store.get(source.id);
    for (const format of formats) {
      const count = f.seen.length;
      const route = "/api/projects/" + source.id + "/export?format=" + format;
      assert.equal((await fetch(f.app.url + route)).status, 403);
      const document = await f.call(route);
      assert.equal(f.seen.length, count, "export never signs or dispatches");
      assert(
        JSON.stringify(document).includes(configs[0].auth.secret),
        "explicit native export intentionally contains configured secret",
      );
      const target = await f.app.store.create("JWT " + format);
      const imported = await f.call(
        "/api/projects/" + target.id + "/import",
        "POST",
        { document },
      );
      assert.deepEqual(authByName(imported), expected);
      const second = await f.call(
        "/api/projects/" + target.id + "/export?format=" + format,
      );
      const againTarget = await f.app.store.create("JWT second inverse");
      const again = await f.call(
        "/api/projects/" + againTarget.id + "/import",
        "POST",
        { document: second },
      );
      assert.deepEqual(authByName(again), expected);
      assert.equal(f.seen.length, count);
      // The native wire fixtures intentionally retain duplicate query keys for
      // collision replacement. OpenAPI correctly rejects those independently
      // of authentication; use the same signing definitions in a separate,
      // representable public-projection fixture without weakening that guard.
      const publicProject = await f.app.store.create("JWT public projection");
      publicProject.requests = imported.requests.map((request) => ({
        ...request,
        url: request.url.split("?")[0],
        query: [],
      }));
      assert.deepEqual(authByName(publicProject), authByName(imported));
      await f.call("/api/projects/" + publicProject.id, "PUT", publicProject);
      const openapi = await f.call(
        "/api/projects/" + publicProject.id + "/export?format=openapi",
      );
      const publicMechanisms = JSON.stringify(
        openapi.components.securitySchemes,
      );
      for (const { auth } of configs) {
        assert.equal(publicMechanisms.includes(auth.secret), false);
        assert.equal(publicMechanisms.includes(auth.payload), false);
      }
      assert.equal(publicMechanisms.includes("PRIVATE KEY"), false);
      const plan = await f.call(
        "/api/projects/" + target.id + "/plans",
        "POST",
        {
          name: "Frozen JWTs",
          steps: imported.requests.map((request) => ({ request })),
          statusPolicy: "strict200",
        },
      );
      const edited = await f.app.store.get(target.id);
      for (const request of edited.requests)
        request.auth = { type: "bearer", token: "later-live-edit" };
      await f.call("/api/projects/" + target.id, "PUT", edited);
      const run = await f.call("/api/projects/" + target.id + "/run", "POST", {
        planId: plan.id,
      });
      assert.equal(
        run.status,
        "passed",
        JSON.stringify({ run, errors: f.errors }),
      );
      assert.equal(f.seen.length, count + 24);
      assert.deepEqual(
        run.snapshot.steps.map((step) => step.request.auth),
        imported.requests.map((request) => request.auth),
      );
      const backup = await f.call("/api/projects/" + target.id + "/export");
      const restored = await f.call(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      assert.notEqual(restored.id, target.id);
      await f.restart();
      const disk = await f.app.store.get(restored.id);
      assert.deepEqual(
        disk.plans[0].steps.map((step) => step.request.auth),
        imported.requests.map((request) => request.auth),
      );
      const rerun = await f.call(
        "/api/projects/" + restored.id + "/run",
        "POST",
        { planId: disk.plans[0].id },
      );
      assert.equal(
        rerun.status,
        "passed",
        JSON.stringify({ rerun, errors: f.errors }),
      );
      assert.equal(f.seen.length, count + 48);
      await f.call(
        "/api/projects/" + foreign.id + "/run",
        "POST",
        { planId: plan.id },
        400,
      );
      assert.equal(f.seen.length, count + 48);
    }
    assert.deepEqual(await f.app.store.get(source.id), sourceBefore);
    assert.deepEqual(await f.app.store.get(foreign.id), foreignBefore);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "owner JWT omitted/empty/boolean/template definitions survive both formats while unsafe execution remains blocked and failed export is atomic",
  { timeout: 30000 },
  async (t) => {
    const f = await owner(t, () => {
      assert.fail("invalid JWT must not reach destination");
    });
    const source = await f.app.store.create("Exact JWT field presence");
    const definitions = [
      { type: "jwt" },
      {
        type: "jwt",
        algorithm: "",
        secret: "",
        payload: "",
        header: "",
        headerPrefix: "",
        queryParamKey: "",
        addTokenTo: "",
        isSecretBase64Encoded: false,
      },
      ...[true, false, "true", "false"].map((flag) => ({
        type: "jwt",
        secret: "short",
        isSecretBase64Encoded: flag,
        payload: ' {"private":"definition"} ',
      })),
      {
        type: "jwt",
        algorithm: "HS256",
        secret: "{{unresolvedSecret}}",
        payload: "{{unresolvedPayload}}",
        header: "{}",
      },
      {
        type: "jwt",
        algorithm: "HS256",
        secret,
        payload: "{private-invalid-json",
        headerPrefix: "Bearer",
      },
      {
        type: "jwt",
        algorithm: "HS256",
        secret,
        payload: "{}",
        header: '{"jku":"https://private-header.invalid"}',
      },
      {
        type: "jwt",
        algorithm: "RS256",
        secret:
          "-----BEGIN ENCRYPTED PRIVATE KEY-----\r\nfictional-private-bytes\r\n-----END ENCRYPTED PRIVATE KEY-----\r\n",
        payload: "{}",
      },
    ];
    source.requests = definitions.map((auth, index) =>
      normalizeRequest({
        id: "invalid-" + index,
        name: "Invalid " + index,
        url: f.url + "/invalid",
        auth,
        inheritAuth: false,
      }),
    );
    await f.call("/api/projects/" + source.id, "PUT", source);
    for (const format of formats) {
      const document = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
      );
      const target = await f.app.store.create("Preserved invalid " + format);
      const imported = await f.call(
        "/api/projects/" + target.id + "/import",
        "POST",
        { document },
      );
      assert.deepEqual(authByName(imported), authByName(source));
      for (const request of imported.requests) {
        const result = await f.call(
          "/api/projects/" + target.id + "/execute",
          "POST",
          { request },
        );
        assert.equal(result.outcome, "failed", JSON.stringify(result));
      }
      assert.deepEqual(f.seen, []);
      assert.deepEqual(f.errors, []);
    }
    const invalid = await f.app.store.get(source.id);
    invalid.requests[0].auth = {
      type: "jwt",
      algorithm: "HS256",
      secret,
      payload: "{}",
      "private-field-name": "private-field-value",
    };
    await f.call("/api/projects/" + source.id, "PUT", invalid);
    const before = await f.app.store.get(source.id);
    for (const format of formats) {
      const result = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
        "GET",
        undefined,
        400,
      );
      assert.equal(Object.hasOwn(result, "apis"), false);
      assert.equal(Object.hasOwn(result, "files"), false);
      for (const sensitive of [
        secret,
        "private-field-name",
        "private-field-value",
      ])
        assert.equal(JSON.stringify(result).includes(sensitive), false);
      assert.deepEqual(await f.app.store.get(source.id), before);
    }
    assert.deepEqual(f.seen, []);
  },
);

test(
  "owner JWT inherited/own/no-auth execution and existing SDK/CLI remain isolated while unsupported shared-scope export rejects atomically",
  { timeout: 30000 },
  async (t) => {
    const ownSecret = "fictional-own-key-".repeat(5);
    const folderSecret = "fictional-folder-key-".repeat(5);
    const keys = {
      "/parent": secret,
      "/folder": folderSecret,
      "/own": ownSecret,
    };
    const f = await owner(t, (req) => {
      const pathname = new URL(req.url, "http://fixture").pathname;
      if (pathname === "/none") {
        assert.equal(req.headers.authorization, undefined);
        return;
      }
      assert(Object.hasOwn(keys, pathname));
      assert(req.headers.authorization.startsWith("Bearer "));
      const [header, payload, signature] = req.headers.authorization
        .slice(7)
        .split(".");
      assert.deepEqual(
        JSON.parse(Buffer.from(header, "base64url").toString()),
        { typ: "JWT", alg: "HS256" },
      );
      assert.equal(
        Buffer.from(payload, "base64url").toString(),
        ' {"scope":"fixture"} ',
      );
      const actual = Buffer.from(signature, "base64url"),
        expected = createHmac("sha256", keys[pathname])
          .update(header + "." + payload)
          .digest();
      assert.equal(actual.length, expected.length);
      assert(timingSafeEqual(actual, expected));
    });
    const auth = (key) => ({
      type: "jwt",
      algorithm: "HS256",
      secret: key,
      payload: ' {"scope":"fixture"} ',
    });
    const source = await f.app.store.create("Shared JWT boundaries");
    source.settings.globalAuth = auth(secret);
    source.settings.folderAuth = { Group: auth(folderSecret) };
    source.requests = [
      normalizeRequest({
        id: "parent",
        name: "Parent auth",
        url: f.url + "/parent",
        auth: { type: "none" },
      }),
      normalizeRequest({
        id: "folder",
        name: "Folder auth",
        folder: "Group",
        url: f.url + "/folder",
        auth: { type: "none" },
      }),
      normalizeRequest({
        id: "own",
        name: "Own auth",
        folder: "Group",
        url: f.url + "/own",
        auth: auth(ownSecret),
      }),
      normalizeRequest({
        id: "none",
        name: "Explicit no auth",
        folder: "Group",
        url: f.url + "/none",
        auth: { type: "none" },
        inheritAuth: false,
      }),
    ];
    await f.call("/api/projects/" + source.id, "PUT", source);
    const other = await f.app.store.create("Foreign project"),
      otherBefore = await f.app.store.get(other.id);
    for (const request of source.requests) {
      const result = await f.call(
        "/api/projects/" + source.id + "/execute",
        "POST",
        { request },
      );
      assert.equal(
        result.outcome,
        "passed",
        JSON.stringify({ result, errors: f.errors }),
      );
    }
    assert.deepEqual(f.seen, ["/parent", "/folder", "/own", "/none"]);
    const before = await f.app.store.get(source.id);
    for (const format of formats) {
      const result = await f.call(
        "/api/projects/" + source.id + "/export?format=" + format,
        "GET",
        undefined,
        400,
      );
      assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(Object.hasOwn(result, "apis"), false);
      assert.equal(Object.hasOwn(result, "files"), false);
      assert.deepEqual(await f.app.store.get(source.id), before);
    }
    assert.equal(f.seen.length, 4);
    const eligible = await f.app.store.create("Eligible own JWT definition");
    eligible.requests = [
      normalizeRequest({
        ...source.requests[2],
        folder: "",
        inheritAuth: false,
      }),
    ];
    await f.call("/api/projects/" + eligible.id, "PUT", eligible);
    const exported = await f.call(
      "/api/projects/" + eligible.id + "/export?format=apipost-directory",
    );
    const target = await f.app.store.create(
      "Native reimported SDK and CLI JWT",
    );
    const imported = await f.call(
      "/api/projects/" + target.id + "/import",
      "POST",
      { document: exported },
    );
    const importedRequest = imported.requests[0];
    assert.notEqual(importedRequest.id, source.requests[2].id);
    assert.deepEqual(importedRequest.auth, source.requests[2].auth);
    assert.equal(
      f.seen.length,
      4,
      "adapter conversion performs no token signing or HTTP",
    );
    const config = await f.call("/api/mcp/config", "POST", {
      enabled: true,
      projects: [target.id],
      write: true,
      execute: true,
      remember: false,
    });
    const client = new Client(
      { name: "jwt-definition-roundtrip", version: "1" },
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
    for (const name of ["localapi_execute_api", "apipost_execute_api"])
      assert(tools.has(name));
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
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(JSON.parse(result.content[0].text).status, "passed");
    }
    const denied = await client.callTool({
      name: "localapi_execute_api",
      arguments: { projectId: other.id, apiId: importedRequest.id },
    });
    assert.equal(denied.isError, true);
    assert.equal(f.seen.length, 6);
    await client.close();
    const plan = await f.call("/api/projects/" + target.id + "/plans", "POST", {
      name: "CLI frozen reimported JWT",
      steps: [{ request: importedRequest }],
    });
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        target.id,
        "--plan",
        plan.id,
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
        if (
          Buffer.byteLength(output) + Buffer.byteLength(errors) >
          1024 * 1024
        ) {
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
    assert.equal(f.seen.length, 7);
    assert.deepEqual(await f.app.store.get(other.id), otherBefore);
    assert.deepEqual(f.errors, []);
  },
);
