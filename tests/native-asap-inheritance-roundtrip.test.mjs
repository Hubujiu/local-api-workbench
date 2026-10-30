// Root-only native inheritance integration; Workbench signing is independently
// verified without running the original application or a production signer oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, verify, constants } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";

const targetSubject = "fictional-target-must-not-leak";
function canonical(native) {
  const { exp, ...rest } = native;
  return {
    type: "asap",
    ...rest,
    sub: native.sub || native.iss,
    claims: native.claims || "{}",
    ttlSeconds: exp === undefined || exp === "" ? 3600 : exp,
  };
}
function source(base, rsaKey, ecKey) {
  const document = nativeInheritanceFixture();
  document.global.envs[0].server_list[0].uri = base;
  const projectASAP = {
    alg: "RS256",
    iss: "fixture/project",
    aud: "project audience",
    kid: "fixture/project/key",
    privateKey: rsaKey,
    claims: ' {"layer":"project","unicode":"雪"} ',
  };
  const folderASAP = {
    alg: "PS384",
    iss: "fixture/folder",
    aud: " folder audience ",
    kid: "fixture/folder/key",
    privateKey: rsaKey.replaceAll("\n", "\r\n"),
    sub: "folder subject",
    exp: "180",
    claims: ' {"layer" : "folder", "nbf":0} ',
  };
  const ownEC = {
    alg: "ES256",
    iss: "fixture/own",
    aud: "own audience",
    kid: "fixture/own/ec",
    privateKey: ecKey,
    sub: "own subject",
    exp: 90,
    claims: ' {"layer":"own-ec"}\n',
  };
  const ownRSA = { ...projectASAP, sub: "", exp: "", claims: "" };
  const envelope = (asap) => ({ type: "asap", asap: structuredClone(asap) });
  document.global.global_param.auth = envelope(projectASAP);
  const template = structuredClone(document.apis[1]);
  const folder = (id, name, parent, auth) => ({
    target_id: id,
    target_type: "folder",
    name,
    parent_id: parent,
    request: { auth },
  });
  const expected = new Map([
    ["project", canonical(projectASAP)],
    ["folder", canonical(folderASAP)],
    ["own-ec", canonical(ownEC)],
    ["own-rsa", canonical(ownRSA)],
    ["noauth", null],
    ["disabled-parent", null],
    ["absent", canonical(folderASAP)],
  ]);
  const api = (id, parent, auth) => {
    const node = structuredClone(template);
    node.target_id = id;
    node.name = id;
    node.parent_id = parent;
    node.url = "/" + id + "?untouched=yes";
    node.request.query.parameter = [];
    node.request.header.parameter = [];
    if (auth === undefined) delete node.request.auth;
    else node.request.auth = auth;
    return node;
  };
  document.apis = [
    folder("signing-folder", "Signing folder", "0", envelope(folderASAP)),
    folder("disabled-folder", "Disabled", "signing-folder", { type: "noauth" }),
    api("project", "0", { type: "inherit" }),
    api("folder", "signing-folder", { type: "inherit" }),
    api("own-ec", "signing-folder", envelope(ownEC)),
    api("own-rsa", "0", envelope(ownRSA)),
    api("noauth", "signing-folder", { type: "noauth" }),
    api("disabled-parent", "disabled-folder", { type: "inherit" }),
    api("absent", "signing-folder", undefined),
  ];
  return { document, expected, projectASAP, folderASAP };
}
function nativeDefinition(auth) {
  const { type, ttlSeconds, ...rest } = auth;
  return { type: "asap", asap: { ...rest, exp: ttlSeconds } };
}
function inspect(req, expected, rsaKey, ecKey, jtis) {
  const url = new URL(req.url, "http://fixture"),
    name = url.pathname.slice(1);
  assert(expected.has(name));
  assert.equal(
    url.search,
    "?untouched=yes",
    "ASAP must not add query credentials",
  );
  const auth = expected.get(name);
  if (!auth) {
    assert.equal(
      req.headers.authorization,
      undefined,
      "noauth stops ancestor and target credentials",
    );
    return;
  }
  assert(req.headers.authorization?.startsWith("Bearer "));
  const parts = req.headers.authorization.slice(7).split(".");
  assert.equal(parts.length, 3);
  const [h, p, s] = parts;
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
  assert(!jtis.has(payload.jti));
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
        key: auth.alg.startsWith("ES") ? ecKey : rsaKey,
        ...(auth.alg.startsWith("PS")
          ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: bits / 8 }
          : {}),
        ...(auth.alg.startsWith("ES") ? { dsaEncoding: "ieee-p1363" } : {}),
      },
      Buffer.from(s, "base64url"),
    ),
  );
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
    `root ${format} ASAP inheritance preserve/flatten definitions maintain source graph, no-auth boundaries and frozen restart execution`,
    { timeout: 45000 },
    async (t) => {
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jtis = new Set();
      let expected;
      const seen = [],
        errors = [];
      const peer = http.createServer((req, res) => {
        try {
          inspect(req, expected, rsa.publicKey, ec.publicKey, jtis);
          seen.push(new URL(req.url, "http://fixture").pathname);
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        } catch (error) {
          errors.push(error.message);
          res.statusCode = 401;
          res.end("independent ASAP verification failed");
        }
      });
      await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
      const root = await mkdtemp(join(tmpdir(), "native-asap-inheritance-"));
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
        ec.privateKey.export({ type: "pkcs8", format: "pem" }),
      );
      expected = fixture.expected;
      const original = structuredClone(fixture.document);
      const document =
        format === "apipost"
          ? fixture.document
          : nativeDirectoryFixture(fixture.document);
      const first = await app.store.create("ASAP source graph");
      const imported = await call("/api/projects/" + first.id + "/import", {
        document,
        inheritanceMode: "preserve",
      });
      assert.deepEqual(fixture.document, original);
      assert.deepEqual(imported.settings.nativeInheritance.projectLayer.auth, {
        mode: "own",
        value: expected.get("project"),
      });
      const graph = graphIntent(imported);
      assert.equal(graph.requests.absent.mode, "absent");
      assert.equal(graph.requests.noauth.mode, "none");
      assert.equal(graph.requests["disabled-parent"].mode, "inherit");
      const exported = await call(
        "/api/projects/" + first.id + "/export?format=" + format,
        undefined,
        "GET",
      );
      const layers = nativeLayers(exported);
      assert.deepEqual(
        layers.global.auth,
        nativeDefinition(expected.get("project")),
      );
      assert.deepEqual(
        layers.apis.find((node) => node.name === "Signing folder").request.auth,
        nativeDefinition(expected.get("folder")),
      );
      for (const name of ["own-ec", "own-rsa"])
        assert.deepEqual(
          layers.apis.find((node) => node.name === name).request.auth,
          nativeDefinition(expected.get(name)),
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
      const second = await app.store.create("ASAP preserved generation");
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
        ...expected.get("project"),
        sub: targetSubject,
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
        const auth = expected.get(request.name);
        assert.deepEqual(request.auth, auth || { type: "none" });
        assert.equal(request.inheritAuth, false);
      }
      // Flatten is an IMPORT option; there is no invented flatten export option.
      const flatExport = await call(
        "/api/projects/" + flat.id + "/export?format=" + format,
        undefined,
        "GET",
      );
      const flatAgainTarget = await app.store.create(
        "Flattened effective ASAP inverse",
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
        (await app.store.get(poisoned.id)).settings.globalAuth.sub,
        targetSubject,
      );
      const plan = await call("/api/projects/" + second.id + "/plans", {
        name: "Frozen inherited ASAP",
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
        const auth = expected.get(step.request.name);
        assert.deepEqual(step.request.auth, auth || { type: "none" });
      }
      const edited = await app.store.get(second.id);
      edited.settings.nativeInheritance.projectLayer.auth.value.sub =
        "later-live-project-subject";
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
