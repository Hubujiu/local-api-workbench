import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedFixtureEnvironmentKey,
  fixtureEnvironmentState,
  sentinelKey,
} from "./fixtures/oracle-read-worker-environment.mjs";

const nodeVersion = "v24.8.0";
const state = (env, platform = "linux", execArgvCount = 0) =>
  fixtureEnvironmentState(env, platform, nodeVersion, execArgvCount);
const windowsStartupKeys = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

test("Linux fixture accepts only the explicit empty coverage override", () => {
  assert.equal(state({ NODE_V8_COVERAGE: "" }).valid, true);
  assert.equal(allowedFixtureEnvironmentKey("NODE_V8_COVERAGE", "linux"), true);
  for (const key of [...windowsStartupKeys, "__CF_USER_TEXT_ENCODING"]) {
    assert.equal(allowedFixtureEnvironmentKey(key, "linux"), false, key);
    assert.equal(state({ NODE_V8_COVERAGE: "", [key]: "unused" }).valid, false);
  }
  assert.equal(state({ node_v8_coverage: "" }).valid, false);
});

test("Windows startup allowlist is exact and case-insensitive", () => {
  const env = { node_v8_coverage: "" };
  for (const key of windowsStartupKeys) {
    assert.equal(allowedFixtureEnvironmentKey(key, "win32"), true, key);
    assert.equal(
      allowedFixtureEnvironmentKey(key.toLowerCase(), "win32"),
      true,
      key,
    );
    const mixedCase = key[0] + key.slice(1).toLowerCase();
    assert.equal(allowedFixtureEnvironmentKey(mixedCase, "win32"), true, key);
    env[mixedCase] = "runtime-added-value-not-for-diagnostics";
  }
  assert.equal(state(env, "win32").valid, true);
  for (const key of [
    "TMP",
    "HOME",
    "PATHEXT",
    "APPDATA",
    "__CF_USER_TEXT_ENCODING",
  ])
    assert.equal(
      state({ NODE_V8_COVERAGE: "", [key]: "unused" }, "win32").valid,
      false,
      key,
    );
});

test("macOS allows only the exact CF startup key in addition to empty coverage", () => {
  assert.equal(
    state({ NODE_V8_COVERAGE: "", __CF_USER_TEXT_ENCODING: "unused" }, "darwin")
      .valid,
    true,
  );
  for (const key of [
    "__cf_user_text_encoding",
    "__CF_USER_TEXT_ENCODING_EXTRA",
    ...windowsStartupKeys,
  ]) {
    assert.equal(allowedFixtureEnvironmentKey(key, "darwin"), false, key);
    assert.equal(
      state({ NODE_V8_COVERAGE: "", [key]: "unused" }, "darwin").valid,
      false,
      key,
    );
  }
});

test("no platform admits unknown, credential, debug, auth or broad NODE_* keys", () => {
  const denied = [
    "UNEXPECTED_FIXTURE_ENV",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_DEBUG",
    "NODE_DEBUG_NATIVE",
    "NODE_PATH",
    "NODE_COMPILE_CACHE",
    "NODE_USE_SYSTEM_CA",
    "NODE_ORACLEDB_DEBUG_PACKETS",
    "NODE_V8_COVERAGE_EXTRA",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "TNS_ADMIN",
    "TWO_TASK",
    "ORACLE_HOME",
    "ORACLE_PASSWORD",
    "ORA_DEBUG_JDWP",
    "AWS_SECRET_ACCESS_KEY",
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
  ];
  for (const platform of ["linux", "win32", "darwin"])
    for (const key of denied) {
      assert.equal(allowedFixtureEnvironmentKey(key, platform), false, key);
      assert.equal(
        state({ NODE_V8_COVERAGE: "", [key]: "sensitive-unused" }, platform)
          .valid,
        false,
        `${platform}: ${key}`,
      );
      if (platform === "win32")
        assert.equal(
          allowedFixtureEnvironmentKey(key.toLowerCase(), platform),
          false,
          key,
        );
    }
});

