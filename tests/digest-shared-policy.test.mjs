import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSharedAuthSettings,
  renameSharedAuthScopes,
} from "../public/shared-auth.js";
import { applySharedAuth } from "../src/shared-auth.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { versionPlan } from "../src/plan-version.mjs";
const algorithms = [
  "MD5",
  "MD5-sess",
  "SHA-256",
  "SHA-256-sess",
  "SHA-512-256",
  "SHA-512-256-sess",
];
const auth = (algorithm = "SHA-256", retry = true) => ({
  type: "digest",
  username: "{{user}}",
  password: "{{password}}",
  challengePolicy: { algorithm, retry },
});
test("shared Digest accepts exactly the validated nested policy without mutating definitions", () => {
  for (const algorithm of algorithms)
    for (const retry of [false, true]) {
      const settings = {
        globalAuth: auth(algorithm, retry),
        folderAuth: { Private: auth(algorithm, retry) },
      };
      const before = structuredClone(settings);
      validateSharedAuthSettings(settings);
      assert.deepEqual(settings, before);
      assert.deepEqual(
        renameSharedAuthScopes(settings, "Private", "Renamed").Renamed,
        settings.folderAuth.Private,
      );
    }
});
test("shared Digest still rejects malformed policies and all other nested fields", () => {
  const invalid = [
    null,
    [],
    {},
    { algorithm: "SHA-256" },
    { algorithm: "SHA-256", retry: "false" },
    { algorithm: "{{algorithm}}", retry: true },
    { algorithm: "MD5", retry: true, extra: "private" },
    { algorithm: "MD5", retry: undefined },
  ];
  for (const policy of invalid)
    for (const scope of ["globalAuth", "folderAuth"]) {
      const value = { ...auth(), challengePolicy: policy };
      const settings =
        scope === "globalAuth"
          ? { globalAuth: value }
          : { folderAuth: { Private: value } };
      assert.throws(
        () => validateSharedAuthSettings(settings),
        /challengePolicy/,
      );
    }
  for (const value of [
    { ...auth(), type: "bearer" },
    { ...auth(), extra: {} },
    { ...auth(), password: {} },
    { type: "digest", username: "a", password: "b", extra: [] },
  ])
    assert.throws(() => validateSharedAuthSettings({ globalAuth: value }));
  let read = 0;
  const policy = { algorithm: "MD5" };
  Object.defineProperty(policy, "retry", {
    enumerable: true,
    get() {
      read++;
      return true;
    },
  });
  assert.throws(() =>
    validateSharedAuthSettings({
      globalAuth: { ...auth(), challengePolicy: policy },
    }),
  );
  assert.equal(read, 0);
  const hidden = auth();
  Object.defineProperty(hidden, "challengePolicy", {
    value: hidden.challengePolicy,
    enumerable: false,
  });
  assert.throws(() => validateSharedAuthSettings({ globalAuth: hidden }));
  const inherited = Object.assign(
    Object.create({ challengePolicy: auth().challengePolicy }),
    { type: "digest" },
  );
  assert.throws(() => validateSharedAuthSettings({ globalAuth: inherited }));
});
test("shared Digest policy retains existing per-scope and total byte limits", () => {
  assert.throws(
    () =>
      validateSharedAuthSettings({
        globalAuth: { ...auth(), password: "x".repeat(65536) },
      }),
    /64KiB/,
  );
  const folders = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [
      "f" + i,
      { ...auth(), password: "x".repeat(60000) },
    ]),
  );
  assert.throws(
    () => validateSharedAuthSettings({ folderAuth: folders }),
    /256KiB/,
  );
});
test("shared Digest precedence and frozen policies remain independent of later scope changes", () => {
  const project = {
    settings: {
      globalAuth: auth(),
      folderAuth: {
        Private: auth("MD5-sess", false),
        Public: { type: "none" },
      },
    },
  };
  const request = normalizeRequest({
    url: "https://fixture.test",
    folder: "Private",
  });
  assert.deepEqual(
    applySharedAuth(project, request).auth,
    project.settings.folderAuth.Private,
  );
  assert.deepEqual(
    applySharedAuth(project, { ...request, folder: "Public" }).auth,
    { type: "none" },
  );
  assert.deepEqual(
    applySharedAuth(project, { ...request, inheritAuth: false }).auth,
    { type: "none" },
  );
  const own = auth("SHA-512-256");
  assert.deepEqual(
    applySharedAuth(project, { ...request, auth: own }).auth,
    own,
  );
  const plan = versionPlan(null, { steps: [{ request }] }, "manual", project);
  assert.deepEqual(
    plan.steps[0].request.auth,
    project.settings.folderAuth.Private,
  );
  project.settings.folderAuth.Private.challengePolicy.retry = true;
  assert.equal(plan.steps[0].request.auth.challengePolicy.retry, false);
});
