import test from "node:test";
import assert from "node:assert/strict";
import { oauth1ParameterPolicy } from "../public/oauth1-policy-model.js";
import { validateAuth, authTypes } from "../public/auth-model.js";
import { validateSharedAuthSettings } from "../public/shared-auth.js";
const policy = () => ({
  placement: "auto",
  includeBodyHash: true,
  includeEmptyParams: true,
  headerEncoding: "percent",
});
const auth = () => ({
  type: "oauth1",
  consumerKey: "fictional-key",
  consumerSecret: "fictional-secret",
  parameterPolicy: policy(),
});
function reject(value) {
  assert.throws(
    () => validateAuth(value),
    (error) => {
      assert.equal(error.message, "OAuth1 parameterPolicy 定义无效");
      assert(!Object.hasOwn(error, "cause"));
      return true;
    },
  );
}
test("OAuth1 complete static policy accepts all typed combinations without mutation", () => {
  for (const placement of ["header", "auto"])
    for (const includeBodyHash of [false, true])
      for (const includeEmptyParams of [false, true])
        for (const headerEncoding of ["percent", "raw"]) {
          const a = {
              ...auth(),
              parameterPolicy: {
                placement,
                includeBodyHash,
                includeEmptyParams,
                headerEncoding,
              },
            },
            before = structuredClone(a);
          validateAuth(a);
          const result = oauth1ParameterPolicy(a);
          assert.deepEqual(result, a.parameterPolicy);
          assert.notEqual(result, a.parameterPolicy);
          assert(Object.isFrozen(result));
          assert.deepEqual(a, before);
        }
  assert.equal(oauth1ParameterPolicy({ type: "oauth1" }), undefined);
  assert.doesNotThrow(() => validateAuth({ type: "oauth1" }));
});
test("OAuth1 static policy rejects partial, extra, null, dynamic and coerced fields", () => {
  for (const parameterPolicy of [
    undefined,
    null,
    [],
    {},
    "auto",
    { ...policy(), placement: "query" },
    { ...policy(), placement: "{{placement}}" },
    { ...policy(), headerEncoding: "{{encoding}}" },
    { ...policy(), includeBodyHash: "true" },
    { ...policy(), includeEmptyParams: 1 },
    { ...policy(), privateSecret: "must-not-echo" },
  ])
    reject({ ...auth(), parameterPolicy });
  for (const key of Object.keys(policy())) {
    const p = policy();
    delete p[key];
    reject({ ...auth(), parameterPolicy: p });
  }
  for (const type of authTypes.filter((t) => t !== "oauth1"))
    reject({ ...auth(), type });
  reject({ parameterPolicy: policy() });
});
test("OAuth1 policy descriptors reject hidden, inherited and accessor definitions without invocation", () => {
  let reads = 0;
  for (const key of Object.keys(policy())) {
    const p = policy();
    Object.defineProperty(p, key, {
      enumerable: true,
      get() {
        reads++;
        return true;
      },
    });
    reject({ ...auth(), parameterPolicy: p });
    const hidden = policy();
    Object.defineProperty(hidden, key, {
      enumerable: false,
      value: hidden[key],
    });
    reject({ ...auth(), parameterPolicy: hidden });
  }
  const a = auth();
  Object.defineProperty(a, "parameterPolicy", {
    enumerable: true,
    get() {
      reads++;
      return policy();
    },
  });
  reject(a);
  const hidden = auth();
  Object.defineProperty(hidden, "parameterPolicy", {
    enumerable: false,
    value: policy(),
  });
  reject(hidden);
  reject(
    Object.assign(Object.create({ parameterPolicy: policy() }), {
      type: "oauth1",
    }),
  );
  const inheritedPolicy = Object.assign(
    Object.create({ extra: true }),
    policy(),
  );
  reject({ ...auth(), parameterPolicy: inheritedPolicy });
  const symbol = policy();
  symbol[Symbol("secret")] = true;
  reject({ ...auth(), parameterPolicy: symbol });
  const type = auth();
  Object.defineProperty(type, "type", {
    enumerable: true,
    get() {
      reads++;
      return "oauth1";
    },
  });
  reject(type);
  assert.equal(reads, 0);
});
test("shared scopes admit only validated OAuth1 policy and keep existing nested and byte guards", () => {
  const settings = { globalAuth: auth(), folderAuth: { Scoped: auth() } };
  const before = structuredClone(settings);
  validateSharedAuthSettings(settings);
  assert.deepEqual(settings, before);
  for (const candidate of [
    { ...auth(), other: {} },
    { ...auth(), consumerSecret: {} },
    {
      ...auth(),
      parameterPolicy: { ...policy(), includeBodyHash: "{{flag}}" },
    },
  ])
    assert.throws(() => validateSharedAuthSettings({ globalAuth: candidate }));
  assert.throws(
    () =>
      validateSharedAuthSettings({
        globalAuth: { ...auth(), consumerSecret: "x".repeat(65536) },
      }),
    /64KiB/,
  );
  assert.throws(
    () =>
      validateSharedAuthSettings({
        folderAuth: Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [
            "f" + i,
            { ...auth(), consumerSecret: "x".repeat(60000) },
          ]),
        ),
      }),
    /256KiB/,
  );
});
