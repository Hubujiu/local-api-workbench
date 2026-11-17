import {
  parseApipostFunctionTemplate,
  isApipostBuiltinStage,
  apipostTemplateStages,
  isApipostTemplateCandidate,
} from "../public/apipost-function-template.js";
import { validateResources } from "./resources.mjs";
export function mergeApipostFunctions(
  rows,
  existing,
  projectId,
  document,
  { parameterTemplates = false, scanTemplates = false } = {},
) {
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
  if (incoming.length || scanTemplates) {
    const allowedRows = new Set(),
      allowedBodies = new Set();
    if (parameterTemplates && Array.isArray(document?.apis))
      for (const api of document.apis) {
        if (api.target_type !== "api") continue;
        if (["raw", "json", "plain", "text"].includes(api.request?.body?.mode))
          allowedBodies.add(api.request.body);
        for (const group of ["query", "header", "body"]) {
          if (
            group === "body" &&
            !["urlencoded", "form-data"].includes(api.request?.body?.mode)
          )
            continue;
          if (Array.isArray(api.request?.[group]?.parameter))
            for (const row of api.request[group].parameter)
              if (
                row &&
                row.is_checked === 1 &&
                String(row.type).toLowerCase() !== "file" &&
                !(
                  group === "body" &&
                  api.request.body.mode === "form-data" &&
                  String(row.field_type).toLowerCase() === "file"
                )
              )
                allowedRows.add(row);
        }
      }
    const functionBodies = new Set(rows);
    const pending = [{ value: document, allowed: false }],
      seen = new Set();
    let nodes = 0;
    while (pending.length) {
      if (++nodes > 100000) throw Error("Apipost共享函数依赖检查超过范围");
      const { value, allowed, opaque } = pending.pop();
      if (
        typeof value === "string" &&
        (/\$function\./i.test(value) ||
          /\|\s*fn_/i.test(value) ||
          (!opaque && isApipostTemplateCandidate(value)))
      ) {
        if (!allowed)
          throw Error(
            "Apipost共享函数参数模板仅支持启用的接口Query/Header/表单文本或完整正文值；仅支持白名单无参数加工链",
          );
        const parsed = parseApipostFunctionTemplate(value);
        if (
          apipostTemplateStages(parsed).some(
            (name) => !isApipostBuiltinStage(name) && !names.has(name),
          )
        )
          throw Error("Apipost函数模板引用不存在的来源函数");
      }
      if (value && typeof value === "object") {
        if (seen.has(value)) throw Error("Apipost共享函数依赖包含循环");
        seen.add(value);
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          if (nodes + pending.length >= 100000)
            throw Error("Apipost共享函数依赖检查超过范围");
          pending.push({
            value: value[key],
            opaque: key === "func_body" && functionBodies.has(value),
            allowed:
              (key === "value" && allowedRows.has(value)) ||
              (key === "raw" && allowedBodies.has(value)),
          });
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
