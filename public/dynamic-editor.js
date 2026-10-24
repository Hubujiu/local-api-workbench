import {
  parseApipostFunctionTemplate,
  isApipostFunctionSource,
} from "./apipost-function-template.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function dynamicEditor(spec) {
  const source = spec?.source || "fixed";
  const select = (key, values, value) =>
    `<select data-dynamic-field="${key}">${values.map((v) => `<option ${v === value ? "selected" : ""}>${v}</option>`).join("")}</select>`;
  return `<details class="step-dynamic"><summary>动态值${spec ? " · 已配置" : ""}</summary><label><input type="checkbox" data-dynamic-enabled ${spec ? "checked" : ""}>启用动态值</label><label>来源${select("source", ["fixed", "variable", "mock", "apipost-function", "apipost-header-function", "apipost-form-function", "apipost-body-function"], source)}</label><label>固定JSON / 变量名 / Mock表达式<textarea data-dynamic-field="value" spellcheck="false">${esc(source === "fixed" ? JSON.stringify(spec?.value ?? null) : spec?.value || "")}</textarea></label><label>依次处理函数（逗号分隔）<input data-dynamic-field="functions" value="${esc((spec?.functions || []).join(","))}"></label><div data-dynamic-mock ${source === "mock" ? "" : "hidden"}><label>Mock类型${select("type", ["string", "integer", "number", "boolean", "object", "array"], spec?.type || "string")}</label><label>Mock种子（可选）<input type="number" data-dynamic-field="seed" value="${esc(spec?.seed ?? "")}"></label></div><p class="muted">发送时读取前置脚本后的变量；这里只配置，不执行预览。文件字段不支持动态文本。apipost-function用于Query，apipost-header-function用于Header，apipost-form-function用于表单文本，apipost-body-function用于完整raw/JSON正文且须选择text原文输出；完整模板允许响应后置脚本及仅改变量的前置脚本，不支持前置请求修改，支持原样函数参数、安全点路径变量或引号原文起始；首函数抛错保留首段模板，后续抛错保留上一步值；支持无参数fn_及lower/upper/length/number及concat/lconcat原文拼接、substr有界整数截取、padstart/padend有界填充及URI编解码加工链；MD5/SHA、Base64文本及ISO日期加工暂不能与共享函数混用，不支持额外原生加工链。取消不修改快照。</p></details>`;
}
export function parseDynamicEdits(fields, previous = {}) {
  if (!fields.enabled) return null;
  if (
    ![
      "fixed",
      "variable",
      "mock",
      "apipost-function",
      "apipost-header-function",
      "apipost-form-function",
      "apipost-body-function",
    ].includes(fields.source)
  )
    throw Error("动态值来源无效");
  let value = fields.value;
  if (fields.source === "fixed") {
    try {
      value = JSON.parse(value);
    } catch {
      throw Error("固定动态值必须是有效JSON");
    }
    if (
      JSON.stringify(value, (_key, v) => {
        if (typeof v === "number" && !Number.isFinite(v))
          throw Error("动态值必须是有限JSON值");
        return v;
      }) === undefined
    )
      throw Error("动态值必须是JSON");
  } else if (typeof value !== "string" || !value.trim())
    throw Error("变量名或Mock表达式不能为空");
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
    throw Error("动态值超过64KiB");
  const functions = String(fields.functions || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (functions.length > 10) throw Error("动态值最多10个处理函数");
  if (isApipostFunctionSource(fields.source)) {
    parseApipostFunctionTemplate(value);
    if (functions.length) throw Error("原版函数模板暂不支持额外加工链");
  }
  const next = {
    ...structuredClone(previous),
    source: fields.source,
    value,
    functions,
  };
  if (fields.source === "mock") {
    if (
      !["string", "integer", "number", "boolean", "object", "array"].includes(
        fields.type,
      )
    )
      throw Error("Mock类型无效");
    next.type = fields.type;
    if (String(fields.seed ?? "").trim() === "") delete next.seed;
    else {
      const seed = Number(fields.seed);
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295)
        throw Error("Mock种子必须为0至4294967295的整数");
      next.seed = seed;
    }
  } else {
    delete next.type;
    delete next.seed;
  }
  return next;
}

export function bindDynamicEditors(container) {
  for (const source of container.querySelectorAll(
    '[data-dynamic-field="source"]',
  )) {
    const update = () => {
      source
        .closest(".step-dynamic")
        .querySelector("[data-dynamic-mock]").hidden = source.value !== "mock";
    };
    source.onchange = update;
    update();
  }
}
