import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { inspect } from "node:util";
import { spawnSync } from "node:child_process";
import {
  createManualImportTokens,
  manualImportDigest,
  manualImportID,
} from "../src/manual-import-token.mjs";

const secret = "test-only-manual-import-secret-32-bytes";
const start = 1_800_000_000_000;
const binding = () => ({
  projectId: "project-one",
  sessionId: "owner:session-one",
  configRevision: 7,
  configurationDigest: "a".repeat(64),
  sourceDigest: "b".repeat(64),
  optionsDigest: "c".repeat(64),
  planDigest: "d".repeat(64),
});
const setup = (options = {}) =>
  createManualImportTokens({ secret, now: () => start, ...options });
const payloadOf = (token) =>
  JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
const canonical = (value) =>
  value && typeof value === "object"
    ? `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(",")}}`
    : JSON.stringify(value);
const forge = (payload, text = canonical(payload)) => {
  const encoded = Buffer.from(text).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
};

test("authenticate returns only trusted context and signed plan commitment before deterministic rebuilding", () => {
  const manager = setup();
  const context = manager.createContext();
  const full = binding();
  const { planDigest, ...initial } = full;
  const token = manager.sign(context, full);
  assert.deepEqual(manager.authenticate(token, initial), {
    context,
    planDigest,
  });
  for (const [field, value] of Object.entries(initial)) {
    const changed = typeof value === "number" ? value + 1 : "f".repeat(64);
    assert.throws(() =>
      manager.authenticate(token, { ...initial, [field]: changed }),
    );
  }
  assert.throws(() => manager.authenticate(token, full));
  assert.throws(() => manager.authenticate(token + "x", initial));
  assert.throws(() =>
    setup({ now: () => context.expiresAt }).authenticate(token, initial),
  );
  assert.throws(() =>
    manager.verify(token, { ...full, planDigest: "e".repeat(64) }),
  );
  assert.deepEqual(manager.verify(token, full), context);
});

function hostileProxy() {
  let reads = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        reads++;
        throw Error("proxy get ran");
      },
      getPrototypeOf() {
        reads++;
        throw Error("proxy prototype ran");
      },
      ownKeys() {
        reads++;
        throw Error("proxy ownKeys ran");
      },
      getOwnPropertyDescriptor() {
        reads++;
        throw Error("proxy descriptor ran");
      },
    },
  );
  return { proxy, reads: () => reads };
}

test("digest uses stable JSON object keys, array order, and exact literal strings", () => {
  const source = {
    z: [1, 2],
    a: "HTTPS://Example/a?q=1#fragment",
    name: " Name ",
  };
  assert.equal(
    manualImportDigest(source),
    manualImportDigest({ name: source.name, a: source.a, z: [1, 2] }),
  );
  assert.equal(
    manualImportDigest({ b: 2, a: 1 }),
    createHash("sha256").update('{"a":1,"b":2}').digest("hex"),
  );
  assert.notEqual(
    manualImportDigest(source),
    manualImportDigest({ ...source, z: [2, 1] }),
  );
  assert.notEqual(
    manualImportDigest(source),
    manualImportDigest({ ...source, a: source.a.toLowerCase() }),
  );
  assert.notEqual(
    manualImportDigest(source),
    manualImportDigest({ ...source, name: "Name" }),
  );
  assert.equal(manualImportDigest(-0), manualImportDigest(0));
});

test("digest preserves literal schema constructor, prototype and __proto__ keys", () => {
  const value = JSON.parse(
    '{"properties":{"constructor":{"type":"string"},"__proto__":{"type":"number"},"prototype":{"type":"boolean"}}}',
  );
  const before = JSON.stringify(value);
  assert.notEqual(
    manualImportDigest(value),
    manualImportDigest({ properties: {} }),
  );
  assert.equal(
    manualImportDigest(value),
    createHash("sha256").update(canonical(value)).digest("hex"),
  );
  assert.equal(
    manualImportDigest({ toJSON: "literal" }),
    createHash("sha256").update('{"toJSON":"literal"}').digest("hex"),
  );
  assert.equal(JSON.stringify(value), before);
  const plain = Object.assign(Object.create(null), { x: 1 });
  assert.equal(manualImportDigest(plain), manualImportDigest({ x: 1 }));
  assert.equal(Object.prototype.polluted, undefined);
});

