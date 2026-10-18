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
  return `<details class="step-dynamic"><summary>动态值${spec ? " · 已配置" : ""}</summary><label><input type="checkbox" data-dynamic-enabled ${spec ? "checked" : ""}>启用动态值</label><label>来源${select("source", ["fixed", "variable", "mock"], source)}</label><label>固定JSON / 变量名 / Mock表达式<textarea data-dynamic-field="value" spellcheck="false">${esc(source === "fixed" ? JSON.stringify(spec?.value ?? null) : spec?.value || "")}</textarea></label><label>依次处理函数（逗号分隔）<input data-dynamic-field="functions" value="${esc((spec?.functions || []).join(","))}"></label><label>Mock类型${select("type", ["string", "integer", "number", "boolean", "object", "array"], spec?.type || "string")}</label><label>Mock种子（可选）<input type="number" data-dynamic-field="seed" value="${esc(spec?.seed ?? "")}"></label><p class="muted">发送时读取前置脚本后的变量；这里只配置，不执行预览。文件字段不支持动态文本。取消不修改快照。</p></details>`;
}
export function parseDynamicEdits(fields, previous = {}) {
  if (!fields.enabled) return null;
  if (!["fixed", "variable", "mock"].includes(fields.source))
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
