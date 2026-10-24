export function normalizeExecutionContext(value = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "iteration",
          "iterationCount",
          "iterationData",
          "environment",
        ].includes(key),
    )
  )
    throw Error("脚本执行上下文无效");
  const environment = value.environment;
  if (
    environment !== undefined &&
    (!environment ||
      typeof environment !== "object" ||
      Array.isArray(environment) ||
      Object.keys(environment).some((key) => !["id", "name"].includes(key)) ||
      ["id", "name"].some(
        (key) =>
          typeof environment[key] !== "string" || environment[key].length > 200,
      ))
  )
    throw Error("脚本环境标识须为最多200字符的id/name");
  const iteration = value.iteration ?? 0,
    iterationCount = value.iterationCount ?? 1,
    data = value.iterationData ?? {};
  if (
    !Number.isInteger(iteration) ||
    !Number.isInteger(iterationCount) ||
    iterationCount < 1 ||
    iterationCount > 100 ||
    iteration < 0 ||
    iteration >= iterationCount
  )
    throw Error("脚本迭代编号/总数无效");
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).length > 50 ||
    Object.keys(data).some(
      (key) =>
        !key ||
        key.length > 200 ||
        ["__proto__", "prototype", "constructor"].includes(key),
    )
  )
    throw Error("脚本测试数据须为最多50个安全字段的对象");
  let json;
  try {
    json = JSON.stringify(data, (key, item) => {
      if (
        ["undefined", "function", "symbol", "bigint"].includes(typeof item) ||
        (typeof item === "number" && !Number.isFinite(item))
      )
        throw Error("非JSON值");
      return item;
    });
  } catch {
    throw Error("脚本测试数据不可序列化为JSON");
  }
  if (Buffer.byteLength(json) > 512 * 1024)
    throw Error("脚本测试数据JSON最多512KiB");
  return {
    iteration,
    iterationCount,
    iterationData: JSON.parse(json),
    ...(environment === undefined
      ? {}
      : { environment: { id: environment.id, name: environment.name } }),
  };
}
