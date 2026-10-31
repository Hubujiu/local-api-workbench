import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRequest,
  snapshotPlan,
  runPlan,
  interpolate,
  toCurl,
  exportOpenAPI,
} from "../src/core.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import {
  applySharedAuth,
  validateSharedAuthSettings,
} from "../src/shared-auth.mjs";

test("native OAuth2 selected-only resolution keeps inert lifecycle templates byte-for-byte", async () => {
  for (const scriptURLMode of ["string", "sdk"]) {
    for (const [
      addTokenTo,
      access_token,
      headerPrefix,
      variables,
      expected,
    ] of [
      [
        "header",
        "{{token}}",
        "{{prefix}}",
        { token: "ok", prefix: "Custom" },
        ["ok", "Custom"],
      ],
      [
        "queryParams",
        "{{token}}",
        "{{unused}}",
        { token: "ok" },
        ["ok", "{{unused}}"],
      ],
      ["header", "{{token}}", "{{unused}}", { token: "" }, ["", "{{unused}}"]],
      ["", "{{unused}}", "{{unused}}", {}, ["{{unused}}", "{{unused}}"]],
    ]) {
      const request = normalizeRequest({
        url: "http://example.invalid/path?raw=%2f",
        scriptURLMode,
        auth: {
          type: "oauth2",
          nativeOAuth2: {
            addTokenTo,
            access_token,
            headerPrefix,
            clientSecret: "{{missing}}",
            state: "{{$randomUUID}}",
            authUrl: "{{missing}}",
            tokenRequestParams: [
              { unknown: "{{missing}}", value: "{{$randomUUID}}" },
            ],
          },
        },
      });
      const before = structuredClone(request),
        resolved = await resolveDynamicRequest(
          request,
          variables,
          [],
          interpolate,
        );
      assert.equal(resolved.auth.nativeOAuth2.access_token, expected[0]);
      assert.equal(resolved.auth.nativeOAuth2.headerPrefix, expected[1]);
      for (const key of [
        "clientSecret",
        "state",
        "authUrl",
        "tokenRequestParams",
      ])
        assert.deepEqual(
          resolved.auth.nativeOAuth2[key],
          request.auth.nativeOAuth2[key],
        );
      assert.deepEqual(request, before);
    }
  }
});
test("native OAuth2 resolver, shared and disabled plan admission run before getters or execution", async () => {
  let calls = 0,
    executions = 0;
  const definition = {};
  Object.defineProperty(definition, "access_token", {
    enumerable: true,
    get() {
      calls++;
      return "secret";
    },
  });
  const request = {
    url: "http://example.invalid",
    auth: { type: "oauth2", nativeOAuth2: definition },
  };
  assert.throws(() => normalizeRequest(request), /原生 OAuth2/);
  assert.throws(
    () => applySharedAuth({ settings: {} }, request),
    /原生 OAuth2/,
  );
  assert.throws(
    () => validateSharedAuthSettings({ folderAuth: { A: request.auth } }),
    /原生 OAuth2/,
  );
  for (const scriptURLMode of ["string", "sdk"])
    await assert.rejects(
      resolveDynamicRequest({ ...request, scriptURLMode }, {}, [], interpolate),
      /原生 OAuth2/,
    );
  const plan = { steps: [{ enabled: false, request }] };
  assert.throws(() => snapshotPlan(plan), /原生 OAuth2/);
  await assert.rejects(
    runPlan(plan, {}, () => {
      executions++;
    }),
    /原生 OAuth2/,
  );
  assert.throws(() => toCurl(request), /原生 OAuth2/);
  assert.equal(calls, 0);
  assert.equal(executions, 0);
});
test("native OAuth2 cURL projection shares exact encoding and rejects unresolved active tokens", () => {
  const query = normalizeRequest({
    url: "https://example.invalid/%2f?access_token=old",
    auth: {
      type: "oauth2",
      nativeOAuth2: {
        addTokenTo: "queryParams",
        access_token: "a+b%2f &雪#=",
        clientSecret: "{{unused}}",
      },
    },
  });
  const curl = toCurl(query);
  assert(
    curl.includes(
      "https://example.invalid/%2f?access_token=old&access_token=a+b%2f%20%26%E9%9B%AA%23=",
    ),
  );
  assert(!curl.includes("Bearer"));
  assert(!curl.includes("{{unused}}"));
  const header = normalizeRequest({
    url: "https://example.invalid",
    auth: {
      type: "oauth2",
      nativeOAuth2: {
        addTokenTo: "header",
        access_token: "ok",
        headerPrefix: "Custom",
      },
    },
  });
  assert(toCurl(header).includes("authorization: Custom ok"));
  header.auth.nativeOAuth2.access_token = "{{token}}";
  assert.throws(() => toCurl(header), /原生 OAuth2/);
});

test("native OAuth2 OpenAPI refuses lossy own/shared definitions before mutating source", () => {
  const native = {
    type: "oauth2",
    nativeOAuth2: {
      addTokenTo: "header",
      access_token: "private-token",
      clientSecret: "{{metadata}}",
    },
  };
  for (const mode of ["own", "global", "folder"]) {
    const project = {
      name: "Fixture",
      requests: [
        normalizeRequest({
          url: "https://example.invalid",
          auth: mode === "own" ? native : { type: "none" },
        }),
      ],
      settings:
        mode === "global"
          ? { globalAuth: native }
          : mode === "folder"
            ? { folderAuth: { A: native } }
            : {},
    };
    const before = structuredClone(project);
    assert.throws(
      () => exportOpenAPI(project),
      (error) =>
        error.message === "OpenAPI不能保留原生 OAuth2 定义，请使用项目备份",
    );
    assert.deepEqual(project, before);
  }
});
