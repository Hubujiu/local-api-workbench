// Root-only native inheritance integration; Workbench signing is independently
// verified without running the original application or a production signer oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";

import { verifyOAuth1Policy } from "./fixtures/oauth1-policy-oracle.mjs";

const targetPassword = "target-password-must-not-leak";
const entity = "inheritance raw \0 雪\r\n";
function canonical(n) {
  return {
    type: "oauth1",
    consumerKey: n.consumerKey,
    consumerSecret: n.consumerSecret ?? "",
    accessToken: n.token ?? "",
    tokenSecret: n.tokenSecret ?? "",
    signatureMethod: n.signatureMethod,
    realm: n.realm ?? "",
    version: n.version ?? "",
    nonce: n.nonce ?? "",
    timestamp: n.timestamp ?? "",
    callback: n.callback ?? "",
    verifier: n.verifier ?? "",
    privateKey: n.privateKey ?? "",
    privateKeyPassphrase: "",
    parameterPolicy: {
      placement: n.addParamsToHeader ? "header" : "auto",
      includeBodyHash: n.includeBodyHash,
      includeEmptyParams: n.addEmptyParamsToSign,
      headerEncoding: n.disableHeaderEncoding ? "raw" : "percent",
    },
  };
}
function source(base, privateKey) {
  const document = nativeInheritanceFixture();
  document.global.envs[0].server_list[0].uri = base;
  const native = (name, changes = {}) => ({
    consumerKey: name + "-key",
    consumerSecret: name + "-secret",
    token: name + "-token",
    tokenSecret: name + "-token-secret",
    signatureMethod: "HMAC-SHA1",
    realm: "graph realm",
    version: "1.0",
    nonce: "",
    timestamp: "",
    callback: "",
    verifier: "",
    privateKey: "",
    addEmptyParamsToSign: false,
    includeBodyHash: true,
    addParamsToHeader: false,
    disableHeaderEncoding: false,
    ...changes,
  });
  const projectOauth = native("project"),
    folderOauth = native("folder", {
      signatureMethod: "HMAC-SHA256",
      addParamsToHeader: true,
      includeBodyHash: false,
    }),
    ownOauth = native("own", {
      signatureMethod: "RSA-SHA1",
      addParamsToHeader: true,
      privateKey,
    }),
    ownDefault = native("own-default", { addEmptyParamsToSign: true });
  for (const field of [
    "token",
    "tokenSecret",
    "realm",
    "version",
    "nonce",
    "timestamp",
    "callback",
    "verifier",
    "privateKey",
  ])
    delete ownDefault[field];
  const envelope = (oauth1) => ({
    type: "oauth1",
    oauth1: structuredClone(oauth1),
  });
  document.global.global_param.auth = envelope(projectOauth);
  const template = structuredClone(document.apis[1]);
  const folder = (id, name, parent, auth) => ({
    target_id: id,
    target_type: "folder",
    name,
    parent_id: parent,
    request: { auth },
  });
  const expected = new Map([
    ["project", canonical(projectOauth)],
    ["folder", canonical(folderOauth)],
    ["own", canonical(ownOauth)],
    ["own-default", canonical(ownDefault)],
    ["noauth", null],
    ["disabled-parent", null],
    ["absent", canonical(folderOauth)],
  ]);
  const api = (id, parent, auth) => {
    const node = structuredClone(template);
    Object.assign(node, {
      target_id: id,
      name: id,
      parent_id: parent,
      method: "POST",
      url: "/" + id + "?untouched=yes",
    });
    node.request.query.parameter = [];
    node.request.header.parameter = [
      {
        key: "Content-Type",
        value: "text/plain; charset=utf-8",
        is_checked: 1,
      },
    ];
    node.request.body =
      id === "own-default"
        ? {
            mode: "urlencoded",
            parameter: [
              { key: "first", value: "1", is_checked: 1 },
              { key: "second", value: "2", is_checked: 1 },
              { key: "empty", value: "", is_checked: 1 },
            ],
          }
        : { mode: "plain", raw: entity };
    if (id === "own-default") node.request.header.parameter = [];
    if (auth === undefined) delete node.request.auth;
    else node.request.auth = auth;
    return node;
  };
  document.apis = [
    folder("signing-folder", "Signing folder", "0", envelope(folderOauth)),
    folder("disabled-folder", "Disabled", "signing-folder", { type: "noauth" }),
    api("project", "0", { type: "inherit" }),
    api("folder", "signing-folder", { type: "inherit" }),
    api("own", "signing-folder", envelope(ownOauth)),
    api("own-default", "0", envelope(ownDefault)),
    api("noauth", "signing-folder", { type: "noauth" }),
    api("disabled-parent", "disabled-folder", { type: "inherit" }),
    api("absent", "signing-folder", undefined),
  ];
  return { document, expected };
}
function nativeDefinition(auth) {
  const {
    type,
    accessToken,
    privateKeyPassphrase,
    parameterPolicy,
    ...strings
  } = auth;
  return {
    type,
    oauth1: {
      ...strings,
      token: accessToken,
      addEmptyParamsToSign: parameterPolicy.includeEmptyParams,
      includeBodyHash: parameterPolicy.includeBodyHash,
      addParamsToHeader: parameterPolicy.placement === "header",
      disableHeaderEncoding: parameterPolicy.headerEncoding === "raw",
    },
  };
}
function verifier(publicKey) {
  const nonces = new Set();
  return async (req, res, expected) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks),
      url = new URL(req.url, "http://fixture"),
      name = url.pathname.slice(1);
    assert(expected.has(name));
    assert.equal(req.method, "POST");
    const auth = expected.get(name);
    if (!auth) {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(url.search, "?untouched=yes");
      assert.deepEqual(body, Buffer.from(entity));
      return false;
    }
    const checked = verifyOAuth1Policy({
      url: "http://" + req.headers.host + req.url,
      method: req.method,
      headers: req.headers,
      body,
      auth,
      bodyType: name === "own-default" ? "urlencoded" : "raw",
      publicKey,
    });
    assert.deepEqual(checked.ordinaryQuery, [["untouched", "yes"]]);
    if (name === "own-default")
      assert.deepEqual(checked.ordinaryForm, [
        ["first", "1"],
        ["second", "2"],
        ["empty", ""],
      ]);
    else assert.deepEqual(body, Buffer.from(entity));
    assert.equal(Number(req.headers["content-length"]), body.length);
    assert(!nonces.has(checked.protocol.oauth_nonce));
    nonces.add(checked.protocol.oauth_nonce);
    return false;
  };
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
    `root ${format} OAuth1 inheritance preserve/flatten definitions maintain source graph, no-auth boundaries and frozen restart execution`,
    { timeout: 45000 },
    async (t) => {
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const inspect = verifier(rsa.publicKey);
      let expected;
      const seen = [],
        errors = [];
      const peer = http.createServer(async (req, res) => {
        try {
          const handled = await inspect(req, res, expected);
          seen.push(new URL(req.url, "http://fixture").pathname);
          if (handled) return;
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        } catch (error) {
          errors.push(error.message);
          res.statusCode = 401;
          res.end("independent OAuth1 verification failed");
        }
      });
      await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
      const root = await mkdtemp(join(tmpdir(), "native-oauth1-inheritance-"));
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
      const first = await app.store.create("OAuth1 source graph");
      const imported = await call("/api/projects/" + first.id + "/import", {
        document,
        inheritanceMode: "preserve",
      });
      assert.deepEqual(fixture.document, original);
      assert.deepEqual(imported.settings.nativeInheritance.projectLayer.auth, {
        mode: "own",
        value: expected.get("project"),
      });
      const badSource = structuredClone(fixture.document);
      badSource.global.global_param.auth.oauth1.sessionState =
        "private-imported-prestate";
      const rejectedTarget = await app.store.create(
        "Reject native challenge state",
      );
      const rejectedBefore = await app.store.get(rejectedTarget.id);
      const rejection = await call(
        "/api/projects/" + rejectedTarget.id + "/import",
        {
          document:
            format === "apipost"
              ? badSource
              : nativeDirectoryFixture(badSource),
          inheritanceMode: "preserve",
        },
        "POST",
        400,
      );
      assert(!JSON.stringify(rejection).includes("private-imported-prestate"));
      assert(!Object.hasOwn(rejection, "apis"));
      assert(!Object.hasOwn(rejection, "files"));
      assert.deepEqual(await app.store.get(rejectedTarget.id), rejectedBefore);
      assert.equal(seen.length, 0);
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
      for (const name of ["own", "own-default"])
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
      const second = await app.store.create("OAuth1 preserved generation");
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
        consumerSecret: targetPassword,
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
      const flatBeforeOpenApi = await app.store.get(flat.id);
      const unsupported = await call(
        "/api/projects/" + flat.id + "/export?format=openapi",
        undefined,
        "GET",
        400,
      );
      assert(!Object.hasOwn(unsupported, "paths"));
      assert(!Object.hasOwn(unsupported, "components"));
      assert(!JSON.stringify(unsupported).includes("project-secret"));
      assert.deepEqual(await app.store.get(flat.id), flatBeforeOpenApi);
      assert.equal(seen.length, 0);
      // Flatten is an IMPORT option; there is no invented flatten export option.
      const flatExport = await call(
        "/api/projects/" + flat.id + "/export?format=" + format,
        undefined,
        "GET",
      );
      const flatAgainTarget = await app.store.create(
        "Flattened effective OAuth1 inverse",
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
        (await app.store.get(poisoned.id)).settings.globalAuth.consumerSecret,
        targetPassword,
      );
      const plan = await call("/api/projects/" + second.id + "/plans", {
        name: "Frozen inherited OAuth1",
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
      edited.settings.nativeInheritance.projectLayer.auth.value.consumerSecret =
        "later-live-project-password";
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
