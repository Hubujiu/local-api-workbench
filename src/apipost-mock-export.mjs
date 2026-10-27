import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeNativeMock } from "./native-mock.mjs";
import { prepareNativeMock } from "./apipost-native-mock.mjs";

// Independently authored reverse data adapter. It never samples or executes rules.
const id = (scope, value) =>
  "mock_" +
  createHash("sha256")
    .update(scope + "\0" + value)
    .digest("hex")
    .slice(0, 24);
function inlineSchema(value, depth = 0) {
  if (depth > 40) throw Error("原生Mock导出schema超过40层");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      ["$ref", "$dynamicRef", "$recursiveRef"].includes(key) ||
      (key === "ref" && typeof child === "string" && child.startsWith("#/"))
    )
      throw Error("原生Mock导出不支持模型或外部引用");
    inlineSchema(child, depth + 1);
  }
}
export function exportApipostMock(value, { projectId, targetId }) {
  if (value === undefined) return {};
  const mock = normalizeNativeMock(value);
  const response = (entry, key) => {
    // The importer already distinguishes scalar schemas from opaque raw text.
    // Keep the schema as a definition; never sample it or parse/normalize raw.
    if (
      entry.serialization !== undefined &&
      entry.serialization !== "scalar-text"
    )
      throw Error("原生Mock导出不支持XML或未知序列化");
    if (entry.schema !== undefined) inlineSchema(entry.schema);
    return {
      example_id: id(targetId, "example:" + key),
      raw_parameter: [],
      raw: entry.body ?? "",
      headers: Object.entries(entry.headers || {}).map(([key, value], i) => ({
        param_id: id(targetId, `header:${key}:${i}`),
        key,
        value,
        is_checked: 1,
      })),
      expect: {
        code: String(entry.sourceStatus),
        content_type: "json",
        is_default: -1,
        mock: "",
        name: key,
        verify_type: "schema",
        schema: structuredClone(entry.schema ?? {}),
        sleep: entry.delayMs ?? 0,
      },
    };
  };
  const config = {
    project_id: projectId,
    target_id: targetId,
    mock_server_enable: mock.enabled ? 1 : -1,
    mock_ip_white_list_enable: -1,
    mock_ip_white_list: "",
    mock_show_target_id: 0,
    ai_expect: {
      list: mock.rules.map((rule, index) => ({
        id: rule.id,
        desc: rule.name,
        enable: rule.enabled ? 1 : -1,
        expect_id: "0",
        example: response(rule.response, "rule:" + index),
        conditions: rule.conditions.map((condition, i) => {
          const match = /^\$\.(query|headers|body)(\.|\[)/.exec(condition.path);
          const name = condition.path.slice(
            2 + match[1].length + (match[2] === "." ? 1 : 0),
          );
          if (!name || name.trim() !== name)
            throw Error("原生Mock条件路径不能无损逆映射");
          return {
            conditionId: id(targetId, `condition:${index}:${i}`),
            location: match[1] === "headers" ? "header" : match[1],
            name,
            compareType: condition.op,
            value: condition.value,
          };
        }),
      })),
      none_math_expect_id: "0",
      none_math_example: response(mock.fallback, "fallback"),
    },
  };
  const projected = prepareNativeMock(
    { target_id: targetId, nativeMockConfig: config },
    {
      projectId,
      headers: (rows) =>
        Object.fromEntries(rows.map((row) => [row.key, row.value])),
      rewriteSchema: structuredClone,
    },
  );
  const expected = { ...mock, sourceTargetId: targetId };
  // Explicit defaults are semantically absent in old stored requests.
  for (const entry of [
    expected.fallback,
    ...expected.rules.map((r) => r.response),
  ]) {
    entry.headers ??= {};
    entry.delayMs ??= 0;
  }
  if (!isDeepStrictEqual(projected, expected))
    throw Error("原生Mock导出回读不一致；请使用项目备份");
  const { project_id, target_id, ...fields } = config;
  return fields;
}
