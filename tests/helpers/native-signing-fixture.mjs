import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { modernApipostFixture } from "../fixtures/apipost-modern.mjs";
const sha = (v, encoding = "hex", algorithm = "sha256") =>
  createHash(algorithm).update(v).digest(encoding);
const mac = (k, v, encoding, algorithm = "sha256") =>
  createHmac(algorithm, k).update(v).digest(encoding);
const uri = (v) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export const credentials = [
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
export function verify(req, body, base) {
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
export function fixture(base) {
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
