import {
  graphQLEditorVersion,
  newGraphQLEditorRequest,
  readGraphQLEditor,
} from "./graphql-editor.js";

const collectionKey = "graphqlNamedQueries";
const version = 1;
const defaultId = "default";
export const GRAPHQL_NAMED_QUERY_LIMIT = 32;
const inactiveLimit = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const identifier = /^[A-Za-z0-9_.-]{1,80}$/;
const unsafeName = /[\u0000-\u001f\u007f]/;
const invalid = () =>
  Error("GraphQL 命名查询数据无效或超出 32 条／非活动正文 2 MiB 限制。");

function record(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(fields).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(fields, key) ||
        !fields[key].enumerable ||
        !Object.hasOwn(fields[key], "value"),
    )
  )
    throw invalid();
  return Object.fromEntries(keys.map((key) => [key, fields[key].value]));
}

function validateName(name) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 80 ||
    !name.isWellFormed() ||
    unsafeName.test(name)
  )
    throw Error("GraphQL 查询名称须为 1–80 个字符，不能只有空白或含控制字符。");
  return name;
}

function validId(id) {
  return typeof id === "string" && identifier.test(id);
}

// Persistence shape only. The ordinary HTTP runtime does not reinterpret the
// active payload or parse inactive documents via normalizeRequest.
export function normalizeGraphQLNamedQueries(request) {
  const descriptor = Object.getOwnPropertyDescriptor(request, collectionKey);
  if (!descriptor) {
    if (collectionKey in request) throw invalid();
    return undefined;
  }
  if (
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, "value") ||
    graphQLEditorVersion(request) !== 1
  )
    throw invalid();
  const meta = record(descriptor.value, ["version", "activeId", "items"]);
  const { items, activeId } = meta;
  if (
    meta.version !== version ||
    !validId(activeId) ||
    !Array.isArray(items) ||
    !items.length ||
    items.length > GRAPHQL_NAMED_QUERY_LIMIT ||
    Reflect.ownKeys(items).length !== items.length + 1
  )
    throw invalid();
  const seen = new Set();
  let bytes = 0;
  let foundActive = false;
  const result = [];
  for (let index = 0; index < items.length; index++) {
    const element = Object.getOwnPropertyDescriptor(items, index);
    if (!element?.enumerable || !Object.hasOwn(element, "value"))
      throw invalid();
    const item = element.value;
    const active =
      Object.getOwnPropertyDescriptor(item ?? {}, "id")?.value === activeId;
    const entry = record(
      item,
      active ? ["id", "name"] : ["id", "name", "body"],
    );
    if (!validId(entry.id) || seen.has(entry.id)) throw invalid();
    seen.add(entry.id);
    validateName(entry.name);
    if (active) foundActive = true;
    else {
      if (
        typeof entry.body !== "string" ||
        !entry.body.length ||
        !entry.body.isWellFormed() ||
        entry.body.length + bytes > inactiveLimit
      )
        throw invalid();
      bytes += encoder.encode(entry.body).byteLength;
      if (bytes > inactiveLimit) throw invalid();
    }
    result.push(entry);
  }
  if (!foundActive) throw invalid();
  return { version, activeId, items: result };
}

export function activeGraphQLRequest(request) {
  if (!request || !Object.hasOwn(request, collectionKey)) return request;
  const active = { ...request };
  delete active[collectionKey];
  return active;
}

function validateInactiveBodies(collection) {
  const envelope = newGraphQLEditorRequest();
  for (const { id, body } of collection?.items || []) {
    if (id === collection.activeId) continue;
    if (!readGraphQLEditor({ ...envelope, body })) throw invalid();
  }
}

export function assertStoredGraphQLNamedQueries(request) {
  validateInactiveBodies(normalizeGraphQLNamedQueries(request));
}

function view(request) {
  if (!readGraphQLEditor(request)) return null;
  return (
    normalizeGraphQLNamedQueries(request) ?? {
      version,
      activeId: defaultId,
      items: [{ id: defaultId, name: "自定义查询" }],
    }
  );
}

export function readGraphQLNamedQueries(request) {
  try {
    const collection = view(request);
    if (collection)
      return {
        activeId: collection.activeId,
        items: collection.items.map(({ id, name }) => ({ id, name })),
      };
  } catch {
    // An unrecognized definition still has its ordinary HTTP body.
  }
  return null;
}

export function prepareGraphQLNamedQueryChange(request, action) {
  const collection = view(request);
  const kind = Object.getOwnPropertyDescriptor(action ?? {}, "type")?.value;
  const metadata = record(
    action,
    kind === "add" || kind === "rename"
      ? ["type", "id", "name"]
      : ["type", "id"],
  );
  if (
    !collection ||
    !["add", "select", "rename", "delete"].includes(kind) ||
    !validId(metadata.id)
  )
    throw invalid();
  validateInactiveBodies(collection);
  const { id } = metadata;
  let { activeId, items } = collection;
  let { body } = request;
  const index = items.findIndex((entry) => entry.id === id);
  if (kind !== "add" && index < 0) throw Error("GraphQL 查询已不存在。");
  const activate = (next) => {
    items = items.map((entry) => {
      if (entry.id === next.id) return { id: next.id, name: next.name };
      if (entry.id === activeId) return { ...entry, body };
      return entry;
    });
    activeId = next.id;
    body = next.body;
  };
  if (kind === "add") {
    if (index >= 0 || items.length >= GRAPHQL_NAMED_QUERY_LIMIT)
      throw invalid();
    const next = {
      id,
      name: validateName(metadata.name),
      body: newGraphQLEditorRequest().body,
    };
    items.push(next);
    activate(next);
  } else if (kind === "select") {
    if (id === activeId) return null;
    activate(items[index]);
  } else if (kind === "rename") {
    const name = validateName(metadata.name);
    if (items[index].name === name) return null;
    items[index] = { ...items[index], name };
  } else {
    if (items.length === 1) throw Error("至少保留一条 GraphQL 查询。");
    const active = id === activeId;
    items.splice(index, 1);
    if (active) activate(items[index] ?? items[index - 1]);
  }
  const patch = { body, [collectionKey]: { version, activeId, items } };
  // Validate all projected metadata before returning a single atomic patch.
  normalizeGraphQLNamedQueries({ graphqlEditorVersion: 1, ...patch });
  return patch;
}
