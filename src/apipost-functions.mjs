import { validateResources } from "./resources.mjs";
export function mergeApipostFunctions(rows, existing, projectId, document) {
  if (!Array.isArray(rows) || rows.length > 100)
    throw Error("Apipost共享函数最多100项");
  const incoming = [],
    names = new Set();
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).some(
        (k) =>
          ![
            "func_id",
            "func_name",
            "func_desc",
            "func_body",
            "project_id",
          ].includes(k),
      ) ||
      typeof row.func_name !== "string" ||
      !/^fn_[A-Za-z0-9_]+$/.test(row.func_name) ||
      typeof row.func_body !== "string"
    )
      throw Error("Apipost共享函数仅支持明确的fn_名称和文本函数体");
    if (row.project_id !== undefined && row.project_id !== projectId)
      throw Error("Apipost共享函数项目来源不匹配");
    const key = row.func_name.toLowerCase();
    if (names.has(key)) throw Error("Apipost共享函数名称忽略大小写后重复");
    names.add(key);
    incoming.push({
      name: row.func_name,
      kind: "transform",
      body: row.func_body,
      apipostSource: {
        projectId,
        ...(row.func_id !== undefined ? { id: row.func_id } : {}),
        description: row.func_desc ?? "",
      },
    });
  }
  validateResources({ functions: incoming });
  if (incoming.length) {
    const pending = [document],
      seen = new Set();
    let nodes = 0;
    while (pending.length) {
      if (++nodes > 100000) throw Error("Apipost共享函数依赖检查超过范围");
      const value = pending.pop();
      if (
        typeof value === "string" &&
        (/\$function\./i.test(value) || /\|\s*fn_/i.test(value))
      )
        throw Error(
          "Apipost共享函数参数模板和加工链尚未支持；仅支持脚本中的fn_调用",
        );
      if (value && typeof value === "object") {
        if (seen.has(value)) throw Error("Apipost共享函数依赖包含循环");
        seen.add(value);
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          if (nodes + pending.length >= 100000)
            throw Error("Apipost共享函数依赖检查超过范围");
          pending.push(value[key]);
        }
      }
    }
  }
  validateResources({ functions: existing || [] });
  const merged = structuredClone(existing || []);
  for (const fn of incoming) {
    const old = merged.find(
      (item) => item.name.toLowerCase() === fn.name.toLowerCase(),
    );
    if (old && JSON.stringify(old) !== JSON.stringify(fn))
      throw Error("Apipost共享函数同名冲突，请导入新项目");
    if (!old) merged.push(fn);
  }
  validateResources({ functions: merged });
  return merged;
}