test("coverage must be present exactly once and have an empty string value", () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    assert.equal(state({}, platform).valid, false);
    for (const value of [
      "/private/coverage",
      " ",
      "0",
      null,
      undefined,
      0,
      false,
    ]) {
      const result = state({ NODE_V8_COVERAGE: value }, platform);
      assert.equal(result.valid, false);
      assert.equal(result.diagnostic.coverageEmpty, false);
    }
  }
  assert.equal(state({ Path: "runtime-added" }, "win32").valid, false);
  assert.equal(
    state({ __CF_USER_TEXT_ENCODING: "runtime-added" }, "darwin").valid,
    false,
  );
  for (const value of ["", "must-not-be-ignored"])
    assert.equal(
      state({ NODE_V8_COVERAGE: "", node_v8_coverage: value }, "win32").valid,
      false,
    );
});

test("any nonzero execArgv count and sentinel inheritance fail closed", () => {
  assert.equal(sentinelKey, "LOCAL_API_ORACLE_ENV_SENTINEL");
  for (const platform of ["linux", "win32", "darwin"]) {
    for (const count of [1, 2, -1, NaN, "0", undefined])
      assert.equal(
        fixtureEnvironmentState(
          { NODE_V8_COVERAGE: "" },
          platform,
          nodeVersion,
          count,
        ).valid,
        false,
      );
    for (const value of ["", "private-sentinel-value"]) {
      const result = state(
        { NODE_V8_COVERAGE: "", [sentinelKey]: value },
        platform,
      );
      assert.equal(result.valid, false);
      assert.equal(result.diagnostic.sentinelPresent, true);
    }
  }
  const windowsLowercase = state(
    { NODE_V8_COVERAGE: "", [sentinelKey.toLowerCase()]: "private-value" },
    "win32",
  );
  assert.equal(windowsLowercase.valid, false);
  assert.equal(windowsLowercase.diagnostic.sentinelPresent, true);
});

test("diagnostics contain only the declared metadata and key names, never values", () => {
  const secret = "SENSITIVE_VALUE_not_a_key_or_argument";
  const result = state(
    { NODE_V8_COVERAGE: "", NODE_OPTIONS: secret, [sentinelKey]: secret },
    "linux",
    3,
  );
  assert.equal(result.valid, false);
  assert.deepEqual(Object.keys(result).sort(), ["diagnostic", "valid"]);
  assert.deepEqual(result.diagnostic, {
    kind: "oracle-fixture-environment",
    platform: "linux",
    node: nodeVersion,
    environmentKeys: [sentinelKey, "NODE_OPTIONS", "NODE_V8_COVERAGE"],
    environmentKeyCount: 3,
    execArgvCount: 3,
    sentinelPresent: true,
    coverageEmpty: true,
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("diagnostic key names are sanitized and limited without hiding the count", () => {
  const boundaryKey = "A".repeat(64);
  assert.deepEqual(
    state({ [boundaryKey]: "private-value" }).diagnostic.environmentKeys,
    [boundaryKey],
  );
  const invalidKeys = ["", "bad\nkey", "bad\0key", "a".repeat(65), "é", "9key"];
  for (const key of invalidKeys) {
    const result = state({ NODE_V8_COVERAGE: "", [key]: "private-value" });
    assert.equal(result.valid, false);
    assert.equal(
      result.diagnostic.environmentKeys.includes("<invalid-key>"),
      true,
    );
    assert.equal(result.diagnostic.environmentKeys.includes(key), false);
    assert.equal(JSON.stringify(result).includes("private-value"), false);
  }
  const keys = Array.from({ length: 70 }, (_, index) => `KEY_${index}`);
  const result = state({
    NODE_V8_COVERAGE: "",
    ...Object.fromEntries(keys.map((key) => [key, "private-value"])),
  });
  assert.equal(result.valid, false);
  assert.equal(result.diagnostic.environmentKeyCount, 71);
  assert.equal(result.diagnostic.environmentKeys.length, 32);
  assert.deepEqual(result.diagnostic.environmentKeys, keys.sort().slice(0, 32));
  assert.equal(
    result.diagnostic.environmentKeys.every((key) => key.length <= 64),
    true,
  );
  assert.equal(JSON.stringify(result).includes("private-value"), false);
  assert.equal(JSON.stringify(result.diagnostic).length < 4096, true);
});
