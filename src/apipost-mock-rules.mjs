import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeMockFieldRules } from "./mock-fields.mjs";
export function mergeApipostMockRules(rows, existing, projectId) {
  if (!Array.isArray(rows) || rows.length > 100)
    throw Error("Apipost自定义Mock规则最多100条");
  const ids = new Set();
  const incoming = rows.map((row) => {
    const keys = [
      "mock_custom_rule_id",
      "project_id",
      "field_type",
      "match_type",
      "match_rule",
      "match_case",
      "mock_type",
      "mock_rule_content",
      "intro",
    ];
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).some((key) => !keys.includes(key)) ||
      (row.project_id !== undefined && row.project_id !== projectId) ||
      typeof row.mock_custom_rule_id !== "string" ||
      !row.mock_custom_rule_id ||
      row.mock_custom_rule_id.length > 200 ||
      ids.has(row.mock_custom_rule_id)
    )
      throw Error("Apipost自定义Mock规则身份或字段无效");
    ids.add(row.mock_custom_rule_id);
    if (
      !["exact", "wildcard"].includes(row.match_type) ||
      ![-1, 1].includes(row.match_case) ||
      row.mock_type !== 1 ||
      typeof (row.intro ?? "") !== "string" ||
      (row.intro ?? "").length > 200
    )
      throw Error(
        "Apipost自定义Mock暂仅支持明确大小写选项的精确或星号数值规则",
      );
    return {
      id:
        "apipost-mock-" +
        createHash("sha256")
          .update(JSON.stringify([projectId, row.mock_custom_rule_id]))
          .digest("hex")
          .slice(0, 24),
      name: row.intro || row.match_rule,
      pattern: row.match_rule,
      type: row.field_type,
      mock: row.mock_rule_content,
      enabled: true,
      ignoreCase: row.match_case === -1,
      apipostSource: {
        projectId,
        id: row.mock_custom_rule_id,
        ...(row.match_type === "wildcard" ? { matchType: "wildcard" } : {}),
      },
    };
  });
  const result = normalizeMockFieldRules(existing || []);
  for (const row of normalizeMockFieldRules(incoming)) {
    const previous = result.find((item) => item.id === row.id);
    if (previous && !isDeepStrictEqual(previous, row))
      throw Error("Apipost自定义Mock同来源规则冲突，请导入新项目");
    if (!previous) result.push(row);
  }
  return normalizeMockFieldRules(result);
}
