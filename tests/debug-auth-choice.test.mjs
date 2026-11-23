import assert from "node:assert/strict";
import test from "node:test";
import { httpAuthPane, httpRequestAuthPane } from "../public/auth-view.js";
import { authTypes } from "../public/auth-model.js";
import {
  captureDebugAuthOperation,
  debugAuthChoice,
  debugAuthChoices,
  updateDebugAuthChoice,
  usesDebugAuthChoice,
} from "../public/debug-auth-choice.js";
import { normalizeRequest } from "../src/core.mjs";
import { applySharedAuth } from "../src/shared-auth.mjs";
import { openAPIAuthDefinition } from "../src/openapi-auth-definition.mjs";

const fixture = {
  id: "fixture",
  folder: "Accounts",
  url: "https://example.invalid/accounts",
};
const project = {
  settings: {
    globalAuth: { type: "bearer", token: "fictional-global" },
    folderAuth: { Accounts: { type: "basic", username: "fictional-folder" } },
  },
};

test("ordinary Design and Debug project the same available modes in native order", () => {
  assert.deepEqual(debugAuthChoices, [
    "inherit",
    "none",
    "apiKey",
    "basic",
    "bearer",
    "jwt",
    "digest",
    "oauth1",
    "oauth2",
    "hawk",
    "aws",
    "ntlm",
    "edgegrid",
    "asap",
  ]);
  assert.deepEqual(
    new Set(debugAuthChoices),
    new Set(["inherit", ...authTypes]),
  );
  const html = httpRequestAuthPane(normalizeRequest(fixture));
  assert.match(html, /value="inherit" selected>继承父级/);
  assert.match(html, /value="none">无需认证/);
  assert.doesNotMatch(html, /inherit-auth|data-auth=/);
  assert.match(
    httpRequestAuthPane({ auth: { type: "bearer", token: "<script>" } }),
    /data-auth="token"[^>]*value="&lt;script&gt;"[^>]*type="password"/,
  );
  const design = httpRequestAuthPane(normalizeRequest(fixture), "design");
  assert.match(design, /http-design-auth-pane/);
  assert.doesNotMatch(design, /inherit-auth|data-auth=/);
  assert.match(design, /value="inherit" selected>继承父级/);
  assert.match(httpAuthPane({ type: "none" }), /id="inherit-auth"/);
  assert.equal(
    usesDebugAuthChoice({ settings: { nativeInheritance: {} } }, {}),
    false,
  );
  assert.equal(usesDebugAuthChoice({}, { nativeInheritance: {} }), false);
});

test("inherit, explicit none and concrete override remain effective after normalization and definition export", () => {
  const request = normalizeRequest(fixture);
  const drafts = new Map();
  const view = () => normalizeRequest(structuredClone(request));
  const projected = () => applySharedAuth(project, view()).auth;
  const definition = () => openAPIAuthDefinition(project, view());
  assert.equal(debugAuthChoice(request), "inherit");
  assert.deepEqual(projected(), project.settings.folderAuth.Accounts);
  assert.deepEqual(Object.values(definition().securitySchemes), [
    { type: "http", scheme: "basic" },
  ]);

  updateDebugAuthChoice(request, "none", drafts);
  assert.equal(view().inheritAuth, false);
  assert.deepEqual(projected(), { type: "none" });
  assert.deepEqual(definition(), { security: [] });

  updateDebugAuthChoice(request, "bearer", drafts);
  request.auth.token = "fictional-request-token";
  assert.equal(
    view().inheritAuth,
    false,
    "concrete keeps the older underlying preference",
  );
  assert.deepEqual(projected(), {
    type: "bearer",
    token: "fictional-request-token",
  });
  assert.deepEqual(Object.values(definition().securitySchemes), [
    { type: "http", scheme: "bearer" },
  ]);
  assert.doesNotMatch(JSON.stringify(definition()), /fictional/);

  updateDebugAuthChoice(request, "inherit", drafts);
  assert.equal(view().inheritAuth, true);
  assert.deepEqual(projected(), project.settings.folderAuth.Accounts);
  assert.doesNotMatch(JSON.stringify(view()), /fictional-request-token/);
});

