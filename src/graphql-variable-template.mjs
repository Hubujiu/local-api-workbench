import { types } from "node:util";
const LIMIT = 1024 * 1024;
const token = /^\{\{([A-Za-z_][A-Za-z0-9_.-]{0,199})\}\}$/;
const fail = () => Error("GraphQL变量模板无效或超出受限字符串合同");
function templateBody(body) {
  if (
    typeof body !== "string" ||
    !body.isWellFormed() ||
    Buffer.byteLength(body) > LIMIT
  )
    throw fail();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw fail();
  }
  if (
    !data ||
    Array.isArray(data) ||
    typeof data !== "object" ||
    Object.keys(data).some(
      (k) => !["query", "operationName", "variables"].includes(k),
    ) ||
    typeof data.query !== "string" ||
    !data.query.isWellFormed() ||
    data.query.includes("{{") ||
    (Object.hasOwn(data, "operationName") &&
      (typeof data.operationName !== "string" ||
        !data.operationName.isWellFormed() ||
        data.operationName.includes("{{"))) ||
    !data.variables ||
    typeof data.variables !== "object" ||
    Array.isArray(data.variables)
  )
    throw fail();
  let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 100000 || depth > 64) throw fail();
    if (typeof value === "string") {
      if (!value.isWellFormed() || (value.includes("{{") && !token.test(value)))
        throw fail();
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw fail();
    } else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        if (!key.isWellFormed() || key.includes("{{")) throw fail();
        visit(child, depth + 1);
      }
  };
  visit(data.variables, 0);
  const occurrences = [];
  // JSON is already parsed above. Walk its original tokens to reject duplicate
  // members and locate placeholders without losing numeric lexemes or escapes.
  const lexemes = [
    ...body.matchAll(
      /"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
    ),
  ];
  let cursor = 0,
    visited = 0;
  const scan = (path, depth) => {
    if (++visited > 100000 || depth > 64) throw fail();
    const item = lexemes[cursor++],
      raw = item?.[0];
    if (raw === "{") {
      const names = new Set();
      if (lexemes[cursor]?.[0] === "}") {
        cursor++;
        return;
      }
      while (true) {
        const name = JSON.parse(lexemes[cursor++][0]);
        if (names.has(name) || name.includes("{{")) throw fail();
        names.add(name);
        cursor++; // colon
        scan([...path, name], depth + 1);
        if (lexemes[cursor++][0] === "}") return;
      }
    }
    if (raw === "[") {
      if (lexemes[cursor]?.[0] === "]") {
        cursor++;
        return;
      }
      let index = 0;
      while (true) {
        scan([...path, index++], depth + 1);
        if (lexemes[cursor++][0] === "]") return;
      }
    }
    if (raw?.startsWith('"')) {
      const text = JSON.parse(raw);
      if (!text.includes("{{")) return;
      if (path[0] !== "variables" || path.length < 2 || !token.test(text))
        throw fail();
      occurrences.push({
        start: item.index,
        end: item.index + raw.length,
        name: token.exec(text)[1],
      });
      if (occurrences.length > 100) throw fail();
    }
  };
  scan([], 0);
  if (!occurrences.length) throw fail();
  return occurrences;
}
export function validateGraphQLVariableTemplate(request) {
  if (!Object.hasOwn(request, "graphqlVariableTemplate")) return false;
  const m = request.graphqlVariableTemplate;
  if (
    !m ||
    typeof m !== "object" ||
    types.isProxy(m) ||
    Array.isArray(m) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(m)) ||
    Reflect.ownKeys(m).length !== 1 ||
    !Object.hasOwn(m, "version") ||
    Object.getOwnPropertyDescriptor(m, "version")?.value !== 1 ||
    Object.getOwnPropertyDescriptor(m, "version")?.enumerable !== true ||
    request.bodyType !== "json" ||
    Object.keys(request.bodyDynamic || {}).length
  )
    throw fail();
  const occurrences = templateBody(request.body);
  const otherDynamic = ["query", "headers", "path", "cookies", "form"].reduce(
    (n, key) =>
      n +
      (request[key] || []).filter((row) => row.dynamic && row.enabled !== false)
        .length,
    0,
  );
  if (occurrences.length + otherDynamic > 100) throw fail();
  return true;
}
export function renderGraphQLVariableTemplate(request, variables) {
  if (!validateGraphQLVariableTemplate(request)) return undefined;
  if (!variables || typeof variables !== "object" || types.isProxy(variables))
    throw fail();
  const parts = [];
  let at = 0,
    bytes = 0;
  for (const item of templateBody(request.body)) {
    const descriptor = Object.getOwnPropertyDescriptor(variables, item.name);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string" ||
      !descriptor.value.isWellFormed()
    )
      throw Error("GraphQL变量模板需要已定义的字符串变量: " + item.name);
    if (
      Buffer.byteLength(descriptor.value) > 65536 ||
      Buffer.byteLength(JSON.stringify(descriptor.value)) > 65536
    )
      throw fail();
    const literal = request.body.slice(at, item.start),
      value = JSON.stringify(descriptor.value);
    bytes += Buffer.byteLength(literal) + Buffer.byteLength(value);
    if (bytes > LIMIT) throw fail();
    parts.push(literal, value);
    at = item.end;
  }
  const tail = request.body.slice(at);
  if (bytes + Buffer.byteLength(tail) > LIMIT) throw fail();
  return parts.join("") + tail;
}
export function rejectGraphQLVariableTemplate(request) {
  if (Object.hasOwn(request, "graphqlVariableTemplate"))
    throw Error(
      "此入口不能保留未解析的GraphQL变量模板；请使用项目备份或计划执行",
    );
}
