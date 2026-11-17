// Definition-only tests: no signer, challenge, interpolation, or provider calls.
import test from "node:test";
import assert from "node:assert/strict";
import { importExtendedApipostAuth as importAuth } from "../src/apipost-auth-import.mjs";
import { exportExtendedApipostAuth as exportAuth } from "../src/apipost-auth-export.mjs";

const algorithms = [
  "MD5",
  "MD5-sess",
  "SHA-256",
  "SHA-256-sess",
  "SHA-512-256",
  "SHA-512-256-sess",
];
const state = ["realm", "nonce", "qop", "nc", "cnonce", "opaque"];
const marker = "PRIVATE_UNKNOWN_KEY_MUST_NOT_ECHO";
const password = "PRIVATE_PASSWORD_MUST_NOT_ECHO";
const native = (patch = {}) => ({
  type: "digest",
  digest: { username: "alice", password, ...patch },
});
const model = (patch = {}) => ({
  type: "digest",
  username: "alice",
  password,
  challengePolicy: { algorithm: "MD5", retry: true },
  ...patch,
});
const canonical = (value) => ({
  type: "digest",
  digest: {
    username: value.username,
    password: value.password ?? "",
    realm: "",
    nonce: "",
    algorithm: value.challengePolicy.algorithm,
    qop: "",
    nc: "",
    cnonce: "",
    opaque: "",
    disableRetryRequest: !value.challengePolicy.retry,
  },
});
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const records = (value) =>
  Reflect.ownKeys(value).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(value, key),
  ]);
function redacted(error) {
  assert.ok(error instanceof Error);
  for (const text of [
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
  ]) {
    assert.equal(text.includes(marker), false);
    assert.equal(text.includes(password), false);
  }
  assert.equal(Object.hasOwn(error, "cause"), false);
  return true;
}
function reject(fn, value) {
  const before = value && typeof value === "object" ? records(value) : null;
  assert.throws(() => fn(value), redacted);
  if (before) assert.deepEqual(records(value), before);
}
function roundtrip(input, expected) {
  const before = structuredClone(input);
  const imported = importAuth(input);
  assert.deepEqual(imported, expected);
  const exported = exportAuth(imported);
  assert.deepEqual(exported, canonical(expected));
  assert.deepEqual(importAuth(exported), expected);
  assert.deepEqual(exportAuth(importAuth(exported)), exported);
  assert.deepEqual(input, before);
  assert.notEqual(imported, input.digest);
  assert.notEqual(exported.digest, imported);
}

test("six fixed algorithms and both switches canonicalize and remain inverse-stable", () => {
  for (const algorithm of algorithms)
    for (const disableRetryRequest of [false, true]) {
      for (const withEmptyState of [false, true]) {
        const patch = {
          algorithm,
          disableRetryRequest,
          ...(withEmptyState
            ? Object.fromEntries(state.map((key) => [key, ""]))
            : {}),
        };
        roundtrip(
          native(patch),
          model({
            challengePolicy: { algorithm, retry: !disableRetryRequest },
          }),
        );
      }
    }
});

test("only declared omissions default; all state presence combinations canonicalize", () => {
  for (const algorithm of [undefined, "", "MD5"])
    for (let mask = 0; mask < 64; mask++) {
      const input = native();
      delete input.digest.password;
      if (algorithm !== undefined) input.digest.algorithm = algorithm;
      for (let i = 0; i < state.length; i++)
        if (mask & (1 << i)) input.digest[state[i]] = "";
      roundtrip(input, model({ password: "" }));
    }
  const omitted = model();
  delete omitted.password;
  assert.deepEqual(exportAuth(omitted), canonical(model({ password: "" })));
  assert.deepEqual(importAuth(exportAuth(omitted)), model({ password: "" }));
});

test("credential strings remain literal, including templates, whitespace, Unicode and escapes", () => {
  for (const username of [" ", "{{username}}", '雪\u0000"\\\r\n']) {
    for (const secret of ["", "{{password}}", '雪\u0000"\\\r\n']) {
      roundtrip(
        native({ username, password: secret }),
        model({ username, password: secret }),
      );
    }
  }
});

test("native fields reject present undefined, state loss, flags and noncanonical algorithms", () => {
  for (const key of [
    "username",
    "password",
    ...state,
    "algorithm",
    "disableRetryRequest",
  ])
    reject(importAuth, native({ [key]: undefined }));
  const missingUsername = native();
  delete missingUsername.digest.username;
  reject(importAuth, missingUsername);
  for (const username of ["", null, 0, false, [], {}])
    reject(importAuth, native({ username }));
  for (const secret of [null, 0, false, [], {}])
    reject(importAuth, native({ password: secret }));
  for (const key of state)
    for (const value of [
      "learned-state",
      "{{state}}",
      "0",
      0,
      false,
      null,
      [],
      {},
    ])
      reject(importAuth, native({ [key]: value }));
  for (const algorithm of [
    "md5",
    "MD5-SESS",
    "sha-256",
    "SHA-256-SESS",
    "auto",
    "{{selected}}",
    " MD5",
    "MD5\n",
    null,
    0,
    false,
    [],
    {},
  ])
    reject(importAuth, native({ algorithm }));
  for (const disableRetryRequest of ["", "false", "true", 0, 1, null, [], {}])
    reject(importAuth, native({ disableRetryRequest }));
});

