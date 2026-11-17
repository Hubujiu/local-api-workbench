// Root-only native inheritance integration; Workbench signing is independently
// verified without running the original application or a production signer oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";

const targetPassword = "target-password-must-not-leak";
const entity = "inheritance raw \0 雪\r\n";
function canonical(n) {
  return {
    type: "digest",
    username: n.username,
    password: n.password ?? "",
    challengePolicy: {
      algorithm: n.algorithm || "MD5",
      retry: !(n.disableRetryRequest ?? false),
    },
  };
}
function source(base) {
  const document = nativeInheritanceFixture();
  document.global.envs[0].server_list[0].uri = base;
  const native = (username, algorithm) => ({
    username,
    password: username + "-private-password",
    realm: "",
    nonce: "",
    algorithm,
    qop: "",
    nc: "",
    cnonce: "",
    opaque: "",
    disableRetryRequest: false,
  });
  const projectDigest = native("project", "MD5");
  delete projectDigest.algorithm;
  delete projectDigest.disableRetryRequest;
  const folderDigest = native("folder", "SHA-256-sess"),
    ownDigest = native("own", "SHA-512-256-sess"),
    ownDefault = native("own-default", "MD5-sess");
  const envelope = (digest) => ({
    type: "digest",
    digest: structuredClone(digest),
  });
  document.global.global_param.auth = envelope(projectDigest);
  const template = structuredClone(document.apis[1]);
  const folder = (id, name, parent, auth) => ({
    target_id: id,
    target_type: "folder",
    name,
    parent_id: parent,
    request: { auth },
  });
  const expected = new Map([
    ["project", canonical(projectDigest)],
    ["folder", canonical(folderDigest)],
    ["own", canonical(ownDigest)],
    ["own-default", canonical(ownDefault)],
    ["noauth", null],
    ["disabled-parent", null],
    ["absent", canonical(folderDigest)],
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
    node.request.body = { mode: "plain", raw: entity };
    if (auth === undefined) delete node.request.auth;
    else node.request.auth = auth;
    return node;
  };
  document.apis = [
    folder("signing-folder", "Signing folder", "0", envelope(folderDigest)),
    folder("disabled-folder", "Disabled", "signing-folder", { type: "noauth" }),
    api("project", "0", { type: "inherit" }),
    api("folder", "signing-folder", { type: "inherit" }),
    api("own", "signing-folder", envelope(ownDigest)),
    api("own-default", "0", envelope(ownDefault)),
    api("noauth", "signing-folder", { type: "noauth" }),
    api("disabled-parent", "disabled-folder", { type: "inherit" }),
    api("absent", "signing-folder", undefined),
  ];
  return { document, expected };
}
function nativeDefinition(auth) {
  return {
    type: "digest",
    digest: {
      username: auth.username,
      password: auth.password,
      realm: "",
      nonce: "",
      algorithm: auth.challengePolicy.algorithm,
      qop: "",
      nc: "",
      cnonce: "",
      opaque: "",
      disableRetryRequest: !auth.challengePolicy.retry,
    },
  };
}
function verifier() {
  const challenges = new Map(),
    cnonces = new Set();
  let serial = 0;
  return async (req, res, expected) => {
    const url = new URL(req.url, "http://fixture"),
      name = url.pathname.slice(1);
    assert(expected.has(name));
    assert.equal(url.search, "?untouched=yes");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    assert.deepEqual(body, Buffer.from(entity));
    const auth = expected.get(name);
    if (!auth) {
      assert.equal(
        req.headers.authorization,
        undefined,
        "explicit noauth stops source and target inheritance",
      );
      return false;
    }
    const algorithm = auth.challengePolicy.algorithm;
    if (!req.headers.authorization) {
      const nonce = "inheritance-" + ++serial;
      challenges.set(nonce, {
        url: req.url,
        body,
        type: req.headers["content-type"],
        length: req.headers["content-length"],
      });
      res.writeHead(401, {
        "WWW-Authenticate": `Digest realm="fixture",nonce="${nonce}",algorithm=${algorithm},qop="auth-int"`,
      });
      res.end("challenge");
      return true;
    }
    assert(req.headers.authorization.startsWith("Digest "));
    const p = Object.fromEntries(
      [
        ...req.headers.authorization.matchAll(
          /([\w-]+)=(?:"([^"]*)"|([^,\s]+))/g,
        ),
      ].map((m) => [m[1], m[2] ?? m[3]]),
    );
    const first = challenges.get(p.nonce);
    assert(
      first,
      "every execution starts unauthenticated with a fresh challenge",
    );
    challenges.delete(p.nonce);
    assert.equal(first.url, req.url);
    assert.deepEqual(first.body, body);
    assert.equal(first.type, req.headers["content-type"]);
    assert.equal(first.length, req.headers["content-length"]);
    assert.equal(p.username, auth.username);
    assert.equal(p.algorithm.toUpperCase(), algorithm.toUpperCase());
    assert.equal(p.qop, "auth-int");
    assert.equal(p.uri, req.url);
    assert.equal(p.nc, "00000001");
    assert(p.cnonce);
    assert(!cnonces.has(p.cnonce));
    cnonces.add(p.cnonce);
    const hash = (value) =>
      createHash(
        { MD5: "md5", "SHA-256": "sha256", "SHA-512-256": "sha512-256" }[
          algorithm.replace(/-sess$/i, "")
        ],
      )
        .update(value)
        .digest("hex");
    let ha1 = hash(auth.username + ":fixture:" + auth.password);
    if (algorithm.endsWith("-sess"))
      ha1 = hash(ha1 + ":" + p.nonce + ":" + p.cnonce);
    assert.equal(
      p.response,
      hash(
        [
          ha1,
          p.nonce,
          p.nc,
          p.cnonce,
          "auth-int",
          hash(req.method + ":" + req.url + ":" + hash(body)),
        ].join(":"),
      ),
    );
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
    `root ${format} Digest inheritance preserve/flatten definitions maintain source graph, no-auth boundaries and frozen restart execution`,
    { timeout: 45000 },
    async (t) => {
      const inspect = verifier();
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
          res.end("independent Digest verification failed");
        }
      });
      await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
      const root = await mkdtemp(join(tmpdir(), "native-digest-inheritance-"));
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
      const fixture = source("http://127.0.0.1:" + peer.address().port);
      expected = fixture.expected;
      const original = structuredClone(fixture.document);
      const document =
        format === "apipost"
          ? fixture.document
          : nativeDirectoryFixture(fixture.document);
      const first = await app.store.create("Digest source graph");
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
      badSource.global.global_param.auth.digest.nonce =
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
      const second = await app.store.create("Digest preserved generation");
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
        password: targetPassword,
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
        "Flattened effective Digest inverse",
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
        assert.equal(seen.length, count + 12);
      }
      for (const project of [preserved, flat, flatAgain, isolatedFlat])
        await executeAll(project);
      assert.equal(
        (await app.store.get(poisoned.id)).settings.globalAuth.password,
        targetPassword,
      );
      const plan = await call("/api/projects/" + second.id + "/plans", {
        name: "Frozen inherited Digest",
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
      edited.settings.nativeInheritance.projectLayer.auth.value.password =
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
      assert.equal(seen.length, 72);
      assert.deepEqual(errors, []);
      assert.deepEqual(graphIntent(await app.store.get(first.id)), graph);
    },
  );
}
