// Root-only native inheritance integration; Workbench signing is independently
// verified without running the original application or a production signer oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
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
    type: "ntlm",
    username: n.username,
    password: n.password ?? "",
    domain: n.domain ?? "",
    workstation: n.workstation ?? "",
  };
}
function source(base) {
  const document = nativeInheritanceFixture();
  document.global.envs[0].server_list[0].uri = base;
  const native = (workstation) => ({
    username: "User",
    password: "Password",
    domain: "Domain",
    workstation,
    disableRetryRequest: false,
  });
  const projectNtlm = native("PROJECT");
  delete projectNtlm.disableRetryRequest;
  const folderNtlm = native("FOLDER"),
    ownNtlm = native("OWN"),
    ownDefault = native("");
  delete ownDefault.workstation;
  const envelope = (ntlm) => ({ type: "ntlm", ntlm: structuredClone(ntlm) });
  document.global.global_param.auth = envelope(projectNtlm);
  const template = structuredClone(document.apis[1]);
  const folder = (id, name, parent, auth) => ({
    target_id: id,
    target_type: "folder",
    name,
    parent_id: parent,
    request: { auth },
  });
  const expected = new Map([
    ["project", canonical(projectNtlm)],
    ["folder", canonical(folderNtlm)],
    ["own", canonical(ownNtlm)],
    ["own-default", canonical(ownDefault)],
    ["noauth", null],
    ["disabled-parent", null],
    ["absent", canonical(folderNtlm)],
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
    folder("signing-folder", "Signing folder", "0", envelope(folderNtlm)),
    folder("disabled-folder", "Disabled", "signing-folder", { type: "noauth" }),
    api("project", "0", { type: "inherit" }),
    api("folder", "signing-folder", { type: "inherit" }),
    api("own", "signing-folder", envelope(ownNtlm)),
    api("own-default", "0", envelope(ownDefault)),
    api("noauth", "signing-folder", { type: "noauth" }),
    api("disabled-parent", "disabled-folder", { type: "inherit" }),
    api("absent", "signing-folder", undefined),
  ];
  return { document, expected };
}
function nativeDefinition(auth) {
  return {
    type: "ntlm",
    ntlm: {
      username: auth.username,
      password: auth.password,
      domain: auth.domain,
      workstation: auth.workstation,
      disableRetryRequest: false,
    },
  };
}
function verifier() {
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
  return async (req, res, expected) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    assert.deepEqual(body, Buffer.from(entity));
    const url = new URL(req.url, "http://fixture"),
      name = url.pathname.slice(1);
    assert.equal(url.search, "?untouched=yes");
    assert(expected.has(name));
    const auth = expected.get(name);
    if (!auth) {
      assert.equal(
        req.headers.authorization,
        undefined,
        "explicit noauth stops source and target inheritance",
      );
      return false;
    }

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
      assert.equal(
        field(token, 16).toString("ascii"),
        auth.domain.toUpperCase(),
      );
      assert.equal(
        field(token, 24).toString("ascii"),
        auth.workstation.toUpperCase(),
      );
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
      response.writeUInt32LE(0xa0888205, 20);
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
    assert.equal(field(token, 28).toString("utf16le"), auth.domain);
    assert.equal(field(token, 36).toString("utf16le"), auth.username);
    assert.equal(field(token, 44).toString("utf16le"), auth.workstation);
    const nt = field(token, 20),
      blob = nt.subarray(16),
      proof = hmac(Buffer.concat([first.nonce, blob]));
    assert(blob.length >= 32);
    assert.equal(blob.readUInt32LE(0), 0x101);
    const clientNonce = blob.subarray(16, 24).toString("hex");
    assert(!clientNonces.has(clientNonce));
    clientNonces.add(clientNonce);
    assert.deepEqual(blob.subarray(28, 28 + targetInfo.length), targetInfo);
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
    `root ${format} NTLM inheritance preserve/flatten definitions maintain source graph, no-auth boundaries and frozen restart execution`,
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
          res.end("independent NTLM verification failed");
        }
      });
      await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
      const root = await mkdtemp(join(tmpdir(), "native-ntlm-inheritance-"));
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
      const first = await app.store.create("NTLM source graph");
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
      badSource.global.global_param.auth.ntlm.entity =
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
      const second = await app.store.create("NTLM preserved generation");
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
        "Flattened effective NTLM inverse",
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
        name: "Frozen inherited NTLM",
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
