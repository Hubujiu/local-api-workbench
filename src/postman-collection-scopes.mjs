// Pure JSON model. No application, filesystem, network or VM dependency.
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const types = new Set(["any", "string", "boolean", "number"]);
export function postmanVariableMode(value) {
  if (value === undefined || value === "environment") return "environment";
  if (value === "collection") return value;
  throw Error("postmanVariableMode 必须为 environment 或 collection");
}
export function collectionIdentifier(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.-]{1,200}$/.test(value) ||
    forbidden.has(value)
  )
    throw Error("Postman collection 标识无效");
  return value;
}
export function collectionVariableName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    !value.isWellFormed() ||
    forbidden.has(value)
  )
    throw Error("Postman collection 变量名无效");
  return value;
}
export function collectionJSON(value) {
  let nodes = 0;
  const ancestors = new Set();
  function copy(item, depth) {
    if (++nodes > 100000 || depth > 32)
      throw Error("Postman collection JSON 超过结构上限");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      if (!item.isWellFormed()) throw Error("Postman collection 文本无效");
      return item;
    }
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ancestors.has(item))
      throw Error("Postman collection 值必须为有限无环 JSON");
    const array = Array.isArray(item);
    if (
      array
        ? Object.getPrototypeOf(item) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      throw Error("Postman collection 值必须为普通 JSON");
    ancestors.add(item);
    const entries = [];
    for (const key of Reflect.ownKeys(item)) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        typeof key !== "string" ||
        !key.isWellFormed() ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        (array && !/^(0|[1-9][0-9]*)$/.test(key))
      )
        throw Error("Postman collection 值不能含访问器或隐藏字段");
      entries.push([key, copy(descriptor.value, depth + 1)]);
    }
    ancestors.delete(item);
    if (array) {
      if (entries.length !== item.length)
        throw Error("Postman collection 值不能含稀疏数组");
      return entries.map(([, child]) => child);
    }
    return Object.fromEntries(entries);
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
    throw Error("Postman collection JSON 最多4MiB");
  return result;
}
export function castCollectionValue(value, type = "any") {
  if (!types.has(type)) throw Error("Postman collection 变量类型不支持");
  const copy = collectionJSON(value);
  if (type === "any") return copy;
  if (type === "boolean") return Boolean(copy);
  if (type === "string") return String(copy);
  if (copy !== null && typeof copy === "object")
    throw Error("Postman collection number 只支持标量值");
  const number = Number(copy);
  if (!Number.isFinite(number))
    throw Error("Postman collection number 必须有限");
  return number;
}
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Postman collection 对象格式无效");
}
function exact(value, keys) {
  object(value);
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw Error("Postman collection 含未知字段");
}
function title(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw Error("Postman collection 名称须为1至200字符");
  return value;
}
export function preparePostmanCollection(document, makeId) {
  if (
    !document ||
    typeof document !== "object" ||
    !document.info ||
    !Array.isArray(document.item) ||
    document.openapi ||
    document.swagger
  )
    throw Error("collection 模式仅支持 Postman collection 文档");
  const rows = collectionJSON(document.variable ?? []);
  if (!Array.isArray(rows) || rows.length > 10000)
    throw Error("Postman collection 变量最多10000项");
  const variables = Object.create(null),
    definitions = Object.create(null);
  for (const row of rows) {
    object(row);
    const key = collectionVariableName(row.key ?? row.id);
    if (row.disabled !== undefined && typeof row.disabled !== "boolean")
      throw Error("Postman collection disabled 必须为布尔值");
    if (row.disabled === true) continue;
    if (
      row.source !== undefined ||
      row.secret === true ||
      row.type === "secret"
    )
      throw Error("不解析 Postman collection 外部或 secret 变量");
    if (!Object.hasOwn(row, "value"))
      throw Error("Postman collection 活动变量必须提供 value");
    const type = row.type ?? "any";
    const value = castCollectionValue(row.value, type);
    let description = row.description ?? "";
    if (description && typeof description === "object")
      description = description.content;
    if (typeof description !== "string" || description.length > 4000)
      throw Error("Postman collection 变量说明最多4000字符");
    variables[key] = value;
    definitions[key] = { initialValue: value, type, description };
  }
  return {
    id: collectionIdentifier(makeId()),
    name: title(document.info.name || "Postman collection"),
    variables: collectionJSON(variables),
    definitions: collectionJSON(definitions),
  };
}
export function validatePostmanCollections(project) {
  const registry = project.postmanCollections;
  const ids = new Set();
  if (registry !== undefined) {
    const checked = collectionJSON(registry);
    exact(checked, ["version", "items"]);
    if (
      checked.version !== 1 ||
      !Array.isArray(checked.items) ||
      checked.items.length > 100
    )
      throw Error("Postman collection registry 版本或数量无效");
    let total = 0;
    for (const item of checked.items) {
      exact(item, ["id", "name", "variables", "definitions"]);
      collectionIdentifier(item.id);
      if (ids.has(item.id)) throw Error("Postman collection 标识重复");
      ids.add(item.id);
      title(item.name);
      object(item.variables);
      object(item.definitions);
      const names = new Set([
        ...Object.keys(item.variables),
        ...Object.keys(item.definitions),
      ]);
      total += names.size;
      if (total > 10000) throw Error("Postman collection 变量总量最多10000项");
      for (const name of names) {
        collectionVariableName(name);
        if (!Object.hasOwn(item.definitions, name))
          throw Error("Postman collection 变量缺少定义");
        const definition = item.definitions[name];
        exact(definition, ["initialValue", "type", "description"]);
        if (
          !Object.hasOwn(definition, "initialValue") ||
          !types.has(definition.type) ||
          typeof definition.description !== "string" ||
          definition.description.length > 4000
        )
          throw Error("Postman collection 变量定义无效");
        for (const value of [
          definition.initialValue,
          ...(Object.hasOwn(item.variables, name)
            ? [item.variables[name]]
            : []),
        ])
          if (
            JSON.stringify(castCollectionValue(value, definition.type)) !==
            JSON.stringify(value)
          )
            throw Error("Postman collection 变量值与类型不符");
      }
    }
  }
  const request = (value) => {
    if (value?.postmanCollectionId === undefined) return;
    collectionIdentifier(value.postmanCollectionId);
    if (!ids.has(value.postmanCollectionId))
      throw Error("Postman collection 引用不存在于当前项目");
  };
  for (const value of project.requests || []) request(value);
  for (const value of project.cases || []) request(value.request);
  const steps = (items, depth = 0) => {
    if (depth > 32) throw Error("Postman collection 步骤引用过深");
    for (const step of items || []) {
      request(step.request);
      if (step.steps) steps(step.steps, depth + 1);
    }
  };
  for (const plan of project.plans || []) steps(plan.steps);
  // Historical runs are immutable evidence, not current executable definitions.
  return registry;
}
export function appendPostmanCollection(project, collection, requests) {
  validatePostmanCollections(project);
  const registry = {
    version: 1,
    items: [...(project.postmanCollections?.items || []), collection],
  };
  const bound = requests.map((request) => ({
    ...request,
    postmanCollectionId: collection.id,
  }));
  validatePostmanCollections({
    ...project,
    postmanCollections: registry,
    requests: [...project.requests, ...bound],
  });
  return { registry, requests: bound };
}
export function rejectCollectionExport(project, format) {
  if (
    project.postmanCollections?.items?.length ||
    (project.requests || []).some(
      (request) => request.postmanCollectionId !== undefined,
    )
  )
    throw Error(
      `${format} 不能保留 Postman collection 变量层；请使用完整项目备份`,
    );
}
