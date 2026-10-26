// Frozen, canonical task provenance. No execution entry point reads this field.
// Validate data descriptors before reading values: source records never run code.
function plain(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("任务来源须为普通对象");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !descriptors[key].enumerable ||
        !Object.hasOwn(descriptors[key], "value"),
    )
  )
    throw Error("任务来源包含未知字段或访问器");
}
function array(value, max) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw Error("任务来源数组无效或超过上限");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let i = 0; i < value.length; i++)
    if (!descriptors[i]?.enumerable || !Object.hasOwn(descriptors[i], "value"))
      throw Error("任务来源数组不能有空洞或访问器");
  return value;
}
function text(value, max, nonempty = false) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > max ||
    (nonempty &&
      (!value.trim() ||
        ["__proto__", "prototype", "constructor"].includes(value)))
  )
    throw Error("任务来源文本无效或超过上限");
  return value;
}
export function normalizeImportedNativeTaskSource(value) {
  plain(value, ["version", "before", "after"]);
  if (value.version !== 1) throw Error("任务来源版本无效");
  const result = { version: 1 };
  for (const phase of ["before", "after"]) {
    let bytes = 0,
      databases = 0;
    result[phase] = array(value[phase], 16).map((task) => {
      plain(task, ["type", "enabled", "data", "id", "name", "origin"]);
      if (![1, 0, -1].includes(task.enabled))
        throw Error("任务来源启停状态无效");
      let data;
      if (task.type === "customScript") {
        data = text(task.data, 65536);
        bytes += Buffer.byteLength(data, "utf8");
        if (bytes > 65536) throw Error("任务来源每阶段源码最多64KiB");
      } else if (task.type === "database") {
        if (task.enabled === 1 && ++databases > 5)
          throw Error("任务来源每阶段数据库任务最多5项");
        const d = task.data;
        plain(d, [
          "connectionId",
          "query",
          "isConsoleOutput",
          "variables",
          "resultShape",
        ]);
        if (
          ![-1, 0, 1].includes(d.isConsoleOutput) ||
          (d.resultShape !== undefined && d.resultShape !== "mysql-resultsets")
        )
          throw Error("数据库任务来源格式无效");
        data = {
          connectionId: text(d.connectionId, 800, true),
          query: text(d.query, 200000, true),
          isConsoleOutput: d.isConsoleOutput,
          variables: array(d.variables, 100).map((v) => {
            plain(v, ["name", "type", "pattern"]);
            if (!["environment", "global", "temporary"].includes(v.type))
              throw Error("数据库任务来源变量作用域无效");
            return {
              name: text(v.name, 800, true),
              type: v.type,
              pattern: text(v.pattern, 4000),
            };
          }),
          ...(d.resultShape === undefined
            ? {}
            : { resultShape: d.resultShape }),
        };
      } else throw Error("未知任务来源类型");
      const metadata = {};
      for (const key of ["id", "name"])
        if (task[key] !== undefined) metadata[key] = text(task[key], 800, true);
      if (task.origin !== undefined) {
        plain(task.origin, ["scope", "id"]);
        if (
          !["project", "folder", "request", "sample"].includes(
            task.origin.scope,
          )
        )
          throw Error("任务来源作用域无效");
        metadata.origin = {
          scope: task.origin.scope,
          id: text(task.origin.id, 800, true),
        };
      }
      return { type: task.type, enabled: task.enabled, data, ...metadata };
    });
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 262144)
    throw Error("任务来源合计最多256KiB");
  return result;
}
