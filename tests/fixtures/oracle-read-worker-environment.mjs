// Test-only policy: these are runtime-added startup metadata, not permission to
// copy a caller's environment. See pinned Node/libuv and Apple CF ADR references.
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
export const sentinelKey = "LOCAL_API_ORACLE_ENV_SENTINEL";

export function allowedFixtureEnvironmentKey(key, platform) {
  if (platform === "win32") key = key.toUpperCase();
  return (
    key === "NODE_V8_COVERAGE" ||
    (platform === "win32" && windowsStartupKeys.includes(key)) ||
    (platform === "darwin" && key === "__CF_USER_TEXT_ENCODING")
  );
}

export function fixtureEnvironmentState(env, platform, node, execArgvCount) {
  const keys = Object.keys(env).sort();
  const coverageKeys = keys.filter(
    (key) =>
      (platform === "win32" ? key.toUpperCase() : key) === "NODE_V8_COVERAGE",
  );
  const sentinelPresent = keys.some(
    (key) => (platform === "win32" ? key.toUpperCase() : key) === sentinelKey,
  );
  const coverageEmpty =
    coverageKeys.length === 1 && env[coverageKeys[0]] === "";
  return {
    valid:
      coverageEmpty &&
      !sentinelPresent &&
      execArgvCount === 0 &&
      keys.every((key) => allowedFixtureEnvironmentKey(key, platform)),
    diagnostic: {
      kind: "oracle-fixture-environment",
      platform,
      node,
      // No values, arguments, connection options, SQL, or raw errors. Even a
      // malformed key cannot inject arbitrary/unbounded diagnostic output.
      environmentKeys: keys
        .slice(0, 32)
        .map((key) =>
          /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ? key : "<invalid-key>",
        ),
      environmentKeyCount: keys.length,
      execArgvCount,
      sentinelPresent,
      coverageEmpty,
    },
  };
}
