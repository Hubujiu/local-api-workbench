import { normalizeNativeMock, nativeMockOperations } from "./native-mock.mjs";
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const safe = (value) =>
  typeof value === "string" &&
  value.trim() &&
  value.length <= 200 &&
  !["__proto__", "prototype", "constructor"].includes(value);
export function prepareNativeMock(node, { projectId, headers, rewriteSchema }) {
  if (
    node.mock_setup !== undefined &&
    (!object(node.mock_setup) ||
      Object.entries(node.mock_setup).some(
        ([key, value]) =>
          !["mock_method", "mock_code_method"].includes(key) || value !== 1,
      ))
  )
    throw Error("原版Mock暂仅支持已验证的Schema优先/固定200策略");
  const config =
    node.nativeMockConfig ??
    (node.ai_expect
      ? {
          project_id: projectId,
          target_id: String(node.target_id),
          ai_expect: node.ai_expect,
          mock_server_enable: node.mock_server_enable ?? 1,
          mock_ip_white_list_enable: node.mock_ip_white_list_enable ?? -1,
          mock_ip_white_list: node.mock_ip_white_list ?? "",
          mock_show_target_id: node.mock_show_target_id ?? 0,
        }
      : undefined);
  if (config === undefined) return undefined;
  if (
    !object(config) ||
    Object.keys(config).some(
      (key) =>
        ![
          "project_id",
          "target_id",
          "ai_expect",
          "mock_server_enable",
          "mock_ip_white_list_enable",
          "mock_ip_white_list",
          "mock_show_target_id",
        ].includes(key),
    ) ||
    config.project_id !== projectId ||
    config.target_id !== String(node.target_id) ||
    ![-1, 0, 1].includes(config.mock_server_enable) ||
    ![-1, 0].includes(config.mock_ip_white_list_enable) ||
    config.mock_ip_white_list !== "" ||
    ![-1, 0, 1].includes(config.mock_show_target_id)
  )
    throw Error("原版Mock身份、开关或IP限制配置不支持");
  const tree = config.ai_expect;
  if (
    !object(tree) ||
    Object.keys(tree).some(
      (key) =>
        !["list", "none_math_expect_id", "none_math_example"].includes(key),
    ) ||
    !Array.isArray(tree.list) ||
    tree.list.length > 100
  )
    throw Error("原版Mock条件树无效");
  const examples = new Map();
  for (const example of node.response?.example || []) {
    if (
      !safe(String(example.example_id)) ||
      examples.has(String(example.example_id))
    )
      throw Error("原版Mock响应期望标识无效或重复");
    examples.set(String(example.example_id), example);
  }
  const response = (id, inline) => {
    const example = String(id) === "0" ? inline : examples.get(String(id));
    if (
      !object(example) ||
      Object.keys(example).some(
        (key) =>
          !["example_id", "expect", "headers", "raw", "raw_parameter"].includes(
            key,
          ),
      ) ||
      !object(example.expect) ||
      Object.keys(example.expect).some(
        (key) =>
          ![
            "code",
            "content_type",
            "is_default",
            "mock",
            "name",
            "schema",
            "verify_type",
            "sleep",
          ].includes(key),
      )
    )
      throw Error("原版Mock引用的响应期望不存在");
    const expect = example.expect;
    const status = Number(expect.code);
    if (
      !Number.isInteger(status) ||
      status < 200 ||
      status > 599 ||
      (expect.content_type ?? "json") !== "json" ||
      (expect.mock !== undefined && expect.mock !== "") ||
      (example.raw_parameter !== undefined &&
        (!Array.isArray(example.raw_parameter) || example.raw_parameter.length))
    )
      throw Error("原版Mock仅支持明确的JSON响应期望，无附加脚本");
    const common = {
      status: 200,
      sourceStatus: status,
      headers: headers(example.headers),
      delayMs: expect.sleep ?? 0,
    };
    if (
      expect.schema !== undefined &&
      (!object(expect.schema) ||
        (Object.keys(expect.schema).length &&
          typeof expect.schema.type !== "string"))
    )
      throw Error("原版Mock Schema需要明确根类型；不静默忽略根引用或未知格式");
    if (typeof expect.schema?.type === "string")
      return { ...common, schema: rewriteSchema(expect.schema) };
    if (typeof example.raw !== "string") throw Error("原版Mock响应正文缺失");
    return { ...common, body: example.raw };
  };
  const rules = tree.list.map((rule) => {
    if (
      !object(rule) ||
      Object.keys(rule).some(
        (key) =>
          ![
            "conditions",
            "desc",
            "enable",
            "expect_id",
            "example",
            "id",
          ].includes(key),
      ) ||
      !safe(rule.id) ||
      typeof rule.desc !== "string" ||
      rule.desc.length > 200 ||
      ![-1, 0, 1].includes(rule.enable) ||
      !Array.isArray(rule.conditions) ||
      rule.conditions.length > 50
    )
      throw Error("原版Mock规则配置无效");
    const conditions = [];
    for (const condition of rule.conditions) {
      if (
        !object(condition) ||
        Object.keys(condition).some(
          (key) =>
            ![
              "compareType",
              "conditionId",
              "location",
              "name",
              "value",
            ].includes(key),
        ) ||
        !safe(condition.conditionId)
      )
        throw Error("原版Mock条件字段无效");
      if (
        ["compareType", "location", "name", "value"].every(
          (key) => condition[key] === "",
        )
      )
        continue;
      if (
        !["header", "query", "body"].includes(condition.location) ||
        typeof condition.name !== "string" ||
        !condition.name.trim() ||
        !nativeMockOperations.has(condition.compareType)
      )
        throw Error("原版Mock条件位置或比较类型无效");
      const name = condition.name.trim(),
        location =
          condition.location === "header" ? "headers" : condition.location;
      conditions.push({
        path: "$." + location + (name.startsWith("[") ? "" : ".") + name,
        op: condition.compareType,
        value: condition.value,
      });
    }
    return {
      id: rule.id,
      name: rule.desc,
      enabled: rule.enable === 1,
      conditions,
      response: response(rule.expect_id, rule.example),
    };
  });
  return normalizeNativeMock({
    version: 1,
    enabled: config.mock_server_enable === 1,
    sourceTargetId: String(node.target_id),
    rules,
    fallback: response(tree.none_math_expect_id, tree.none_math_example),
  });
}
