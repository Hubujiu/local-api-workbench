import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { types } from "node:util";

// Keep this module independent of document parsers and persistence. These hard
// ceilings match the existing JSON/YAML document parser; callers may lower them.
const digestLimits = Object.freeze({
  maxBytes: 12 * 1024 * 1024,
  maxNodes: 50_000,
  maxDepth: 50,
});
const maxTokenBytes = 4096;
const maxTTL = 10 * 60 * 1000;
const purpose = "manual-resource-import";
const version = 1;
const processSecret = randomBytes(32);
const contextFields = ["nonce", "issuedAt", "expiresAt"];
const bindingFields = [
  "projectId",
  "sessionId",
  "configRevision",
  "configurationDigest",
  "sourceDigest",
  "optionsDigest",
  "planDigest",
];
const payloadFields = [
  ...contextFields,
  ...bindingFields,
  "purpose",
  "version",
];
const invalidToken = () => Error("手动导入凭据无效或已过期，请重新预览");
const invalidJSON = () => Error("手动导入摘要仅支持有界普通 JSON 数据");

function plainRecord(value, fail) {
  // Reflection on a proxy can execute user code, including on revoked proxies.
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw fail();
}

function record(value, fields, fail, required = true) {
  plainRecord(value, fail);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > fields.length ||
    (required && keys.length !== fields.length)
  )
    throw fail();
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !fields.includes(key)) throw fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw fail();
    result[key] = descriptor.value;
  }
  return result;
}

function limitsFor(options) {
  const input = record(options, Object.keys(digestLimits), invalidJSON, false);
  const limits = { ...digestLimits };
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (
      !Number.isSafeInteger(value) ||
      value < (key === "maxDepth" ? 0 : 1) ||
      value > digestLimits[key]
    )
      throw invalidJSON();
    limits[key] = value;
  }
  return limits;
}

function canonicalJSON(value, limits, fail) {
  let nodes = 0;
  let bytes = 0;
  const chunks = [];
  const active = new Set();
  const emit = (chunk) => {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > limits.maxBytes) throw fail();
    chunks.push(chunk);
  };
  const string = (text) => {
    // Avoid allocating an escaped copy of an already over-budget string.
    if (text.length > limits.maxBytes - bytes) throw fail();
    emit(JSON.stringify(text));
  };
  const visit = (item, depth) => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw fail();
    if (item === null) return emit("null");
    if (typeof item === "string") return string(item);
    if (typeof item === "boolean") return emit(item ? "true" : "false");
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw fail();
      return emit(JSON.stringify(item));
    }
    if (typeof item !== "object" || types.isProxy(item)) throw fail();
    if (active.has(item)) throw fail();
    active.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) throw fail();
      const length = Object.getOwnPropertyDescriptor(item, "length").value;
      if (length > limits.maxNodes - nodes) throw fail();
      const keys = Reflect.ownKeys(item);
      if (keys.length !== length + 1) throw fail();
      emit("[");
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        )
          throw fail();
        if (index) emit(",");
        visit(descriptor.value, depth + 1);
      }
      emit("]");
    } else {
      plainRecord(item, fail);
      const keys = Reflect.ownKeys(item);
      if (
        keys.length > limits.maxNodes - nodes ||
        keys.some((key) => typeof key !== "string")
      )
        throw fail();
      keys.sort();
      emit("{");
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
          throw fail();
        if (index) emit(",");
        string(key);
        emit(":");
        visit(descriptor.value, depth + 1);
      }
      emit("}");
    }
    active.delete(item);
  };
  visit(value, 0);
  return chunks.join("");
}

// Object keys are sorted by UTF-16 code units; arrays retain their exact order.
// This unkeyed digest is internal-only for secret-bearing data. Use commit()
// for values sent to clients, preventing offline guesses of low-entropy secrets.
// JSON's numeric representation is used (including -0 => 0). No normalization,
// toJSON call, getter read, omission of special keys, or input mutation occurs.
export function manualImportDigest(value, options = {}) {
  return createHash("sha256")
    .update(canonicalJSON(value, limitsFor(options), invalidJSON), "utf8")
    .digest("hex");
}

function boundedString(value, maxBytes) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxBytes &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function contextFrom(value, ttl = maxTTL) {
  const input = record(value, contextFields, invalidToken);
  if (
    typeof input.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.nonce) ||
    Buffer.from(input.nonce, "base64url").toString("base64url") !==
      input.nonce ||
    !Number.isSafeInteger(input.issuedAt) ||
    input.issuedAt < 0 ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= input.issuedAt ||
    input.expiresAt - input.issuedAt > ttl
  )
    throw invalidToken();
  return {
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
}

function bindingFrom(value, fields = bindingFields) {
  const input = record(value, fields, invalidToken);
  if (
    !boundedString(input.projectId, 1024) ||
    !boundedString(input.sessionId, 1024) ||
    !Number.isSafeInteger(input.configRevision) ||
    input.configRevision < 0
  )
    throw invalidToken();
  for (const key of fields.slice(3)) {
    if (typeof input[key] !== "string" || !/^[a-f0-9]{64}$/.test(input[key]))
      throw invalidToken();
  }
  return input;
}