test("digest rejects accessors, proxies, custom prototypes and toJSON without running them", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  const toJSON = {
    toJSON() {
      reads++;
      return "secret";
    },
  };
  const proxy = hostileProxy();
  for (const value of [
    accessor,
    toJSON,
    proxy.proxy,
    { nested: proxy.proxy },
    Object.create({ x: 1 }),
    new Date(),
    new Map(),
    new Set(),
    new Uint8Array(1),
  ]) {
    assert.throws(() => manualImportDigest(value));
  }
  assert.equal(reads, 0);
  assert.equal(proxy.reads(), 0);
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  assert.throws(() => manualImportDigest(revoked.proxy));
});

test("digest rejects non-JSON data, cycles, holes, extra array keys and hidden/symbol properties", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const extra = [1];
  extra.extra = 2;
  const arrayGetter = [];
  let getterReads = 0;
  Object.defineProperty(arrayGetter, "0", {
    get() {
      getterReads++;
      return 1;
    },
    enumerable: true,
  });
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol("x"),
    () => {},
    cyclic,
    [, 1],
    extra,
    arrayGetter,
    { x: undefined },
    Object.defineProperty({}, "hidden", { value: 1 }),
    { [Symbol("x")]: 1 },
  ]) {
    assert.throws(() => manualImportDigest(value));
  }
  assert.equal(getterReads, 0);
  const shared = { x: 1 };
  assert.equal(
    manualImportDigest([shared, shared]),
    manualImportDigest([{ x: 1 }, { x: 1 }]),
  );
});

test("digest enforces UTF-8 byte, node and depth budgets including keys and JSON escapes", () => {
  assert.doesNotThrow(() => manualImportDigest("中", { maxBytes: 5 }));
  assert.throws(() => manualImportDigest("中", { maxBytes: 4 }));
  assert.doesNotThrow(() => manualImportDigest("\u0000", { maxBytes: 8 }));
  assert.throws(() => manualImportDigest("\u0000", { maxBytes: 7 }));
  assert.throws(() => manualImportDigest({ 中: 1 }, { maxBytes: 7 }));
  assert.doesNotThrow(() =>
    manualImportDigest({ a: 1 }, { maxNodes: 2, maxDepth: 1 }),
  );
  assert.throws(() => manualImportDigest({ a: 1 }, { maxNodes: 1 }));
  assert.throws(() => manualImportDigest({ a: 1 }, { maxDepth: 0 }));
  assert.throws(() => manualImportDigest(Array(50_001).fill(null)));
  assert.throws(() => manualImportDigest("x".repeat(12 * 1024 * 1024)));
  let deep = null;
  for (let i = 0; i < 51; i++) deep = [deep];
  assert.throws(() => manualImportDigest(deep));
  for (const options of [
    { maxBytes: Infinity },
    { maxNodes: 50_001 },
    { maxDepth: 51 },
    { maxNodes: 0 },
    { maxBytes: -1 },
    { maxDepth: 1.5 },
    { unknown: 1 },
    null,
  ]) {
    assert.throws(() => manualImportDigest(null, options));
  }
});

test("digest and token envelope validation never read option or binding accessors/proxies", () => {
  let reads = 0;
  const accessor = (key) =>
    Object.defineProperty({}, key, {
      enumerable: true,
      get() {
        reads++;
        return "secret";
      },
    });
  const proxy = hostileProxy();
  const manager = setup();
  const context = manager.createContext();
  const token = manager.sign(context, binding());
  for (const value of [accessor("maxBytes"), proxy.proxy])
    assert.throws(() => manualImportDigest({}, value));
  for (const value of [accessor("secret"), proxy.proxy])
    assert.throws(() => createManualImportTokens(value));
  for (const value of [accessor("projectId"), proxy.proxy]) {
    assert.throws(() => manager.sign(context, value));
    assert.throws(() => manager.verify(token, value));
  }
  for (const value of [accessor("nonce"), proxy.proxy]) {
    assert.throws(() => manager.sign(value, binding()));
    assert.throws(() => manualImportID(value, "api:one"));
  }
  assert.equal(reads, 0);
  assert.equal(proxy.reads(), 0);
});