test("Debug drafts are isolated per auth type, retain source metadata, and never cross into execution", () => {
  const legacy = { type: "none", token: "fictional-legacy-inactive" };
  const request = normalizeRequest({ ...fixture, auth: legacy });
  const drafts = new Map();
  assert.deepEqual(
    request.auth,
    legacy,
    "viewing does not rewrite imported legacy fields",
  );
  updateDebugAuthChoice(request, "none", drafts);
  assert.deepEqual(request.auth, { type: "none" });
  updateDebugAuthChoice(request, "bearer", drafts);
  assert.deepEqual(request.auth, { type: "bearer" });
  request.auth.token = "bearer-only";
  updateDebugAuthChoice(request, "oauth2", drafts);
  assert.deepEqual(request.auth, { type: "oauth2" });
  request.auth.token = "oauth2-only";
  const restored = () => request.auth.token;
  updateDebugAuthChoice(request, "bearer", drafts);
  assert.equal(restored(), "bearer-only");
  updateDebugAuthChoice(request, "inherit", drafts);
  assert.deepEqual(request.auth, { type: "none" });
  assert.equal(
    applySharedAuth(project, request).auth.username,
    "fictional-folder",
  );
  updateDebugAuthChoice(request, "oauth2", drafts);
  assert.equal(restored(), "oauth2-only");
  assert.throws(
    () => updateDebugAuthChoice(request, "__proto__", drafts),
    /不受支持/,
  );
});

test("frozen none never inherits and in-flight authentication is fenced to the exact owner and policy", () => {
  const request = normalizeRequest({ ...fixture, authSnapshot: true });
  const drafts = new Map();
  assert.equal(debugAuthChoice(request), "none");
  assert.match(httpRequestAuthPane(request), /value="inherit" disabled/);
  assert.match(httpRequestAuthPane(request), /认证已固定/);
  assert.throws(
    () => updateDebugAuthChoice(request, "inherit", drafts),
    /认证已固定/,
  );
  assert.deepEqual(applySharedAuth(project, request).auth, { type: "none" });
  assert.deepEqual(openAPIAuthDefinition(project, request), { security: [] });
  assert.equal(updateDebugAuthChoice(request, "none", drafts), false);
  assert.equal(
    request.inheritAuth,
    true,
    "no-op does not silently rewrite legacy data",
  );
  updateDebugAuthChoice(request, "oauth2", drafts);
  const owns = captureDebugAuthOperation(project, request);
  assert(owns(project, request));
  assert(!owns({}, request));
  assert(!owns(project, structuredClone(request)));
  request.inheritAuth = false;
  assert(!owns(project, request));
  request.inheritAuth = true;
  request.auth.clientId = "different";
  assert(!owns(project, request));
  delete request.auth.clientId;
  updateDebugAuthChoice(request, "none", drafts);
  updateDebugAuthChoice(request, "oauth2", drafts);
  assert(
    !owns(project, request),
    "a switch away and back replaces the auth owner even with identical data",
  );
  assert.equal(request.authSnapshot, true);
});

test("ordinary Key/Basic fields have associated labels and hide private values without rewriting imported options", () => {
  const key = httpRequestAuthPane(
    {
      auth: {
        type: "apiKey",
        key: "X-Demo",
        value: "<unsafe>",
        in: "query",
        queryEncoding: "apipost",
      },
    },
    "design",
  );
  assert.match(key, /for="http-auth-api-key-key">Key/);
  assert.match(key, /data-auth="value" value="&lt;unsafe&gt;" type="password"/);
  assert.match(key, /value="header" disabled>Header/);
  assert.match(key, /value="query" selected>Query Params/);
  const basic = httpRequestAuthPane({ auth: { type: "basic" } });
  assert.match(basic, /for="http-auth-basic-username">Username/);
  assert.match(basic, /data-auth="password"[^>]*type="password"/);
  assert.match(basic, /用户名（支持变量）/);
  assert.match(basic, /密码（支持变量）/);
});
