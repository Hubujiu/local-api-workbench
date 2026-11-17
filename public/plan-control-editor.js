import { parsePlanStepJSON, planStepSummary } from "./plan-step-types.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const conditionOps = {
  eq: "等于",
  neq: "不等于",
  gt: "大于",
  gte: "大于或等于",
  lt: "小于",
  lte: "小于或等于",
  contains: "包含文本",
  notContains: "不包含文本",
};
const sources = {
  text: "文本",
  number: "数字",
  true: "布尔 true",
  false: "布尔 false",
  null: "null",
  globals: "全局变量",
  environment: "环境变量",
  runtime: "运行时变量",
  iterationData: "当前数据行字段",
};
const owns = (o, k) => Object.hasOwn(o, k);
const exact = (o, keys) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).length === keys.length &&
  keys.every((k) => owns(o, k));
export const isControlStep = (step) =>
  step && ["repeat", "if"].includes(step.type);
function operandFields(o) {
  if (exact(o, ["literal"])) {
    const v = o.literal;
    if (v === null) return { kind: "null", value: "" };
    if (typeof v === "boolean") return { kind: String(v), value: "" };
    if (typeof v === "number" && Number.isFinite(v))
      return { kind: "number", value: String(v) };
    if (typeof v === "string") return { kind: "text", value: v };
  }
  if (
    exact(o, ["scope", "name"]) &&
    ["globals", "environment", "runtime", "iterationData"].includes(o.scope) &&
    typeof o.name === "string"
  )
    return { kind: o.scope, value: o.name };
  return null;
}
export function visualCondition(condition) {
  if (
    !exact(condition, ["op", "left", "right"]) ||
    !owns(conditionOps, condition.op)
  )
    return null;
  const left = operandFields(condition.left),
    right = operandFields(condition.right);
  return left && right ? { op: condition.op, left, right } : null;
}
const defaultCondition = () => ({
  op: "eq",
  left: { literal: true },
  right: { literal: true },
});
function nodes(step) {
  const out = [];
  const visit = (node, path, depth) => {
    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      depth > 8 ||
      out.length >= 200
    )
      return;
    out.push({ node, path });
    if (isControlStep(node) && Array.isArray(node.steps))
      node.steps.forEach((child, i) => visit(child, [...path, i], depth + 1));
  };
  visit(step, [], 0);
  return out;
}
const key = (path, field) => `${path.join(".") || "root"}:${field}`;
export function visualControlValues(step) {
  const values = {};
  for (const { node, path } of nodes(step)) {
    values[key(path, "name")] = node.name ?? "";
    values[key(path, "enabled")] = node.enabled !== false;
    if (node.type === "repeat") {
      if (!owns(node, "rowsFrom") && !owns(node, "rows"))
        values[key(path, "count")] = String(node.count);
      values[key(path, "intervalMs")] = String(node.intervalMs ?? 0);
    }
    if (!isControlStep(node)) continue;
    const field = node.type === "if" ? "condition" : "untilCondition";
    const c =
        node[field] ?? (node.type === "repeat" ? defaultCondition() : null),
      v = visualCondition(c);
    if (!v) continue;
    if (node.type === "repeat")
      values[key(path, "untilEnabled")] = owns(node, field);
    values[key(path, "op")] = v.op;
    for (const side of ["left", "right"])
      for (const part of ["kind", "value"])
        values[key(path, `${side}.${part}`)] = v[side][part];
  }
  return values;
}
function parseOperand(kind, value) {
  if (kind === "true" || kind === "false") return { literal: kind === "true" };
  if (kind === "null") return { literal: null };
  if (kind === "number") {
    let number;
    try {
      number = JSON.parse(value);
    } catch {
      throw Error("条件数字须填写有效的有限数字");
    }
    if (typeof number !== "number" || !Number.isFinite(number))
      throw Error("条件数字须填写有效的有限数字");
    return { literal: number };
  }
  if (kind === "text") {
    if (
      !value ||
      !value.isWellFormed() ||
      new TextEncoder().encode(value).length > 8192
    )
      throw Error("条件文本须为1至8192 UTF-8字节");
    return { literal: value };
  }
  if (
    !["globals", "environment", "runtime", "iterationData"].includes(kind) ||
    !value.trim() ||
    value.length > 200 ||
    !value.isWellFormed() ||
    ["__proto__", "prototype", "constructor"].includes(value)
  )
    throw Error("条件变量来源或名称无效");
  return { scope: kind, name: value };
}
function parseCondition(values, path) {
  const op = values[key(path, "op")];
  if (!owns(conditionOps, op)) throw Error("条件操作无效");
  const left = parseOperand(
      values[key(path, "left.kind")],
      values[key(path, "left.value")],
    ),
    right = parseOperand(
      values[key(path, "right.kind")],
      values[key(path, "right.value")],
    );
  const literals = [left, right]
    .filter((x) => owns(x, "literal"))
    .map((x) => x.literal);
  if (
    literals.length === 2 &&
    (typeof literals[0] !== typeof literals[1] ||
      (literals[0] === null) !== (literals[1] === null))
  )
    throw Error("条件两侧类型必须一致，不会自动转换文本和数字");
  if (
    ["gt", "gte", "lt", "lte"].includes(op) &&
    literals.some((x) => typeof x !== "number")
  )
    throw Error("顺序比较只支持数字");
  if (
    ["contains", "notContains"].includes(op) &&
    literals.some((x) => typeof x !== "string")
  )
    throw Error("包含比较只支持文本");
  return { op, left, right };
}
function integer(value, min, max, label) {
  if (!/^\d+$/.test(value)) throw Error(`${label}须为${min}至${max}的整数`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error(`${label}须为${min}至${max}的整数`);
  return n;
}
export function applyVisualControls(step, supplied) {
  const before = visualControlValues(step),
    values = { ...before, ...supplied },
    candidate = structuredClone(step);
  for (const { node, path } of nodes(candidate)) {
    const changed = (field) =>
      owns(before, key(path, field)) &&
      values[key(path, field)] !== before[key(path, field)];
    if (changed("name")) node.name = String(values[key(path, "name")]);
    if (changed("enabled")) {
      if (typeof values[key(path, "enabled")] !== "boolean")
        throw Error("启用状态无效");
      node.enabled = values[key(path, "enabled")];
    }
    if (changed("count"))
      node.count = integer(values[key(path, "count")], 1, 100, "循环次数");
    if (changed("intervalMs"))
      node.intervalMs = integer(
        values[key(path, "intervalMs")],
        0,
        10000,
        "循环间隔",
      );
    if (!isControlStep(node)) continue;
    const field = node.type === "if" ? "condition" : "untilCondition";
    if (
      !visualCondition(
        node[field] ?? (node.type === "repeat" ? defaultCondition() : null),
      )
    )
      continue;
    const conditionChanged = [
      "op",
      "left.kind",
      "left.value",
      "right.kind",
      "right.value",
    ].some(changed);
    if (node.type === "repeat") {
      if (
        changed("untilEnabled") &&
        typeof values[key(path, "untilEnabled")] !== "boolean"
      )
        throw Error("提前结束状态无效");
      if (values[key(path, "untilEnabled")] === false) {
        if (changed("untilEnabled")) delete node.untilCondition;
        continue;
      }
    }
    if (conditionChanged || changed("untilEnabled"))
      node[field] = parseCondition(values, path);
  }
  return candidate;
}
const optionList = (choices, value) =>
  Object.entries(choices)
    .map(
      ([k, label]) =>
        `<option value="${esc(k)}" ${k === value ? "selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
function renderVisual(step) {
  const values = visualControlValues(step);
  const input = (path, field, label, type = "text") =>
    type === "text"
      ? `<label>${esc(label)}<textarea rows="2" data-control-key="${key(path, field)}">\n${esc(values[key(path, field)])}</textarea></label>`
      : `<label>${esc(label)}<input data-control-key="${key(path, field)}" type="${type}" ${type === "checkbox" ? (values[key(path, field)] ? "checked" : "") : `value="${esc(values[key(path, field)])}"`}></label>`;
  const select = (path, field, label, choices) =>
    `<label>${esc(label)}<select data-control-key="${key(path, field)}">${optionList(choices, values[key(path, field)])}</select></label>`;
  return nodes(step)
    .map(({ node, path }) => {
      const summary = planStepSummary(node);
      let html =
        `<fieldset data-control-node="${path.join(".") || "root"}"><legend>${esc(path.length ? path.map((x) => x + 1).join(".") : "当前步骤")} · ${esc(summary.kind)}</legend>` +
        input(path, "name", "名称") +
        input(path, "enabled", "启用此步骤", "checkbox");
      if (node.type === "repeat") {
        html += owns(values, key(path, "count"))
          ? input(path, "count", "最多循环次数（1–100）", "number")
          : '<p class="notice">数据行数量、来源和上限保留原定义，请在 JSON 模式中编辑；不会转为固定次数循环。</p>';
        html += input(
          path,
          "intervalMs",
          "轮次间隔（毫秒，0–10000）",
          "number",
        );
      }
      if (isControlStep(node)) {
        const field = node.type === "if" ? "condition" : "untilCondition";
        if (owns(values, key(path, "op"))) {
          if (node.type === "repeat")
            html += input(
              path,
              "untilEnabled",
              "每轮后满足条件则提前结束",
              "checkbox",
            );
          html += `<fieldset data-control-condition="${path.join(".") || "root"}" ${node.type === "repeat" && !values[key(path, "untilEnabled")] ? "disabled" : ""}><legend>${node.type === "if" ? "执行条件" : "提前结束条件"}</legend>`;
          for (const side of ["left", "right"])
            html +=
              select(
                path,
                `${side}.kind`,
                `${side === "left" ? "左" : "右"}侧来源/类型`,
                sources,
              ) +
              input(
                path,
                `${side}.value`,
                "文本、数字或变量名（布尔/null无需填写）",
              );
          html += select(path, "op", "比较方式", conditionOps) + "</fieldset>";
        } else
          html +=
            '<p class="notice">此条件包含当前表单不支持的字段，已完整保留。请切换 JSON 模式编辑。</p>';
      } else
        html += `<p class="subtle">${esc(summary.detail)}。协议、请求及其他字段不在此表单修改，完整定义保留在 JSON 模式中。</p>`;
      return html + "</fieldset>";
    })
    .join("");
}
export function controlEditor(step) {
  return `<div class="step-editor"><p class="notice">可视化修改已有循环/条件及嵌套步骤名称和启用状态。尚不支持可视化新建、移动或删除子步骤；数据行和协议详情请用 JSON。未修改字段和步骤 ID 保留，保存由服务端校验，不会执行请求。</p><label>编辑模式<select data-control-mode><option value="visual">可视化</option><option value="json">完整 JSON</option></select></label><p data-control-error role="alert" hidden></p><div data-control-fields>${renderVisual(step)}</div><label data-control-json hidden>完整步骤 JSON<textarea data-step-json spellcheck="false" rows="18">${esc(JSON.stringify(step, null, 2))}</textarea></label></div>`;
}
export function bindControlEditor(container, step) {
  let draft = structuredClone(step),
    mode = "visual";
  const modeSelect = container.querySelector("[data-control-mode]"),
    fields = container.querySelector("[data-control-fields]"),
    json = container.querySelector("[data-step-json]"),
    jsonHolder = container.querySelector("[data-control-json]"),
    error = container.querySelector("[data-control-error]");
  const readValues = () => {
    const values = {};
    for (const field of fields.querySelectorAll("[data-control-key]"))
      values[field.dataset.controlKey] =
        field.type === "checkbox" ? field.checked : field.value;
    return values;
  };
  // HTML controls normalize line endings. Capture what the browser actually
  // displays, not a re-serialization of canonical data; untouched fields must
  // keep the exact original bytes even across JSON/visual mode changes.
  let baseline = readValues();
  const collect = () => {
    if (mode === "json") return parsePlanStepJSON(step, json.value);
    const edits = {};
    for (const [key, value] of Object.entries(readValues()))
      if (Object.hasOwn(baseline, key) && value !== baseline[key])
        edits[key] = value;
    return applyVisualControls(draft, edits);
  };
  modeSelect.addEventListener("change", () => {
    const next = modeSelect.value;
    try {
      const value = collect();
      draft = value;
      mode = next;
      if (next === "json") json.value = JSON.stringify(draft, null, 2);
      else {
        fields.innerHTML = renderVisual(draft);
        baseline = readValues();
      }
      fields.hidden = next === "json";
      jsonHolder.hidden = next !== "json";
      error.hidden = true;
    } catch (e) {
      modeSelect.value = mode;
      error.textContent = e.message;
      error.hidden = false;
    }
  });
  fields.addEventListener("change", (event) => {
    const key = event.target.dataset.controlKey;
    if (!key?.endsWith(":untilEnabled")) return;
    const path = key.split(":")[0];
    fields.querySelector(`[data-control-condition="${path}"]`).disabled =
      !event.target.checked;
  });
  return collect;
}