test("contexts have bounded lifetime, independent random nonces and no source data", () => {
  const manager = setup();
  const one = manager.createContext();
  const two = manager.createContext();
  assert.deepEqual(Object.keys(one).sort(), ["expiresAt", "issuedAt", "nonce"]);
  assert.equal(one.issuedAt, start);
  assert.equal(one.expiresAt, start + 600_000);
  assert.match(one.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(one.nonce, "base64url").length, 32);
  assert.notEqual(one.nonce, two.nonce);
  assert.equal(setup({ ttlMs: 1 }).createContext().expiresAt, start + 1);
});

test("sign and verify round trip without mutation; replay only reconstructs the same context", () => {
  const manager = setup();
  const context = manager.createContext();
  const target = binding();
  const beforeContext = structuredClone(context);
  const beforeBinding = structuredClone(target);
  Object.freeze(context);
  Object.freeze(target);
  const token = manager.sign(context, target);
  assert.ok(Buffer.byteLength(token) <= 4096);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(manager.sign(context, target), token);
  assert.deepEqual(manager.verify(token, target), context);
  assert.deepEqual(manager.verify(token, target), context);
  assert.deepEqual(context, beforeContext);
  assert.deepEqual(target, beforeBinding);
  assert.notEqual(manager.verify(token, target), context);
});

test("every binding field is mandatory and checked across projects, sessions, revisions and digests", () => {
  const manager = setup();
  const context = manager.createContext();
  const token = manager.sign(context, binding());
  for (const field of Object.keys(binding())) {
    const changed = binding();
    changed[field] =
      field === "configRevision"
        ? 8
        : field.endsWith("Digest")
          ? "e".repeat(64)
          : "other";
    assert.throws(() => manager.verify(token, changed), field);
    const missing = binding();
    delete missing[field];
    assert.throws(() => manager.sign(context, missing), field);
    assert.throws(() => manager.verify(token, missing), field);
  }
  assert.throws(() =>
    manager.sign(context, {
      ...binding(),
      sourceText: "must-never-enter-token",
    }),
  );
  assert.throws(() => manager.verify(token, { ...binding(), ignored: true }));
});

test("binding scalar types and digest encodings are exact and bounded", () => {
  const manager = setup();
  const context = manager.createContext();
  for (const value of [
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "7",
    null,
  ]) {
    assert.throws(() =>
      manager.sign(context, { ...binding(), configRevision: value }),
    );
  }
  for (const field of ["projectId", "sessionId"]) {
    for (const value of ["", null, 1, {}, "x".repeat(1025), "中".repeat(400)]) {
      assert.throws(() =>
        manager.sign(context, { ...binding(), [field]: value }),
      );
    }
  }
  for (const field of [
    "configurationDigest",
    "sourceDigest",
    "optionsDigest",
    "planDigest",
  ]) {
    for (const value of [
      "A".repeat(64),
      "a".repeat(63),
      "g".repeat(64),
      1,
      null,
    ]) {
      assert.throws(() =>
        manager.sign(context, { ...binding(), [field]: value }),
      );
    }
  }
});

