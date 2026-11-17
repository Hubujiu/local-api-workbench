import { types } from "node:util";
import { jsonPathSegments } from "./json-path.mjs";

// Request-local work, not a wall-clock timeout: synchronous conversion cannot be
// interrupted by a timer. Cache only immutable primitives; never object identity.
export function createMockConditionBudget() {
  let bytes = 1024 * 1024,
    nodes = 100000;
  const jsonCache = new Map(),
    stringCache = new Map();
  const fail = () => {
    throw Error("Mock条件比较总量超过预算（1MiB/100000节点）");
  };
  const unsupported = () => {
    throw Error("Mock条件仅支持无访问器或自定义转换的JSON数据");
  };
  const debit = (amount) => {
    if (amount > bytes) fail();
    bytes -= amount;
  };
  const visit = (depth = 0) => {
    if (--nodes < 0 || depth > 64) fail();
  };
  const text = (value, quoted = false) => {
    if (value.length > bytes) fail();
    if (quoted) debit(2);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (quoted && (code === 34 || code === 92)) debit(2);
      else if (quoted && code < 32)
        debit([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          debit(4);
          i++;
        } else debit(quoted ? 6 : 3);
      } else if (code >= 0xdc00 && code <= 0xdfff) debit(quoted ? 6 : 3);
      else debit(code < 128 ? 1 : code < 2048 ? 2 : 3);
    }
  };
  const object = (value) => {
    if (types.isProxy(value)) unsupported();
    const proto = Object.getPrototypeOf(value);
    if (
      proto !== null &&
      proto !== Object.prototype &&
      !(Array.isArray(value) && proto === Array.prototype)
    )
      unsupported();
    for (const target of [value, proto, Object.prototype]) {
      if (!target) continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, "toJSON");
      if (
        descriptor &&
        (!Object.hasOwn(descriptor, "value") ||
          typeof descriptor.value === "function")
      )
        unsupported();
    }
  };
  const own = (value, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, "value")) unsupported();
    return descriptor.value;
  };
  const jsonCost = (value, depth = 0, ancestors = new Set()) => {
    visit(depth);
    if (typeof value === "string") return text(value, true);
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return debit(JSON.stringify(value).length);
    if (value === undefined) return debit(1);
    if (typeof value !== "object") unsupported();
    object(value);
    if (ancestors.has(value))
      throw TypeError("Converting circular structure to JSON");
    ancestors.add(value);
    debit(2);
    if (Array.isArray(value)) {
      if (value.length > nodes) fail();
      for (let i = 0; i < value.length; i++) {
        if (i) debit(1);
        const item = own(value, String(i));
        jsonCost(item === undefined ? null : item, depth + 1, ancestors);
      }
    } else {
      let first = true;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        visit(depth + 1);
        const item = own(value, key);
        if (item === undefined) continue;
        if (!first) debit(1);
        first = false;
        text(key, true);
        debit(1);
        jsonCost(item, depth + 1, ancestors);
      }
    }
    ancestors.delete(value);
  };
  const stringCost = (value, depth = 0, ancestors = new Set()) => {
    visit(depth);
    if (value === null || typeof value !== "object") {
      if (
        !["string", "number", "boolean", "undefined"].includes(typeof value) &&
        value !== null
      )
        unsupported();
      return text(String(value));
    }
    object(value);
    if (Object.getOwnPropertySymbols(value).length) unsupported();
    if (
      Array.isArray(value) &&
      ["join", "toString", "valueOf"].some((key) => Object.hasOwn(value, key))
    )
      unsupported();
    // User-defined coercion is outside inert HTTP JSON. Do not execute it during
    // estimation or hide its result behind a cache.
    for (const key of [
      Symbol.toPrimitive,
      "toString",
      "valueOf",
      ...(Array.isArray(value) ? ["join"] : []),
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor &&
        (!Object.hasOwn(descriptor, "value") ||
          typeof descriptor.value === "function")
      )
        unsupported();
    }
    if (!Array.isArray(value)) return text(String(value));
    if (ancestors.has(value)) unsupported();
    ancestors.add(value);
    if (value.length > nodes) fail();
    for (let i = 0; i < value.length; i++) {
      if (i) debit(1);
      const item = own(value, String(i));
      stringCost(item == null ? "" : item, depth + 1, ancestors);
    }
    ancestors.delete(value);
  };
  const encode = (value, cache, estimate, convert) => {
    const primitive = value === null || typeof value !== "object";
    if (primitive && cache.has(value)) {
      visit();
      const saved = cache.get(value);
      debit(saved.bytes);
      return saved.text;
    }
    const before = bytes;
    estimate(value);
    const result = convert(value);
    if (primitive) cache.set(value, { bytes: before - bytes, text: result });
    return result;
  };
  return {
    read(source, path) {
      const segments = jsonPathSegments(path);
      visit();
      text(path);
      for (const key of segments) {
        visit();
        if (source == null) return undefined;
        if (typeof source === "function") unsupported();
        if (typeof source === "object") object(source);
        source = own(Object(source), key);
      }
      return source;
    },
    json(value) {
      return encode(value, jsonCache, jsonCost, JSON.stringify);
    },
    string(value) {
      return encode(value, stringCache, stringCost, String);
    },
    exists(value) {
      visit();
      debit(1);
      return value !== undefined && value !== null;
    },
  };
}
