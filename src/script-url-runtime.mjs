import { validateQueryArrayRequest } from "./openapi-query-arrays.mjs";
import sdk from "./vendor/url-sdk-host.js";
import {
  captureURLSnapshot,
  validateURLSnapshot,
} from "./script-url-state.mjs";
const copy = (value) => JSON.parse(JSON.stringify(value));
export function validateQueryRuntime(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    !Object.hasOwn(input, "state") ||
    !Object.hasOwn(input, "origins")
  )
    throw Error("URL查询状态需要对象");
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !["state", "origins", "variableOrigins", "inactivePath"].includes(key) ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      throw Error("URL查询状态字段无效");
  }
  const state = validateURLSnapshot(input.state);
  // Reuse the same strict finite-JSON traversal for sidecar data, without SDK constructors.
  const wrapper = validateURLSnapshot({
    version: 1,
    url: {
      query: [],
      variable: [{ key: "origins", type: "any", value: input.origins }],
    },
  });
  const origins = wrapper.url.variable[0].value;
  if (!Array.isArray(origins) || origins.length !== state.url.query.length)
    throw Error("URL查询来源与成员不一致");
  for (const origin of origins) {
    if (
      !origin ||
      typeof origin !== "object" ||
      Array.isArray(origin) ||
      Object.keys(origin).some(
        (k) => !["encoding", "omitEmptyEqual", "dynamic"].includes(k),
      )
    )
      throw Error("URL查询来源字段无效");
    if (!["raw", "form"].includes(origin.encoding))
      throw Error("未知URL查询编码策略");
    if (
      Object.hasOwn(origin, "omitEmptyEqual") &&
      typeof origin.omitEmptyEqual !== "boolean"
    )
      throw Error("URL查询等号策略无效");
    if (
      origin.encoding === "raw" &&
      (Object.hasOwn(origin, "dynamic") ||
        Object.hasOwn(origin, "omitEmptyEqual"))
    )
      throw Error("原始查询不能携带表格策略");
    if (origin.dynamic !== undefined) {
      const spec = origin.dynamic;
      if (
        !spec ||
        typeof spec !== "object" ||
        Array.isArray(spec) ||
        Object.keys(spec).some(
          (k) => !["source", "value", "functions", "type", "seed"].includes(k),
        )
      )
        throw Error("URL动态参数定义无效");
      if (
        !["fixed", "variable", "mock"].includes(spec.source) ||
        !Object.hasOwn(spec, "value")
      )
        throw Error("URL动态参数来源无效");
      if (
        spec.functions !== undefined &&
        (!Array.isArray(spec.functions) ||
          spec.functions.length > 10 ||
          spec.functions.some((x) => typeof x !== "string"))
      )
        throw Error("URL动态函数链无效");
    }
  }
  const variableOrigins = validateURLSnapshot({
    version: 1,
    url: {
      query: [],
      variable: [
        {
          key: "origins",
          type: "any",
          value:
            input.variableOrigins === undefined
              ? state.url.variable.map(() => ({ encoding: "raw" }))
              : input.variableOrigins,
        },
      ],
    },
  }).url.variable[0].value;
  if (
    !Array.isArray(variableOrigins) ||
    variableOrigins.length !== state.url.variable.length
  )
    throw Error("URL变量来源与成员不一致");
  for (const origin of variableOrigins) {
    if (
      !origin ||
      typeof origin !== "object" ||
      Array.isArray(origin) ||
      origin.encoding !== "raw" ||
      Object.keys(origin).some((k) => !["encoding", "dynamic"].includes(k))
    )
      throw Error("URL变量来源无效");
  }
  for (const origin of variableOrigins) {
    if (origin.dynamic !== undefined) {
      const spec = origin.dynamic;
      if (
        !spec ||
        typeof spec !== "object" ||
        Array.isArray(spec) ||
        Object.keys(spec).some(
          (k) => !["source", "value", "functions", "type", "seed"].includes(k),
        ) ||
        !["fixed", "variable", "mock"].includes(spec.source) ||
        !Object.hasOwn(spec, "value")
      )
        throw Error("URL动态变量定义无效");
      if (
        spec.functions !== undefined &&
        (!Array.isArray(spec.functions) ||
          spec.functions.length > 10 ||
          spec.functions.some((x) => typeof x !== "string"))
      )
        throw Error("URL动态函数链无效");
    }
  }
  const inactivePath = validateURLSnapshot({
    version: 1,
    url: {
      query: [],
      variable: [
        {
          key: "inactive",
          type: "any",
          value: input.inactivePath === undefined ? [] : input.inactivePath,
        },
      ],
    },
  }).url.variable[0].value;
  if (
    !Array.isArray(inactivePath) ||
    inactivePath.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        row.enabled !== false,
    )
  )
    throw Error("停用Path元数据无效");
  const result = { state, origins, variableOrigins, inactivePath };
  let bytes = 0;
  for (const char of JSON.stringify(result)) {
    const cp = char.codePointAt(0);
    bytes += cp <= 127 ? 1 : cp <= 2047 ? 2 : cp <= 65535 ? 3 : 4;
    if (bytes > 65536) throw Error("URL状态及来源合计超过64KiB");
  }
  return result;
}
// Query/path metadata remains outside SDK members and follows object identity across each phase.
export function initializeQueryRuntime(request) {
  validateQueryArrayRequest(request);
  const raw = request.url ?? "";
  if (typeof raw !== "string" || raw.length > 65536)
    throw Error("SDK URL输入须为64KiB以内文本");
  let rawBytes = 0;
  for (const char of raw) {
    const cp = char.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) throw Error("SDK URL包含无效Unicode");
    rawBytes += cp <= 127 ? 1 : cp <= 2047 ? 2 : cp <= 65535 ? 3 : 4;
    if (rawBytes > 65536) throw Error("SDK URL输入超过64KiB");
  }
  for (const key of ["query", "path"])
    if (
      request[key] !== undefined &&
      (!Array.isArray(request[key]) || request[key].length > 1000)
    )
      throw Error("SDK URL参数表最多1000项");
  const url = new sdk.Url(raw);
  const origins = url.query.members.map(() => ({ encoding: "raw" })),
    variableOrigins = [],
    inactivePath = [];
  url.path = url.path?.map((segment) =>
    segment.startsWith("{") &&
    !segment.startsWith("{{") &&
    segment.endsWith("}") &&
    !segment.endsWith("}}")
      ? ":" + segment.slice(1, -1)
      : segment,
  );
  url.variables.clear();
  for (const row of request.path || []) {
    if (!row.key) continue;
    if (row.enabled === false) {
      inactivePath.push(row);
      continue;
    }
    url.variables.add({
      key: String(row.key),
      value: String(row.value ?? ""),
      ...(row.description ? { description: row.description } : {}),
    });
    variableOrigins.push({
      encoding: "raw",
      ...(row.dynamic ? { dynamic: row.dynamic } : {}),
    });
  }
  for (const row of request.query || []) {
    if (!row.key) continue;
    url.query.add({
      key: String(row.key),
      value:
        request.queryAddEqual === false && !String(row.value ?? "")
          ? null
          : String(row.value ?? ""),
      disabled: row.enabled === false,
      ...(row.description ? { description: row.description } : {}),
    });
    origins.push({
      encoding: "form",
      omitEmptyEqual: request.queryAddEqual === false,
      ...(row.dynamic ? { dynamic: row.dynamic } : {}),
    });
  }
  return validateQueryRuntime({
    state: captureURLSnapshot(url),
    origins,
    variableOrigins,
    inactivePath,
  });
}
export function restoreQueryRuntime(input) {
  input = validateQueryRuntime(input);
  const state = input.state,
    url = new sdk.Url(state.url);
  if (
    !Array.isArray(input.origins) ||
    input.origins.length !== url.query.members.length
  )
    throw Error("URL查询来源与成员不一致");
  const metadata = new WeakMap(),
    variableMetadata = new WeakMap();
  url.query.members.forEach((member, index) =>
    metadata.set(member, copy(input.origins[index])),
  );
  url.variables.members.forEach((member, index) =>
    variableMetadata.set(member, copy(input.variableOrigins[index])),
  );
  return {
    url,
    snapshot() {
      return validateQueryRuntime({
        state: captureURLSnapshot(url),
        origins: url.query.members.map((member) =>
          copy(metadata.get(member) || { encoding: "raw" }),
        ),
        variableOrigins: url.variables.members.map((member) =>
          copy(variableMetadata.get(member) || { encoding: "raw" }),
        ),
        inactivePath: input.inactivePath,
      });
    },
  };
}
// Input must be component-resolved first. Encode only form-origin rows, once.
export function renderQueryRuntime(input) {
  input = validateQueryRuntime(input);
  const url = new sdk.Url(input.state.url);
  if (
    !Array.isArray(input.origins) ||
    input.origins.length !== url.query.members.length
  )
    throw Error("URL查询来源与成员不一致");
  url.query.members.forEach((member, index) => {
    const origin = input.origins[index];
    if (!origin || !["raw", "form"].includes(origin.encoding))
      throw Error("未知URL查询编码策略");
    if (origin.encoding === "raw") return;
    if (origin.omitEmptyEqual && member.value === "") member.value = null;
    const pair = new URLSearchParams([
        [String(member.key ?? ""), String(member.value ?? "")],
      ]).toString(),
      at = pair.indexOf("=");
    member.key = pair.slice(0, at);
    if (member.value !== null && member.value !== undefined)
      member.value = pair.slice(at + 1);
  });
  return url.toString();
}
