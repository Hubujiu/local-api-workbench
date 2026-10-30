// Root-only native inheritance integration; Workbench signing is independently
// verified without running the original application or a production signer oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createHmac,
  generateKeyPairSync,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";

const sourceSecret = "fictional-source-project-key-".repeat(4);
const ownSecret = "fictional-source-own-key-".repeat(4);
const targetSecret = "fictional-target-must-not-leak-".repeat(4);
function source(base, privateKey) {
  const document = nativeInheritanceFixture();
  document.global.envs[0].server_list[0].uri = base;
  const projectJWT = {
    algorithm: "HS256",
    secret: sourceSecret,
    isSecretBase64Encoded: "false",
    payload: ' {\n "layer":"project", "unicode":"雪"\n } ',
    headerPrefix: "",
    queryParamKey: "jwt",
    header: ' {"kid":"project"} ',
    addTokenTo: "header",
  };
  const folderJWT = {
    algorithm: "RS256",
    secret: privateKey.replaceAll("\n", "\r\n"),
    isSecretBase64Encoded: false,
    payload: ' {"layer" : "folder"} ',
    headerPrefix: "Bearer",
    queryParamKey: "jwt",
    header: '{ "kid" : "folder" }',
    addTokenTo: "queryParam",
  };
  const ownHMAC = {
    ...projectJWT,
    algorithm: "HS384",
    secret: Buffer.from(ownSecret).toString("base64"),
    isSecretBase64Encoded: true,
    payload: '{ "layer":"own-hmac" }',
    header: '{"kid":"own-hmac"}',
    addTokenTo: "queryParam",
  };
  const ownRSA = {
    ...folderJWT,
    secret: privateKey,
    payload: '{"layer":"own-rsa"}\n',
    header: '{"kid":"own-rsa"}',
    addTokenTo: "header",
    headerPrefix: "Fixture",
  };
  const envelope = (jwt) => ({ type: "jwt", jwt: structuredClone(jwt) });
  document.global.global_param.auth = envelope(projectJWT);
  const template = structuredClone(document.apis[1]);
  const folder = (id, name, parent, auth) => ({
    target_id: id,
    target_type: "folder",
    name,
    parent_id: parent,
    request: { auth },
  });
  const expected = new Map([
    ["project", projectJWT],
    ["folder", folderJWT],
    ["own-hmac", ownHMAC],
    ["own-rsa", ownRSA],
    ["noauth", null],
    ["disabled-parent", null],
    ["absent", folderJWT],
  ]);
  const api = (id, parent, auth) => {
    const node = structuredClone(template);
    node.target_id = id;
    node.name = id;
    node.parent_id = parent;
    node.url = "/" + id + "?jwt=old&untouched=yes";
    node.request.query.parameter = [];
    node.request.header.parameter = [];
    if (auth === undefined) delete node.request.auth;
    else node.request.auth = auth;
    return node;
  };
  document.apis = [
    folder("rsa-folder", "RSA folder", "0", envelope(folderJWT)),
    folder("disabled-folder", "Disabled", "rsa-folder", { type: "noauth" }),
    api("project", "0", { type: "inherit" }),
    api("folder", "rsa-folder", { type: "inherit" }),
    api("own-hmac", "rsa-folder", envelope(ownHMAC)),
    api("own-rsa", "0", envelope(ownRSA)),
    api("noauth", "rsa-folder", { type: "noauth" }),
    api("disabled-parent", "disabled-folder", { type: "inherit" }),
    api("absent", "rsa-folder", undefined),
  ];
  return { document, expected, projectJWT, folderJWT };
}
function inspect(req, expected, publicKey) {
  const url = new URL(req.url, "http://fixture"),
    name = url.pathname.slice(1);
  assert(expected.has(name));
  assert.equal(url.searchParams.get("untouched"), "yes");
  const auth = expected.get(name);
  if (!auth) {
    assert.equal(
      req.headers.authorization,
      undefined,
      "no-auth boundary must not inherit target or ancestor credentials",
    );
    assert.deepEqual(url.searchParams.getAll("jwt"), ["old"]);
    return;
  }
  let token;
  if (auth.addTokenTo === "queryParam") {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(url.searchParams.getAll("jwt").length, 1);
    token = url.searchParams.get("jwt");
  } else {
    const prefix = auth.headerPrefix ? auth.headerPrefix + " " : "";
    assert.equal(typeof req.headers.authorization, "string");
    assert(req.headers.authorization.startsWith(prefix));
    token = req.headers.authorization.slice(prefix.length);
  }
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    typ: "JWT",
    ...JSON.parse(auth.header),
    alg: auth.algorithm,
  });
  assert.equal(Buffer.from(payload, "base64url").toString(), auth.payload);
  const message = Buffer.from(header + "." + payload),
    bytes = Buffer.from(signature, "base64url");
  if (auth.algorithm.startsWith("HS")) {
    const key =
      auth.isSecretBase64Encoded === true
        ? Buffer.from(auth.secret, "base64")
        : Buffer.from(auth.secret);
    const actual = createHmac("sha" + auth.algorithm.slice(2), key)
      .update(message)
      .digest();
    assert.equal(bytes.length, actual.length);
    assert(timingSafeEqual(bytes, actual));
  } else assert.equal(verify("sha256", message, publicKey, bytes), true);
}
function graphIntent(project) {
  const graph = project.settings.nativeInheritance;
  return {
    projectLayer: graph.projectLayer,
    folders: graph.folders
      .map(({ sourceId, parentId, ...entry }) => entry)
      .sort((a, b) => a.path.localeCompare(b.path)),
    requests: Object.fromEntries(
      project.requests.map((request) => [
        request.name,
        {
          auth: request.auth,
          mode: request.nativeInheritance.authMode,
          folder: request.folder,
        },
      ]),
    ),
  };
}
function nativeLayers(document) {
  if (!document.files)
    return { global: document.global.global_param, apis: document.apis };
  return {
    global: JSON.parse(
      document.files.find((file) => file.path === "global_params.json").text,
    ),
    apis: document.files
      .filter(
        (file) =>
          file.path.startsWith("apis/") && file.path !== "apis/index.json",
      )
      .map((file) => JSON.parse(file.text).data),
  };
}
for (const format of ["apipost", "apipost-directory"]) {
  test(
    `root ${format} JWT inheritance preserve/flatten definitions maintain source graph, no-auth boundaries and frozen restart execution`,
    { timeout: 45000 },
    async (t) => {
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      let expected;
      const seen = [],
        errors = [];
      const peer = http.createServer((req, res) => {
        try {
          inspect(req, expected, rsa.publicKey);
          seen.push(new URL(req.url, "http://fixture").pathname);
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        } catch (error) {
          errors.push(error.message);
          res.statusCode = 401;
          res.end("independent JWT verification failed");
        }
      });
      await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
      const root = await mkdtemp(join(tmpdir(), "native-jwt-inheritance-"));
      let app = await createApp({ root, port: 0 });
      async function stop() {
        app.server.closeAllConnections();
        await app.close();
      }
      t.after(async () => {
        await stop();
        peer.closeAllConnections();
        await new Promise((resolve) => peer.close(resolve));
        await rm(root, { recursive: true, force: true });
      });
      async function call(route, data, method = "POST", status = 200) {
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
      const fixture = source(
        "http://127.0.0.1:" + peer.address().port,
        rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
      );
      expected = fixture.expected;
      const original = structuredClone(fixture.document);
      const document =
        format === "apipost"
          ? fixture.document
          : nativeDirectoryFixture(fixture.document);
      const first = await app.store.create("JWT source graph");
      const imported = await call("/api/projects/" + first.id + "/import", {
        document,
        inheritanceMode: "preserve",
      });
      assert.deepEqual(fixture.document, original);
      assert.deepEqual(imported.settings.nativeInheritance.projectLayer.auth, {
        mode: "own",
        value: { ...fixture.projectJWT, type: "jwt" },
      });
      const graph = graphIntent(imported);
      assert.equal(graph.requests.absent.mode, "absent");
      assert.equal(graph.requests.noauth.mode, "none");
      assert.equal(graph.requests["disabled-parent"].mode, "inherit");
      // Preserve-graph parameter layers require unique names. Keep duplicate
      // query syntax as an atomic rejection control, not a positive graph that
      // would bypass the existing guard. The feature owner workflow separately
      // exercises duplicate replacement for ordinary non-graph requests.
      const duplicateSource = structuredClone(fixture.document);
      for (const node of duplicateSource.apis)
        if (node.target_type === "api")
          node.url = node.url.replace("jwt=old&", "jwt=old&jwt=older&");
      const duplicateTarget = await app.store.create("Duplicate JWT graph");
      await call("/api/projects/" + duplicateTarget.id + "/import", {
        document:
          format === "apipost"
            ? duplicateSource
            : nativeDirectoryFixture(duplicateSource),
        inheritanceMode: "preserve",
      });
      const duplicateBefore = await app.store.get(duplicateTarget.id);
      const rejected = await call(
        "/api/projects/" + duplicateTarget.id + "/export?format=" + format,
        undefined,
        "GET",
        400,
      );
      assert.equal(Object.hasOwn(rejected, "apis"), false);
      assert.equal(Object.hasOwn(rejected, "files"), false);
      assert.deepEqual(
        await app.store.get(duplicateTarget.id),
        duplicateBefore,
      );
      assert.equal(seen.length, 0);
      assert.deepEqual(errors, []);
      const exported = await call(
        "/api/projects/" + first.id + "/export?format=" + format,
        undefined,
        "GET",
      );
      const layers = nativeLayers(exported);
      assert.deepEqual(layers.global.auth, {
        type: "jwt",
        jwt: fixture.projectJWT,
      });
      assert.deepEqual(
        layers.apis.find((node) => node.name === "RSA folder").request.auth,
        { type: "jwt", jwt: fixture.folderJWT },
      );
      for (const name of ["own-hmac", "own-rsa"])
        assert.deepEqual(
          layers.apis.find((node) => node.name === name).request.auth,
          { type: "jwt", jwt: expected.get(name) },
        );
      assert.equal(
        Object.hasOwn(
          layers.apis.find((node) => node.name === "absent").request,
          "auth",
        ),
        false,
      );
      assert.deepEqual(
        layers.apis.find((node) => node.name === "noauth").request.auth,
        { type: "noauth" },
      );
      assert.deepEqual(
        layers.apis.find((node) => node.name === "Disabled").request.auth,
        { type: "noauth" },
      );
      assert.equal(
        seen.length,
        0,
        "source import and both definition projections do not sign or send",
      );
      const second = await app.store.create("JWT preserved generation");
      const preserved = await call("/api/projects/" + second.id + "/import", {
        document: exported,
        inheritanceMode: "preserve",
      });
      assert.deepEqual(graphIntent(preserved), graph);
      const secondExport = await call(
        "/api/projects/" + second.id + "/export?format=" + format,
        undefined,
        "GET",
      );
      assert.deepEqual(
        nativeLayers(secondExport).global.auth,
        layers.global.auth,
      );
      // Shared target credentials are forbidden for preserve, not silently mixed.
      const poisoned = await app.store.create("Target shared credentials");
      poisoned.settings.globalAuth = {
        type: "jwt",
        algorithm: "HS256",
        secret: targetSecret,
        payload: "{}",
      };
      await app.store.save(poisoned);
      const poisonedBefore = await app.store.get(poisoned.id);
      await call(
        "/api/projects/" + poisoned.id + "/import",
        { document: exported, inheritanceMode: "preserve" },
        "POST",
        400,
      );
      assert.deepEqual(await app.store.get(poisoned.id), poisonedBefore);
      assert.equal(seen.length, 0);
      const flatTarget = await app.store.create("Explicit flatten target");
      const flat = await call("/api/projects/" + flatTarget.id + "/import", {
        document: exported,
        inheritanceMode: "flatten",
      });
      assert.equal(flat.settings.nativeInheritance, undefined);
      for (const request of flat.requests) {
        const jwt = expected.get(request.name);
        assert.deepEqual(
          request.auth,
          jwt ? { ...jwt, type: "jwt" } : { type: "none" },
        );
        assert.equal(request.inheritAuth, false);
      }
      // Flatten is an IMPORT option; there is no invented flatten export option.
      const flatExport = await call(
        "/api/projects/" + flat.id + "/export?format=" + format,
        undefined,
        "GET",
      );
      const flatAgainTarget = await app.store.create(
        "Flattened effective JWT inverse",
      );
      const flatAgain = await call(
        "/api/projects/" + flatAgainTarget.id + "/import",
        { document: flatExport, inheritanceMode: "flatten" },
      );
      const isolatedFlat = await call(
        "/api/projects/" + poisoned.id + "/import",
        { document: exported, inheritanceMode: "flatten" },
      );
      async function executeAll(project) {
        const count = seen.length;
        const environmentId =
          project.environments.find(
            (environment) => environment.name === "Imported",
          )?.id || project.environments[0].id;
        for (const request of project.requests) {
          const result = await call(
            "/api/projects/" + project.id + "/execute",
            { request, environmentId },
          );
          assert.equal(
            result.outcome,
            "passed",
            JSON.stringify({ result, errors }),
          );
        }
        assert.equal(seen.length, count + 7);
      }
      for (const project of [preserved, flat, flatAgain, isolatedFlat])
        await executeAll(project);
      assert.equal(
        (await app.store.get(poisoned.id)).settings.globalAuth.secret,
        targetSecret,
      );
      const plan = await call("/api/projects/" + second.id + "/plans", {
        name: "Frozen inherited JWT",
        statusPolicy: "assertions",
        environmentId:
          preserved.environments.find(
            (environment) => environment.name === "Imported",
          )?.id || preserved.environments[0].id,
        steps: preserved.requests.map((request) => ({ request })),
      });
      // Directory graph flows have a pre-existing strict200 subset. This
      // explicitly selected assertions plan stays outside that subset.
      assert.equal(plan.statusPolicy, "assertions");
      for (const step of plan.steps) {
        assert.equal(step.request.nativeInheritance, undefined);
        assert.equal(step.request.inheritAuth, false);
        assert.equal(step.request.authSnapshot, true);
        const jwt = expected.get(step.request.name);
        assert.deepEqual(
          step.request.auth,
          jwt ? { ...jwt, type: "jwt" } : { type: "none" },
        );
      }
      const edited = await app.store.get(second.id);
      edited.settings.nativeInheritance.projectLayer.auth.value.secret =
        "later-live-project-key-".repeat(5);
      await app.store.save(edited);
      const frozen = await call("/api/projects/" + second.id + "/run", {
        planId: plan.id,
      });
      assert.equal(frozen.status, "passed", JSON.stringify({ frozen, errors }));
      const afterRun = await app.store.get(second.id);
      const beforeRejectedExport = seen.length;
      await call(
        "/api/projects/" + second.id + "/export?format=" + format,
        undefined,
        "GET",
        400,
      );
      assert.equal(seen.length, beforeRejectedExport);
      assert.deepEqual(
        await app.store.get(second.id),
        afterRun,
        "root frozen-plan export guard remains atomic",
      );
      const backup = await call(
        "/api/projects/" + second.id + "/export",
        undefined,
        "GET",
      );
      const restored = await call(
        "/api/restore",
        { document: backup },
        "POST",
        201,
      );
      await stop();
      app = await createApp({ root, port: 0 });
      const disk = await app.store.get(restored.id);
      assert.deepEqual(
        disk.settings.nativeInheritance,
        backup.settings.nativeInheritance,
      );
      assert.deepEqual(
        disk.plans[0].steps.map((step) => step.request.auth),
        plan.steps.map((step) => step.request.auth),
      );
      const replay = await call("/api/projects/" + restored.id + "/run", {
        planId: disk.plans[0].id,
      });
      assert.equal(replay.status, "passed", JSON.stringify({ replay, errors }));
      assert.equal(seen.length, 42);
      assert.deepEqual(errors, []);
      assert.deepEqual(graphIntent(await app.store.get(first.id)), graph);
    },
  );
}