test("tampering, wrong keys and separately restarted default keys reject the token", () => {
  const manager = setup();
  const token = manager.sign(manager.createContext(), binding());
  const [payload, mac] = token.split(".");
  const different = (value) =>
    `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
  assert.throws(() =>
    manager.verify(`${different(payload)}.${mac}`, binding()),
  );
  assert.throws(() =>
    manager.verify(`${payload}.${different(mac)}`, binding()),
  );
  assert.throws(() =>
    setup({ secret: "different-test-only-secret-32-bytes" }).verify(
      token,
      binding(),
    ),
  );
  const defaults = createManualImportTokens({ now: () => start });
  const defaultToken = defaults.sign(defaults.createContext(), binding());
  assert.doesNotThrow(() =>
    createManualImportTokens({ now: () => start }).verify(
      defaultToken,
      binding(),
    ),
  );
  const script = `import { createManualImportTokens } from ${JSON.stringify(new URL("../src/manual-import-token.mjs", import.meta.url).href)}; try { createManualImportTokens({now:()=>${start}}).verify(${JSON.stringify(defaultToken)},${JSON.stringify(binding())});process.exit(1); } catch { process.exit(0); }`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
});

test("verification checks expiration, future issuance, clock safety and maximum TTL", () => {
  let time = start;
  const manager = setup({ now: () => time, ttlMs: 100 });
  const context = manager.createContext();
  const token = manager.sign(context, binding());
  time = start + 99;
  assert.deepEqual(manager.verify(token, binding()), context);
  time = start + 100;
  assert.throws(() => manager.verify(token, binding()));
  assert.throws(() => manager.sign(context, binding()));
  time = start - 1;
  assert.throws(() => manager.verify(token, binding()));
  assert.throws(() => manager.sign(context, binding()));
  const payload = payloadOf(token);
  for (const altered of [
    { issuedAt: start + 1 },
    { expiresAt: start + 600_001 },
    { expiresAt: start },
    { issuedAt: -1 },
    { issuedAt: "1800000000000" },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() =>
      setup().verify(forge({ ...payload, ...altered }), binding()),
    );
    assert.throws(() => setup().sign({ ...context, ...altered }, binding()));
  }
  for (const invalid of [
    NaN,
    Infinity,
    -1,
    0.5,
    "1800000000000",
    Number.MAX_SAFE_INTEGER,
  ]) {
    const broken = setup({ now: () => invalid });
    assert.throws(() => broken.createContext());
    assert.throws(() => broken.verify(token, binding()));
  }
  assert.throws(() => setup({ ttlMs: 99 }).verify(token, binding()));
});

test("token verification rejects noncanonical encodings even with a valid HMAC", () => {
  const manager = setup();
  const token = manager.sign(manager.createContext(), binding());
  const payload = payloadOf(token);
  const canonicalText = Buffer.from(token.split(".")[0], "base64url").toString(
    "utf8",
  );
  const texts = [
    ` ${canonicalText}`,
    `${canonicalText}\n`,
    canonicalText.replace('"projectId":', '"projectId" :'),
    canonicalText.replace(
      '"projectId":"project-one"',
      '"projectId":"wrong","projectId":"project-one"',
    ),
    canonicalText.replace(
      '"projectId":"project-one"',
      '"projectId":"project-\\u006fne"',
    ),
    JSON.stringify(Object.fromEntries(Object.entries(payload).reverse())),
  ];
  for (const value of texts)
    assert.throws(() => manager.verify(forge(payload, value), binding()));
  for (const value of [
    "",
    "x".repeat(4097),
    ` ${token}`,
    `${token}\n`,
    `${token}.extra`,
    token.replace(".", "=."),
    token + "=",
    null,
    {},
    1,
    Buffer.from(token),
  ]) {
    assert.throws(() => manager.verify(value, binding()));
  }
  const [encoded] = token.split(".");
  const badBytes = Buffer.concat([
    Buffer.from(encoded, "base64url"),
    Buffer.from([255]),
  ]);
  const badPayload = badBytes.toString("base64url");
  const badToken = `${badPayload}.${createHmac("sha256", secret).update(badPayload).digest("base64url")}`;
  assert.throws(() => manager.verify(badToken, binding()));
});

test("signed payload purpose/version/fields/nonces cannot be changed or extended", () => {
  const manager = setup();
  const token = manager.sign(manager.createContext(), binding());
  const payload = payloadOf(token);
  for (const value of [
    { ...payload, version: 2 },
    { ...payload, version: "1" },
    { ...payload, purpose: "other-operation" },
    { ...payload, ignored: true },
    { ...payload, nonce: "a" },
    { ...payload, nonce: "x".repeat(43) },
    { ...payload, sourceDigest: "f".repeat(64) },
  ])
    assert.throws(() => manager.verify(forge(value), binding()));
  for (const field of Object.keys(payload)) {
    const missing = { ...payload };
    delete missing[field];
    assert.throws(() => manager.verify(forge(missing), binding()), field);
  }
  assert.throws(() =>
    manager.sign({ ...manager.createContext(), extra: true }, binding()),
  );
});

test("factory options, secret representations and invocation clocks are validated without disclosure", () => {
  for (const options of [
    { ttlMs: 0 },
    { ttlMs: -1 },
    { ttlMs: 600_001 },
    { ttlMs: 1.5 },
    { now: 1 },
    { unknown: 1 },
    { secret: "short" },
    { secret: {} },
    { secret: "x".repeat(4097) },
    null,
  ]) {
    assert.throws(() => createManualImportTokens(options));
  }
  const manager = setup();
  const context = manager.createContext();
  const token = manager.sign(context, binding());
  for (const text of [
    token,
    JSON.stringify(manager),
    inspect(manager),
    String(manager.sign),
    String(manager.verify),
    String(manager.createContext),
  ]) {
    assert.equal(text.includes(secret), false);
  }
  assert.equal(
    Buffer.from(token.split(".")[0], "base64url").toString().includes(secret),
    false,
  );
  assert.throws(
    () => manager.sign(context, { ...binding(), sourceDigest: secret }),
    (error) => !String(error).includes(secret),
  );
  const key = Buffer.alloc(32, 7);
  const buffered = setup({ secret: key });
  const bufferedToken = buffered.sign(buffered.createContext(), binding());
  key.fill(8);
  assert.doesNotThrow(() => buffered.verify(bufferedToken, binding()));
});

test("generated IDs are stable UUIDs isolated by nonce, source key and resource kind", () => {
  const manager = setup();
  const one = manager.createContext();
  const two = manager.createContext();
  const id = manualImportID(one, "api:one");
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(manualImportID(one, "api:one"), id);
  assert.notEqual(manualImportID(two, "api:one"), id);
  assert.notEqual(manualImportID(one, "api:two"), id);
  assert.notEqual(manualImportID(one, "sample:one"), id);
  assert.notEqual(manualImportID(one, "\ud800"), manualImportID(one, "�"));
  for (const key of ["", "x".repeat(4097), undefined, 1, {}, () => {}])
    assert.throws(() => manualImportID(one, key));
  assert.throws(() => manualImportID({ ...one, nonce: "invalid" }, "api:one"));
});

test("public commitments are keyed, domain-separated, stable and never echo source secrets", () => {
  const manager = setup();
  const source = { password: "a-low-entropy-private-value", z: [1, 2] };
  const before = structuredClone(source);
  const commitment = manager.commit(source, "source");
  assert.match(commitment, /^[a-f0-9]{64}$/);
  assert.equal(
    manager.commit({ z: [1, 2], password: source.password }, "source"),
    commitment,
  );
  assert.notEqual(commitment, manualImportDigest(source));
  assert.notEqual(manager.commit(source, "configuration"), commitment);
  assert.notEqual(
    setup({ secret: "other-commitment-secret-at-least-32-bytes" }).commit(
      source,
      "source",
    ),
    commitment,
  );
  assert.notEqual(
    manager.commit({ ...source, password: "other" }, "source"),
    commitment,
  );
  assert.equal(commitment.includes(source.password), false);
  assert.deepEqual(source, before);
  assert.notEqual(
    manager.commit(source, "\ud800"),
    manager.commit(source, "�"),
  );
  for (const domain of [
    "",
    "x".repeat(129),
    "中".repeat(43),
    null,
    undefined,
    1,
    {},
    () => {},
  ]) {
    assert.throws(() => manager.commit(source, domain));
  }
  let reads = 0;
  const getter = Object.defineProperty({}, "password", {
    enumerable: true,
    get() {
      reads++;
      return source.password;
    },
  });
  const hostile = hostileProxy();
  assert.throws(() => manager.commit(getter, "source"));
  assert.throws(() => manager.commit(hostile.proxy, "source"));
  assert.throws(() => manager.commit(source, hostile.proxy));
  assert.equal(reads, 0);
  assert.equal(hostile.reads(), 0);
  assert.equal(String(manager.commit).includes(secret), false);
});

test("hostile secret/clock options and invalid envelopes cause zero access side effects", () => {
  const hostile = hostileProxy();
  let reads = 0;
  const clock = new Proxy(() => start, {
    apply() {
      reads++;
      return start;
    },
    get() {
      reads++;
      return undefined;
    },
  });
  const key = Buffer.alloc(32, 1);
  Object.defineProperty(key, "length", {
    get() {
      reads++;
      return 32;
    },
  });
  for (const options of [
    { secret: hostile.proxy },
    { now: clock },
    { secret: key },
    Object.create({ ttlMs: 100 }),
    Object.defineProperty({}, "secret", { value: secret }),
  ]) {
    assert.throws(() => createManualImportTokens(options));
  }
  assert.equal(reads, 0);
  assert.equal(hostile.reads(), 0);
  const throwingClock = setup({
    now() {
      throw Error(secret);
    },
  });
  assert.throws(
    () => throwingClock.createContext(),
    (error) => !String(error).includes(secret),
  );
  const manager = setup();
  const context = manager.createContext();
  assert.throws(() =>
    manager.sign(context, { ...binding(), projectId: "\u0000".repeat(1024) }),
  );
  assert.doesNotThrow(() =>
    manager.sign(context, {
      ...binding(),
      configRevision: Number.MAX_SAFE_INTEGER,
    }),
  );
});