export function manualImportID(context, key) {
  const { nonce } = contextFrom(context);
  if (!boundedString(key, 4096)) throw invalidToken();
  // JSON string encoding keeps lone surrogates distinct from U+FFFD. The nonce
  // is fixed-length and domain-separated; resource kind belongs in the key.
  const bytes = createHash("sha256")
    .update("manual-resource-import/id/v1\0", "utf8")
    .update(nonce, "ascii")
    .update("\0", "ascii")
    .update(JSON.stringify(key), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function secretFrom(value) {
  if (typeof value === "string") {
    if (!boundedString(value, 4096) || Buffer.byteLength(value, "utf8") < 32)
      throw invalidToken();
    return Buffer.from(value, "utf8");
  }
  // Copy caller-provided bytes without consulting overridden length/iterator
  // getters. The private copy is not exposed by the returned service object.
  if (
    !value ||
    types.isProxy(value) ||
    !Buffer.isBuffer(value) ||
    Object.getPrototypeOf(value) !== Buffer.prototype
  )
    throw invalidToken();
  const keys = Reflect.ownKeys(value);
  if (keys.length < 32 || keys.length > 4096) throw invalidToken();
  const bytes = [];
  for (let index = 0; index < keys.length; index++) {
    if (keys[index] !== String(index)) throw invalidToken();
    const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
    if (!Object.hasOwn(descriptor, "value")) throw invalidToken();
    bytes.push(descriptor.value);
  }
  return Buffer.from(bytes);
}

export function createManualImportTokens(options = {}) {
  const input = record(
    options,
    ["secret", "now", "ttlMs"],
    invalidToken,
    false,
  );
  const secret = Object.hasOwn(input, "secret")
    ? secretFrom(input.secret)
    : processSecret;
  const clock = Object.hasOwn(input, "now") ? input.now : () => Date.now();
  const ttl = Object.hasOwn(input, "ttlMs") ? input.ttlMs : maxTTL;
  if (
    typeof clock !== "function" ||
    types.isProxy(clock) ||
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    ttl > maxTTL
  )
    throw invalidToken();
  const readClock = () => {
    let time;
    try {
      time = clock();
    } catch {
      throw invalidToken();
    }
    if (!Number.isSafeInteger(time) || time < 0) throw invalidToken();
    return time;
  };
  const liveContext = (value) => {
    const context = contextFrom(value, ttl);
    const time = readClock();
    if (context.issuedAt > time || context.expiresAt <= time)
      throw invalidToken();
    return context;
  };
  const serializePayload = (payload) =>
    canonicalJSON(
      payload,
      { maxBytes: maxTokenBytes, maxNodes: 32, maxDepth: 1 },
      invalidToken,
    );
  const signature = (encoded) =>
    createHmac("sha256", secret).update(encoded, "ascii").digest();
  const authenticate = (token, binding) => {
    if (
      typeof token !== "string" ||
      token.length > maxTokenBytes ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)
    )
      throw invalidToken();
    const initialFields = bindingFields.filter((key) => key !== "planDigest");
    const expected = bindingFrom(binding, initialFields);
    const [encoded, encodedMAC] = token.split(".");
    const mac = Buffer.from(encodedMAC, "base64url");
    if (
      mac.toString("base64url") !== encodedMAC ||
      !timingSafeEqual(signature(encoded), mac)
    )
      throw invalidToken();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw invalidToken();
    const text = bytes.toString("utf8");
    // Reject invalid UTF-8 instead of silently replacing it before parsing.
    if (!Buffer.from(text, "utf8").equals(bytes)) throw invalidToken();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalidToken();
    }
    const payload = record(parsed, payloadFields, invalidToken);
    if (
      payload.purpose !== purpose ||
      payload.version !== version ||
      serializePayload(payload) !== text
    )
      throw invalidToken();
    const actual = bindingFrom(
      Object.fromEntries(bindingFields.map((key) => [key, payload[key]])),
    );
    for (const key of initialFields) {
      if (actual[key] !== expected[key]) throw invalidToken();
    }
    return {
      context: liveContext(
        Object.fromEntries(contextFields.map((key) => [key, payload[key]])),
      ),
      planDigest: actual.planDigest,
    };
  };
  return Object.freeze({
    // Public digests may cover low-entropy secrets. A keyed commitment prevents
    // offline guesses; its domain cannot collide with token signatures or IDs.
    commit(value, domain) {
      if (!boundedString(domain, 128)) throw invalidToken();
      return createHmac("sha256", secret)
        .update("manual-resource-import/commitment/v1\0", "utf8")
        .update(JSON.stringify(domain), "utf8")
        .update("\0", "ascii")
        .update(manualImportDigest(value), "ascii")
        .digest("hex");
    },
    createContext() {
      const issuedAt = readClock();
      const expiresAt = issuedAt + ttl;
      if (!Number.isSafeInteger(expiresAt)) throw invalidToken();
      return {
        nonce: randomBytes(32).toString("base64url"),
        issuedAt,
        expiresAt,
      };
    },
    sign(context, binding) {
      const payload = {
        ...liveContext(context),
        ...bindingFrom(binding),
        purpose,
        version,
      };
      const encoded = Buffer.from(serializePayload(payload), "utf8").toString(
        "base64url",
      );
      const token = `${encoded}.${signature(encoded).toString("base64url")}`;
      if (token.length > maxTokenBytes) throw invalidToken();
      return token;
    },
    authenticate,
    verify(token, binding) {
      const expected = bindingFrom(binding);
      const { planDigest, ...initial } = expected;
      const authenticated = authenticate(token, initial);
      if (
        !timingSafeEqual(
          Buffer.from(planDigest, "hex"),
          Buffer.from(authenticated.planDigest, "hex"),
        )
      )
        throw invalidToken();
      return authenticated.context;
    },
  });
}
