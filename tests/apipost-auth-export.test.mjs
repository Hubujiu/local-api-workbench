import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { exportExtendedApipostAuth } from "../src/apipost-auth-export.mjs";
import { importExtendedApipostAuth } from "../src/apipost-auth-import.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";
const sha = (v, encoding = "hex", algorithm = "sha256") =>
  createHash(algorithm).update(v).digest(encoding);
const mac = (k, v, encoding, algorithm = "sha256") =>
  createHmac(algorithm, k).update(v).digest(encoding);
const uri = (v) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const credentials = [
  {
    type: "awsv4",
    awsv4: {
      accessKey: "fictional-access",
      secretKey: "fictional-secret",
      sessionToken: "fictional-token",
      region: "us-east-1",
      service: "execute-api",
      addAuthDataToQuery: false,
    },
  },
  {
    type: "awsv4",
    awsv4: {
      accessKey: "fictional-access",
      secretKey: "fictional-secret",
      sessionToken: "fictional-token",
      region: "us-east-1",
      service: "s3",
      addAuthDataToQuery: true,
    },
  },
  {
    type: "hawk",
    hawk: {
      authId: "fictional-id",
      authKey: "fictional-key",
      algorithm: "sha256",
      includePayloadHash: true,
      nonce: "fixture-nonce",
      timestamp: "1700000000",
      extraData: "fixture-ext",
      app: "fixture-app",
      delegation: "fixture-dlg",
      user: "",
    },
  },
  {
    type: "hawk",
    hawk: {
      authId: "fictional-id",
      authKey: "fictional-key",
      algorithm: "sha1",
      includePayloadHash: false,
      nonce: "fixture-nonce",
      timestamp: "1700000000",
    },
  },
  {
    type: "edgegrid",
    edgegrid: {
      clientToken: "fictional-client",
      clientSecret: "fictional-secret",
      accessToken: "fictional-access",
      baseURi: "http://signing-origin.example:8080",
      headersToSign: "X-Proof,Content-Type",
      nonce: "fixture-nonce",
      timestamp: "20231025T12:00:00+0000",
    },
  },
  {
    type: "hawk",
    hawk: {
      authId: "fictional-default-id",
      authKey: "fictional-default-key",
      algorithm: "sha256",
      includePayloadHash: true,
      nonce: "default-nonce",
      timestamp: "1700000001",
    },
  },
];
// Independent wire verifiers: no production signer, native mapper, or SDK signer.
function verify(req, body, base) {
  const url = new URL(req.url, base),
    index = Number(url.pathname.slice(1)),
    h = req.headers;
  assert(index >= 0 && index < credentials.length);
  const a = credentials[index];
  if (a.type === "awsv4") {
    const query = index === 1;
    const signed = query
      ? url.searchParams.get("X-Amz-SignedHeaders")
      : /SignedHeaders=([^,]+)/.exec(h.authorization)?.[1];
    const credential = query
      ? url.searchParams.get("X-Amz-Credential")
      : /Credential=([^,]+)/.exec(h.authorization)?.[1];
    const signature = query
      ? url.searchParams.get("X-Amz-Signature")
      : /Signature=(\w+)/.exec(h.authorization)?.[1];
    assert.equal(credential.split("/")[0], a.awsv4.accessKey);
    const stamp = query ? url.searchParams.get("X-Amz-Date") : h["x-amz-date"],
      scope = credential.split("/").slice(1).join("/");
    assert.equal(
      query
        ? url.searchParams.get("X-Amz-Security-Token")
        : h["x-amz-security-token"],
      a.awsv4.sessionToken,
    );
    if (query) {
      assert.equal(h.authorization, undefined);
      assert.equal(req.method, "GET");
    }
    const pairs = [...url.searchParams]
      .filter(([k]) => k !== "X-Amz-Signature")
      .map(([k, v]) => [uri(k), uri(v)])
      .sort((a, b) =>
        a[0] < b[0]
          ? -1
          : a[0] > b[0]
            ? 1
            : a[1] < b[1]
              ? -1
              : a[1] > b[1]
                ? 1
                : 0,
      );
    const canonical = [
      req.method,
      url.pathname,
      pairs.map(([k, v]) => k + "=" + v).join("&"),
      signed
        .split(";")
        .map((k) => k + ":" + h[k].trim().replace(/\s+/g, " ") + "\n")
        .join(""),
      signed,
      query ? "UNSIGNED-PAYLOAD" : sha(body),
    ].join("\n");
    const [date, region, service, terminator] = scope.split("/");
    assert.equal(date, stamp.slice(0, 8));
    assert.equal(region, a.awsv4.region);
    assert.equal(service, a.awsv4.service);
    assert.equal(terminator, "aws4_request");
    assert.match(stamp, /^\d{8}T\d{6}Z$/);
    const key = mac(
      mac(mac(mac("AWS4" + a.awsv4.secretKey, date), region), service),
      "aws4_request",
    );
    assert.equal(
      signature,
      mac(
        key,
        ["AWS4-HMAC-SHA256", stamp, scope, sha(canonical)].join("\n"),
        "hex",
      ),
    );
  } else if (a.type === "hawk") {
    assert.match(h.authorization, /^Hawk /);
    const fields = Object.fromEntries(
      [...h.authorization.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    assert.equal(fields.id, a.hawk.authId);
    assert.equal(fields.ts, a.hawk.timestamp);
    assert.equal(fields.nonce, a.hawk.nonce);
    assert.equal(fields.ext || "", a.hawk.extraData || "");
    assert.equal(fields.app || "", a.hawk.app || "");
    assert.equal(fields.dlg || "", a.hawk.delegation || "");
    const payload = a.hawk.includePayloadHash
      ? sha(
          "hawk.1.payload\n" +
            (h["content-type"] || "").split(";")[0].trim().toLowerCase() +
            "\n" +
            body +
            "\n",
          "base64",
          a.hawk.algorithm,
        )
      : "";
    assert.equal(fields.hash || "", payload);
    let normalized =
      [
        "hawk.1.header",
        fields.ts,
        fields.nonce,
        req.method,
        url.pathname + url.search,
        url.hostname,
        url.port,
        payload,
        fields.ext || "",
      ].join("\n") + "\n";
    if (fields.app) normalized += fields.app + "\n" + (fields.dlg || "") + "\n";
    assert.equal(
      fields.mac,
      mac(a.hawk.authKey, normalized, "base64", a.hawk.algorithm),
    );
  } else {
    const prefix = h.authorization.slice(
      0,
      h.authorization.indexOf("signature="),
    );
    assert(prefix.includes("client_token=" + a.edgegrid.clientToken + ";"));
    assert(prefix.includes("access_token=" + a.edgegrid.accessToken + ";"));
    const stamp = /timestamp=([^;]+);/.exec(prefix)[1];
    assert.equal(stamp, a.edgegrid.timestamp);
    assert.equal(/nonce=([^;]+);/.exec(prefix)[1], a.edgegrid.nonce);
    assert.equal(h.host, new URL(base).host);
    const headers = ["x-proof", "content-type"]
      .map((k) => k + ":" + h[k].trim().replace(/\s+/g, " "))
      .join("\t");
    const canonical = [
      req.method,
      "http",
      a.edgegrid.baseURi ? new URL(a.edgegrid.baseURi).host : url.host,
      url.pathname + url.search,
      headers,
      sha(body, "base64"),
      prefix,
    ].join("\t");
    assert.equal(
      h.authorization.slice(prefix.length),
      "signature=" +
        mac(mac(a.edgegrid.clientSecret, stamp, "base64"), canonical, "base64"),
    );
  }
  assert.equal(h["x-proof"], "signed-definition");
  return index;
}
function fixture(base) {
  const doc = modernApipostFixture(),
    template = structuredClone(doc.apis[1]);
  doc.global.envs[0].server_list[0].uri = base;
  doc.global.envs[0].env_var_list.awsSecret = {
    value: "initial-fictional-secret",
    current_value: "fictional-secret",
  };
  doc.apis = [
    doc.apis[0],
    ...credentials.map((auth, i) => {
      const api = structuredClone(template);
      api.target_id = "signed-" + i;
      api.name = "Signed " + i;
      api.url = base + "/" + i + "?a=2&a=1";
      api.method = i === 1 ? "GET" : "POST";
      api.request.auth = structuredClone(auth);
      if (i === 0) api.request.auth.awsv4.secretKey = "{{awsSecret}}";
      api.request.query.parameter = [];
      api.request.header.parameter = [
        { key: "X-Proof", value: "signed-definition", is_checked: 1 },
      ];
      api.request.body =
        i === 1
          ? { mode: "none" }
          : {
              mode: "json",
              raw: '{"proof":"雪"}',
              parameter: [],
              raw_parameter: [],
              raw_schema: {},
            };
      return api;
    }),
  ];
  return doc;
}

test("native signing definitions export without changing explicit or default behavior and reject unmapped data", () => {
  for (const native of credentials) {
    const imported = importExtendedApipostAuth(native);
    assert.deepEqual(
      importExtendedApipostAuth(exportExtendedApipostAuth(imported)),
      imported,
    );
  }
  const defaultHawk = exportExtendedApipostAuth({
    type: "hawk",
    id: "id",
    key: "key",
  });
  assert.equal(defaultHawk.hawk.algorithm, "sha256");
  assert.equal(defaultHawk.hawk.includePayloadHash, true);
  assert.equal(
    exportExtendedApipostAuth({
      type: "hawk",
      id: "id",
      key: "key",
      payloadHash: "disabled",
    }).hawk.includePayloadHash,
    false,
  );
  for (const auth of [
    {
      ...importExtendedApipostAuth(credentials[0]),
      signingDate: "2020-01-01T00:00:00Z",
    },
    { ...importExtendedApipostAuth(credentials[4]), maxBodySize: 131072 },
    {
      ...importExtendedApipostAuth(credentials[4]),
      headersToSign: ["x-proof"],
    },
    { ...importExtendedApipostAuth(credentials[2]), timestamp: 1700000000 },
    { ...importExtendedApipostAuth(credentials[2]), payloadHash: "maybe" },
    { ...importExtendedApipostAuth(credentials[0]), extra: "do not drop" },
    { ...importExtendedApipostAuth(credentials[0]), addAuthDataToQuery: true },
  ])
    assert.throws(() => exportExtendedApipostAuth(auth));
});

test("owner signed HTTP import dual export/reimport frozen execution live edits restore restart and isolation", async (t) => {
  const seen = [],
    errors = [];
  let base;
  const wire = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      seen.push(verify(req, body, base));
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    } catch (e) {
      errors.push(e.message);
      res.statusCode = 401;
      res.end(e.message);
    }
  });
  await new Promise((r) => wire.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${wire.address().port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "signing-export-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await stop();
    wire.closeAllConnections();
    await new Promise((r) => wire.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, method = "GET", body, expected = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  const other = await app.store.create("untouched"),
    otherBefore = await app.store.get(other.id);
  for (const inputFormat of ["json", "directory"]) {
    const native = fixture(base),
      document =
        inputFormat === "json" ? native : nativeDirectoryFixture(native),
      original = structuredClone(document);
    const project = await app.store.create("source " + inputFormat);
    let source = await call(`/api/projects/${project.id}/import`, "POST", {
      document,
    });
    // A normal Workbench edit removes default fields. Export must make both
    // defaults explicit rather than importing native omission as hash-disabled.
    delete source.requests[5].auth.algorithm;
    delete source.requests[5].auth.payloadHash;
    await call(`/api/projects/${project.id}`, "PUT", source);
    source = await app.store.get(project.id);
    const expectedAuth = source.requests.map((r, i) =>
      i === 5
        ? { ...r.auth, algorithm: "sha256", payloadHash: "enabled" }
        : r.auth,
    );
    assert.equal(source.requests[0].auth.secretKey, "{{awsSecret}}");
    const before = structuredClone(source),
      count = seen.length;
    for (const format of ["apipost", "apipost-directory"]) {
      const route = `/api/projects/${project.id}/export?format=${format}`;
      assert.equal((await fetch(app.url + route)).status, 403);
      const output = await call(route);
      assert.equal(seen.length, count);
      const target = await app.store.create("target " + format);
      const imported = await call(`/api/projects/${target.id}/import`, "POST", {
        document: output,
      });
      assert.equal(seen.length, count);
      assert.deepEqual(
        imported.requests.map((r) => r.auth),
        expectedAuth,
      );
      const second = await call(
        `/api/projects/${target.id}/export?format=${format}`,
      );
      assert.equal(seen.length, count);
      const secondTarget = await app.store.create("second");
      const again = await call(
        `/api/projects/${secondTarget.id}/import`,
        "POST",
        { document: second },
      );
      assert.deepEqual(
        again.requests.map((r) => r.auth),
        expectedAuth,
      );
      const plan = await call(`/api/projects/${target.id}/plans`, "POST", {
        statusPolicy: "strict200",
        environmentId: imported.environments.find((e) => e.name === "Imported")
          .id,
        steps: imported.requests.map((request) => ({ request })),
      });
      const edited = await app.store.get(target.id);
      for (const request of edited.requests)
        request.auth = { type: "bearer", token: "later-live-edit" };
      await call(`/api/projects/${target.id}`, "PUT", edited);
      const run = await call(`/api/projects/${target.id}/run`, "POST", {
        planId: plan.id,
      });
      assert.equal(run.status, "passed", JSON.stringify({ run, errors }));
      assert.deepEqual(seen.slice(-6), [0, 1, 2, 3, 4, 5]);
      const backup = await call(`/api/projects/${target.id}/export`),
        restored = await call(
          "/api/restore",
          "POST",
          { document: backup },
          201,
        );
      await stop();
      app = await createApp({ root, port: 0 });
      const disk = await app.store.get(restored.id);
      assert.deepEqual(
        disk.plans[0].steps.map((s) => s.request.auth),
        expectedAuth,
      );
      const rerun = await call(`/api/projects/${restored.id}/run`, "POST", {
        planId: disk.plans[0].id,
      });
      assert.equal(rerun.status, "passed", JSON.stringify({ rerun, errors }));
      assert.deepEqual(seen.slice(-6), [0, 1, 2, 3, 4, 5]);
      // Reset the no-network counter only after explicit separately authorized runs.
      seen.splice(count);
    }
    assert.deepEqual(await app.store.get(project.id), before);
    const invalid = structuredClone(source);
    invalid.requests[0].auth.signingDate = "2020-01-01T00:00:00Z";
    await call(`/api/projects/${project.id}`, "PUT", invalid);
    const invalidSaved = await app.store.get(project.id);
    for (const format of ["apipost", "apipost-directory"])
      await call(
        `/api/projects/${project.id}/export?format=${format}`,
        "GET",
        undefined,
        400,
      );
    assert.deepEqual(await app.store.get(project.id), invalidSaved);
    assert.equal(seen.length, count);
    assert.deepEqual(document, original);
  }
  assert.deepEqual(await app.store.get(other.id), otherBefore);
  assert.deepEqual(errors, []);
});
