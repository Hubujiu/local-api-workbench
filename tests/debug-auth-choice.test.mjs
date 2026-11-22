import assert from "node:assert/strict";
import test from "node:test";
import { httpAuthPane, httpDebugAuthPane } from "../public/auth-view.js";
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

test("Debug picker projects real modes in native order and leaves the Design editor separate", () => {
  assert.deepEqual(debugAuthChoices.slice(0, 8), [
    "inherit",
    "none",
    "apiKey",
    "basic",
    "bearer",
    "jwt",
    "digest",
    "oauth1",
  ]);
  assert.deepEqual(
    new Set(debugAuthChoices),
    new Set(["inherit", ...authTypes]),
  );
  const html = httpDebugAuthPane(normalizeRequest(fixture));
  assert.match(html, /value="inherit" selected>继承父级/);
  assert.match(html, /value="none">无需认证/);
  assert.doesNotMatch(html, /inherit-auth|data-auth=/);
  assert.match(
    httpDebugAuthPane({ auth: { type: "bearer", token: "<script>" } }),
    /data-auth="token"[^>]*value="&lt;script&gt;"[^>]*type="password"/,
  );
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
  updateDebugAuthChoice(request, "none", drafts);
  assert.deepEqual(request.auth, legacy);
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
  assert.deepEqual(request.auth, legacy);
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
  assert.match(httpDebugAuthPane(request), /value="inherit" disabled/);
  assert.match(httpDebugAuthPane(request), /认证已固定/);
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
