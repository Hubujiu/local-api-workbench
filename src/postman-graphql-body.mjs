import { types } from "node:util";

const BYTE_LIMIT = 8 * 1024 * 1024;
const NODE_LIMIT = 100000;
const DEPTH_LIMIT = 64;
const fail = () =>
  Error(
    "Postman GraphQL 正文不属于支持的静态 JSON 子集（不支持模板、非法变量或未知字段）",
  );
function record(value) {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors))
    if (
      typeof key !== "string" ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    )
      throw fail();
  return descriptors;
}
function stringJSONBytes(value) {
  let bytes = 2; // JSON quotes; validate before allocating the escaped representation.
  for (const character of value) {
    const code = character.codePointAt(0);
    bytes +=
      character === '"' || character === "\\"
        ? 2
        : [8, 9, 10, 12, 13].includes(code)
          ? 2
          : code < 32
            ? 6
            : Buffer.byteLength(character);
    if (bytes > BYTE_LIMIT) throw fail();
  }
  return bytes;
}
function staticText(value) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.includes("{{") ||
    Buffer.byteLength(value) > BYTE_LIMIT
  )
    throw fail();
  stringJSONBytes(value);
  return value;
}
function snapshotJSON(value) {
  let nodes = 0,
    bytes = 0;
  const consume = (amount) => {
    bytes += amount;
    if (bytes > BYTE_LIMIT) throw fail();
  };
  const countText = (text) => {
    staticText(text);
    consume(stringJSONBytes(text));
    return text;
  };
  const ancestors = new Set();
  function visit(input, depth) {
    if (++nodes > NODE_LIMIT || depth > DEPTH_LIMIT) throw fail();
    if (input === null || typeof input === "boolean") {
      consume(input === null || input === true ? 4 : 5);
      return input;
    }
    if (typeof input === "string") return countText(input);
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw fail();
      consume(String(input).length);
      return input;
    }
    if (
      !input ||
      typeof input !== "object" ||
      types.isProxy(input) ||
      ancestors.has(input)
    )
      throw fail();
    ancestors.add(input);
    consume(2); // Array/object delimiters.
    let output;
    if (Array.isArray(input)) {
      if (
        Object.getPrototypeOf(input) !== Array.prototype ||
        input.length > NODE_LIMIT
      )
        throw fail();
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Reflect.ownKeys(descriptors).length !== input.length + 1)
        throw fail();
      output = Object.setPrototypeOf([], null);
      for (let i = 0; i < input.length; i++) {
        const descriptor = descriptors[i];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
          throw fail();
        if (i) consume(1);
        output[i] = visit(descriptor.value, depth + 1);
      }
    } else {
      output = Object.create(null);
      let first = true;
      for (const [key, descriptor] of Object.entries(record(input))) {
        consume(first ? 1 : 2); // Colon and subsequent commas.
        first = false;
        countText(key);
        output[key] = visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(input);
    return output;
  }
  return visit(value, 0);
}

/** Converts only an explicit, bounded static GraphQL JSON subset, not editor mode. */
export function importPostmanGraphQLBody(body) {
  const fields = record(body);
  if (fields.mode?.value !== "graphql") return undefined;
  if (fields.disabled && typeof fields.disabled.value !== "boolean")
    throw fail();
  if (fields.disabled?.value === true) return { bodyType: "none", body: "" };
  const gql = record(fields.graphql?.value);
  if (
    Object.keys(gql).some(
      (key) => !["query", "operationName", "variables"].includes(key),
    )
  )
    throw fail();
  const query = staticText(gql.query?.value);
  const parts = ['"query":' + JSON.stringify(query)];
  if (gql.operationName)
    parts.push(
      '"operationName":' + JSON.stringify(staticText(gql.operationName.value)),
    );
  if (gql.variables) {
    let variables = gql.variables.value;
    if (variables !== "") {
      let source;
      if (typeof variables === "string") {
        staticText(variables);
        try {
          variables = JSON.parse(variables);
        } catch {
          throw fail();
        }
        // JSON.parse collapses duplicate keys; inspect every original string token too.
        for (const token of gql.variables.value.matchAll(/"(?:\\.|[^"\\])*"/g))
          staticText(JSON.parse(token[0]));
        // Preserve original number lexemes, whitespace and object key order.
        source = gql.variables.value;
      }
      if (
        variables !== null &&
        (typeof variables !== "object" || Array.isArray(variables))
      )
        throw fail();
      const snapshot = snapshotJSON(variables);
      parts.push('"variables":' + (source ?? JSON.stringify(snapshot)));
    }
  }
  const payload = "{" + parts.join(",") + "}";
  if (Buffer.byteLength(payload) > BYTE_LIMIT) throw fail();
  return { bodyType: "json", body: payload };
}
