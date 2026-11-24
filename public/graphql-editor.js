const versionKey = "graphqlEditorVersion";
const maxBytes = 1024 * 1024;
const fieldNames = new Set(["query", "operationName", "variables"]);
const editorFields = new Set(["query", "operationName", "variablesSource"]);
const encoder = new TextEncoder();
const invalid = () =>
  Error(
    "GraphQL 编辑器仅支持不含模板的 POST JSON 查询、变量对象或 null 及可选操作名称",
  );

function safeText(text) {
  if (
    typeof text !== "string" ||
    text.length > maxBytes ||
    !text.isWellFormed() ||
    text.includes("{{")
  )
    throw invalid();
  return text;
}

function scanner(text) {
  if (
    typeof text !== "string" ||
    text.length > maxBytes ||
    !text.isWellFormed() ||
    encoder.encode(text).byteLength > maxBytes
  )
    throw invalid();
  const scalar =
    /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;
  let cursor = 0;
  let nodes = 0;
  const ws = () => {
    while (" \t\r\n".includes(text[cursor] ?? "\u0000")) cursor++;
    return cursor;
  };
  const take = (expected) => {
    ws();
    if (text[cursor] !== expected) return false;
    cursor++;
    return true;
  };
  const require = (expected) => {
    if (!take(expected)) throw invalid();
  };
  const string = () => {
    const start = ws();
    if (text[cursor++] !== '"') throw invalid();
    while (cursor < text.length) {
      const next = text[cursor++];
      if (next === "\\") cursor++;
      if (next !== '"') continue;
      // Decode this string token only. Variables numbers are never parsed.
      try {
        return safeText(JSON.parse(text.slice(start, cursor)));
      } catch {
        throw invalid();
      }
    }
    throw invalid();
  };
  const value = (depth = 0) => {
    if (++nodes > 100000 || depth > 64) throw invalid();
    if (take("{")) {
      if (!take("}")) {
        do {
          string();
          require(":");
          value(depth + 1);
        } while (take(","));
        require("}");
      }
    } else if (take("[")) {
      if (!take("]")) {
        do value(depth + 1);
        while (take(","));
        require("]");
      }
    } else if (text[ws()] === '"') string();
    else {
      scalar.lastIndex = cursor;
      if (!scalar.test(text)) throw invalid();
      cursor = scalar.lastIndex;
    }
  };
  const variables = () => {
    const type = text[ws()];
    if (type !== "{" && type !== "n") throw invalid();
    value();
  };
  const finish = () => {
    if (ws() !== text.length) throw invalid();
  };
  return {
    ws,
    take,
    require,
    string,
    variables,
    finish,
    at: () => cursor,
  };
}

function envelope(body) {
  const tokens = scanner(body);
  const start = tokens.ws();
  tokens.require("{");
  const members = new Map();
  const fields = {};
  if (!tokens.take("}")) {
    do {
      const keyStart = tokens.ws();
      const key = tokens.string();
      if (!fieldNames.has(key) || members.has(key)) throw invalid();
      tokens.require(":");
      const start = tokens.at();
      let value;
      if (key === "variables") {
        tokens.variables();
        value = body.slice(start, tokens.ws());
        fields.variablesSource = value;
      } else {
        value = tokens.string();
        fields[key] = value;
      }
      members.set(key, { keyStart, start, end: tokens.at(), value });
    } while (tokens.take(","));
    tokens.require("}");
  }
  const close = tokens.at() - 1;
  tokens.finish();
  if (!members.has("query")) throw invalid();
  return { fields, members, start, close };
}

export function graphQLEditorVersion(request) {
  const marker = Object.getOwnPropertyDescriptor(request, versionKey);
  if (!marker) {
    if (versionKey in request) throw invalid();
    return undefined;
  }
  if (!marker.enumerable || marker.value !== 1) throw invalid();
  return 1;
}

function authoringEnvelope(request) {
  if (
    request.method !== "POST" ||
    request.bodyType !== "json" ||
    Object.hasOwn(request, "graphqlVariableTemplate") ||
    Object.hasOwn(request, "postmanRawBody") ||
    Object.keys(request.bodyDynamic || {}).length
  )
    throw invalid();
  return envelope(request.body);
}

export function newGraphQLEditorRequest() {
  return {
    method: "POST",
    bodyType: "json",
    body: '{"query":""}',
    [versionKey]: 1,
  };
}

export function enableGraphQLEditor(request) {
  graphQLEditorVersion(request);
  authoringEnvelope(request);
  return { [versionKey]: 1 };
}

export function readGraphQLEditor(request) {
  try {
    if (graphQLEditorVersion(request) === 1)
      return authoringEnvelope(request).fields;
  } catch {
    // Ineligible marked data remains a readable ordinary request.
  }
  return null;
}

export function prepareGraphQLEdit(request, patch) {
  if (
    graphQLEditorVersion(request) !== 1 ||
    !patch ||
    typeof patch !== "object"
  )
    throw invalid();
  const { body } = request;
  const { members, start, close } = authoringEnvelope(request);
  const edits = new Map();
  for (const uiKey of Reflect.ownKeys(patch)) {
    const item = Object.getOwnPropertyDescriptor(patch, uiKey);
    if (
      !editorFields.has(uiKey) ||
      !item.enumerable ||
      !Object.hasOwn(item, "value")
    )
      throw invalid();
    const value = item.value;
    const key = uiKey === "variablesSource" ? "variables" : uiKey;
    if (members.get(key)?.value === value) continue;
    if (value === undefined && key !== "query") edits.set(key, undefined);
    else if (key === "variables") {
      const tokens = scanner(value);
      tokens.variables();
      tokens.finish();
      edits.set(key, value);
    } else {
      const encoded = JSON.stringify(safeText(value));
      const current = members.get(key);
      const gap = current && /^[ \t\r\n]*/.exec(body.slice(current.start))[0];
      edits.set(key, (gap || "") + encoded);
    }
  }
  if (!edits.size) return body;
  const shapeChanged = [...edits].some(
    ([key, value]) => !members.has(key) || value === undefined,
  );
  let next;
  if (shapeChanged) {
    const parts = [];
    for (const [key, member] of members) {
      const { keyStart, start, end } = member;
      if (!edits.has(key)) parts.push(body.slice(keyStart, end));
      else if (edits.get(key) !== undefined)
        parts.push(body.slice(keyStart, start) + edits.get(key));
    }
    for (const [key, value] of edits)
      if (!members.has(key)) parts.push(JSON.stringify(key) + ":" + value);
    next = body.slice(0, start + 1) + parts.join(",") + body.slice(close);
  } else {
    next = body;
    // Replace right-to-left to keep offsets referring to the original body.
    for (const [key, { start, end }] of [...members].reverse()) {
      if (edits.has(key))
        next = next.slice(0, start) + edits.get(key) + next.slice(end);
    }
  }
  envelope(next);
  return next;
}