test("export requires an explicit complete policy and rejects legacy or extra saved data", () => {
  const automatic = model();
  delete automatic.challengePolicy;
  reject(exportAuth, automatic);
  for (const policy of [
    undefined,
    null,
    {},
    { algorithm: "MD5" },
    { retry: true },
    { algorithm: "md5", retry: true },
    { algorithm: "MD5", retry: "true" },
    { algorithm: "MD5", retry: true, [marker]: password },
  ])
    reject(exportAuth, model({ challengePolicy: policy }));
  for (const field of [
    "algorithm",
    "disableRetryRequest",
    "realm",
    "nonce",
    marker,
  ])
    for (const value of ["", undefined, password])
      reject(exportAuth, model({ [field]: value }));
  for (const username of ["", undefined, null, 0, false, [], {}])
    reject(exportAuth, model({ username }));
  const missingUsername = model();
  delete missingUsername.username;
  reject(exportAuth, missingUsername);
  for (const value of [undefined, null, 0, false, [], {}])
    reject(exportAuth, model({ password: value }));
  for (const value of ["", undefined, password])
    reject(importAuth, native({ [marker]: value }));
});

function malformedObjects(seed, counter) {
  const accessor = { ...seed };
  Object.defineProperty(accessor, Object.keys(seed)[0], {
    enumerable: true,
    get() {
      counter.calls++;
      return password;
    },
  });
  const hidden = { ...seed };
  Object.defineProperty(hidden, marker, { value: password, enumerable: false });
  const symbol = { ...seed, [Symbol(marker)]: password };
  const tag = { ...seed };
  Object.defineProperty(tag, Symbol.toStringTag, {
    get() {
      counter.calls++;
      return marker;
    },
  });
  const toJSON = {
    ...seed,
    toJSON() {
      counter.calls++;
      return seed;
    },
  };
  const inherited = Object.assign(Object.create({ inherited: password }), seed);
  return [accessor, hidden, symbol, tag, toJSON, inherited, [], null];
}

test("selected sections, Workbench model and nested policy reject unsafe descriptors without hooks", () => {
  const counter = { calls: 0 };
  for (const section of malformedObjects(native().digest, counter))
    reject(importAuth, { type: "digest", digest: section });
  for (const value of malformedObjects(model(), counter)) {
    // A non-Digest discriminator is outside this adapter's dispatch contract.
    if (value && Object.getOwnPropertyDescriptor(value, "type")?.get) {
      reject(exportAuth, value);
    } else if (value && !Array.isArray(value)) reject(exportAuth, value);
  }
  for (const policy of malformedObjects(model().challengePolicy, counter))
    reject(exportAuth, model({ challengePolicy: policy }));
  assert.equal(counter.calls, 0);
});

test("plain and null-prototype frozen definitions are supported without source mutation", () => {
  const section = Object.freeze(
    Object.assign(Object.create(null), native().digest),
  );
  const expected = model();
  assert.deepEqual(importAuth({ type: "digest", digest: section }), expected);
  const policy = Object.freeze(
    Object.assign(Object.create(null), expected.challengePolicy),
  );
  const value = Object.freeze(
    Object.assign(Object.create(null), expected, { challengePolicy: policy }),
  );
  const before = records(value);
  assert.deepEqual(exportAuth(value), canonical(expected));
  assert.deepEqual(records(value), before);
});

test("native selector descriptors reject getters while inactive sections are never traversed", () => {
  let calls = 0;
  const input = native();
  Object.defineProperty(input, "basic", {
    enumerable: true,
    get() {
      calls++;
      throw Error(password);
    },
  });
  input.inactiveHuge = password.repeat(10000);
  const before = records(input);
  assert.deepEqual(importAuth(input), model());
  assert.deepEqual(records(input), before);
  for (const key of ["type", "digest"]) {
    const value = native();
    Object.defineProperty(value, key, {
      enumerable: true,
      get() {
        calls++;
        throw Error(password);
      },
    });
    reject(importAuth, value);
  }
  const inheritedSection = Object.assign(
    Object.create({ digest: native().digest }),
    { type: "digest" },
  );
  reject(importAuth, inheritedSection);
  assert.equal(calls, 0);
});

function padded(value, section, size, prefix = "") {
  const result = structuredClone(value);
  const target = section ? result[section] : result;
  target.password = prefix;
  const remaining = size - bytes(target);
  assert.ok(remaining >= 0);
  target.password += "x".repeat(remaining);
  assert.equal(bytes(target), size);
  return result;
}

test("64 KiB UTF-8 selected-section boundary includes canonical default expansion", () => {
  const limit = 65536;
  for (const prefix of ["", '雪😀\u0000"\\\r\n']) {
    const complete = padded(canonical(model()), "digest", limit, prefix);
    assert.equal(bytes(complete.digest), limit);
    const imported = importAuth(complete);
    assert.deepEqual(exportAuth(imported), complete);
    assert.ok(bytes(imported) <= limit);
    reject(importAuth, {
      ...complete,
      digest: { ...complete.digest, password: complete.digest.password + "x" },
    });
    const overOutput = { ...imported, password: imported.password + "x" };
    assert.ok(
      bytes(overOutput) <= limit,
      "input fits but canonical native output exceeds cap",
    );
    reject(exportAuth, overOutput);
    const sparse = padded(native(), "digest", limit, prefix);
    assert.equal(bytes(sparse.digest), limit);
    assert.ok(
      bytes(canonical(model({ password: sparse.digest.password })).digest) >
        limit,
    );
    reject(importAuth, sparse);
    reject(exportAuth, padded(model(), null, limit + 1, prefix));
  }
});

test("canonical output is independent of mutable source policy and native section", () => {
  const input = native();
  const imported = importAuth(input);
  input.digest.username = "changed";
  assert.equal(imported.username, "alice");
  const exported = exportAuth(imported);
  imported.challengePolicy.algorithm = "SHA-256";
  imported.password = "changed";
  assert.equal(exported.digest.algorithm, "MD5");
  assert.equal(exported.digest.password, password);
});
