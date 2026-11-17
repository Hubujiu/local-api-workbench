const bytes = (text) => new TextEncoder().encode(text).length;
function plain(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("原始脚本任务来源须为普通对象");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value))
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    )
      throw Error("原始脚本任务来源包含未知字段或访问器");
}
export function normalizeImportedScriptTasks(value) {
  plain(value, ["version", "before", "after"]);
  if (value.version !== 1) throw Error("原始脚本任务来源版本无效");
  const result = { version: 1 };
  for (const phase of ["before", "after"]) {
    if (!Array.isArray(value[phase]) || value[phase].length > 16)
      throw Error("原始脚本任务每阶段最多16项");
    const entries = value[phase],
      descriptors = Object.getOwnPropertyDescriptors(entries);
    if (
      Object.getPrototypeOf(entries) !== Array.prototype ||
      Reflect.ownKeys(entries).length !== entries.length + 1
    )
      throw Error("原始脚本任务数组须为连续普通数组");
    for (let index = 0; index < entries.length; index++)
      if (
        !descriptors[index]?.enumerable ||
        !Object.hasOwn(descriptors[index], "value")
      )
        throw Error("原始脚本任务数组不能包含空洞或访问器");
    let total = 0;
    result[phase] = value[phase].map((task) => {
      plain(task, ["type", "id", "name", "enabled", "data", "origin"]);
      if (
        task.type !== "customScript" ||
        ![1, 0, -1].includes(task.enabled) ||
        typeof task.data !== "string"
      )
        throw Error("原始脚本任务仅支持明确启停的customScript来源");
      for (const key of ["id", "name"])
        if (
          typeof task[key] !== "string" ||
          !task[key].trim() ||
          task[key].length > 200 ||
          ["__proto__", "prototype", "constructor"].includes(task[key])
        )
          throw Error("原始脚本任务标识或名称无效");
      let origin;
      if (task.origin !== undefined) {
        plain(task.origin, ["scope", "id"]);
        if (
          !["project", "folder", "request", "sample"].includes(
            task.origin.scope,
          ) ||
          typeof task.origin.id !== "string" ||
          !task.origin.id.trim() ||
          task.origin.id.length > 200
        )
          throw Error("原始脚本任务作用域来源无效");
        origin = { scope: task.origin.scope, id: task.origin.id };
      }
      total += bytes(task.data);
      if (total > 65536) throw Error("原始脚本任务每阶段源码合计最多64KiB");
      return {
        type: task.type,
        id: task.id,
        name: task.name,
        enabled: task.enabled,
        data: task.data,
        ...(origin ? { origin } : {}),
      };
    });
  }
  if (bytes(JSON.stringify(result)) > 262144)
    throw Error("原始脚本任务来源合计超过256KiB");
  return result;
}
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
export function importedScriptTasksHTML(value) {
  if (value === undefined) return "";
  const source = normalizeImportedScriptTasks(value);
  return `<details class="imported-script-tasks"><summary>原始脚本任务来源（只读）</summary><p>此处保留导入时的名称、启停状态和源码，不参与执行。执行以当前前/后执行脚本为准；修改编辑器不会回写原始来源。停用源码不会自动启用。</p>${["before", "after"].flatMap((phase) => source[phase].map((task) => `<details><summary>${phase === "before" ? "前置" : "后置"} · ${escape(task.name)}${task.origin ? ` · ${{ project: "项目", folder: "目录", request: "接口", sample: "用例" }[task.origin.scope]}:${escape(task.origin.id)}` : ""} · ${task.enabled === 1 ? "原始启用" : "原始停用"}</summary><pre>${escape(task.data)}</pre></details>`)).join("")}</details>`;
}
