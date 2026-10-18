import { authPanel } from "./auth-view.js";
import { validateAuth } from "./auth-model.js";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function stepEditor(step) {
  const r = step.request;
  const input = (key, label, value) =>
    "<label>" +
    label +
    '</label><input data-step-field="' +
    key +
    '" value="' +
    esc(value) +
    '">';
  const textarea = (key, label, value) =>
    "<label>" +
    label +
    '</label><textarea data-step-field="' +
    key +
    '" spellcheck="false">' +
    esc(value) +
    "</textarea>";
  return (
    '<div class="step-editor"><p class="notice">仅编辑此步骤快照；不修改源接口。变量使用 {{name}}。</p>' +
    input("name", "步骤名称", step.name) +
    '<label>请求方法</label><select data-step-field="method">' +
    ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
      .map(
        (m) =>
          "<option " +
          (r.method === m ? "selected" : "") +
          ">" +
          m +
          "</option>",
      )
      .join("") +
    "</select>" +
    input("url", "请求 URL", r.url) +
    ["headers", "query", "path", "cookies"]
      .map(
        (key) =>
          "<details><summary>" +
          {
            headers: "Header",
            query: "Query",
            path: "Path",
            cookies: "Cookie",
          }[key] +
          '</summary><div data-step-pairs="' +
          key +
          '">' +
          (r[key] || [])
            .map((row, index) => pairRow(key, index, row))
            .join("") +
          '</div><button data-step-add="' +
          key +
          '">添加参数</button></details>',
      )
      .join("") +
    '<details open><summary>请求体</summary><label>Body 类型</label><select data-step-field="bodyType">' +
    ["none", "json", "raw", "form-data", "urlencoded", "binary", "msgpack"]
      .map(
        (t) =>
          "<option " +
          (r.bodyType === t ? "selected" : "") +
          ">" +
          t +
          "</option>",
      )
      .join("") +
    "</select>" +
    textarea("body", "JSON / 文本 / Base64 内容", r.body) +
    '<p class="muted">表单文件、TLS与动态值定义保留；复杂配置可用计划JSON编辑。</p></details>' +
    '<details><summary>认证</summary><div id="step-auth">' +
    authPanel(r.auth, { acquire: false }) +
    "</div></details>" +
    ["assertions", "extract"]
      .map(
        (kind) =>
          "<details><summary>" +
          (kind === "assertions" ? "断言" : "变量提取") +
          '</summary><div data-step-rules="' +
          kind +
          '">' +
          (r[kind] || [])
            .map((rule, index) => stepRuleRow(kind, index, rule))
            .join("") +
          '</div><button data-step-rule-add="' +
          kind +
          '">添加' +
          (kind === "assertions" ? "断言" : "提取") +
          "</button></details>",
      )
      .join("") +
    "<details><summary>本步骤脚本</summary>" +
    textarea("beforeScript", "前置脚本（隔离 VM）", r.beforeScript) +
    textarea("afterScript", "后置脚本（隔离 VM）", r.afterScript) +
    "</details></div>"
  );
}
export function pairRow(key, index, row = {}) {
  return (
    '<div class="row" data-step-pair-row="' +
    key +
    ":" +
    index +
    '"><input type="checkbox" data-step-enabled ' +
    (row.enabled !== false ? "checked" : "") +
    ' aria-label="启用参数"><input data-step-key value="' +
    esc(row.key) +
    '" placeholder="参数名" aria-label="参数名"><input data-step-value value="' +
    esc(row.value) +
    '" placeholder="参数值" aria-label="参数值"><button data-step-remove aria-label="移除参数">×</button></div>'
  );
}
export function applyStepEdits(step, fields, pairGroups, rules = {}) {
  const next = structuredClone(step);
  next.name = String(fields.name || "").trim();
  if (!next.name) throw Error("步骤名称不能为空");
  for (const key of [
    "method",
    "url",
    "bodyType",
    "body",
    "beforeScript",
    "afterScript",
  ])
    if (Object.hasOwn(fields, key)) next.request[key] = fields[key];
  for (const key of ["headers", "query", "path", "cookies"]) {
    if (!pairGroups[key]) continue;
    next.request[key] = pairGroups[key].map((row) => ({
      ...(Number.isInteger(row.index)
        ? structuredClone(step.request[key]?.[row.index] || {})
        : {}),
      key: String(row.key),
      value: String(row.value),
      enabled: Boolean(row.enabled),
    }));
  }
  if (fields.auth) {
    validateAuth(fields.auth);
    next.request.auth = structuredClone(fields.auth);
  }
  for (const kind of ["assertions", "extract"])
    if (rules[kind]) {
      next.request[kind] = rules[kind].map((row) => {
        const rule = {
          ...(row.index >= 0
            ? structuredClone(step.request[kind]?.[row.index] || {})
            : {}),
        };
        if (kind === "assertions") {
          if (
            !row.target.trim() ||
            !["eq", "neq", "contains", "exists", "lt", "gt"].includes(row.op)
          )
            throw Error("断言目标或操作无效");
          let value = row.value;
          try {
            value = JSON.parse(value);
          } catch {}
          return { ...rule, target: row.target.trim(), op: row.op, value };
        }
        if (
          !row.name.trim() ||
          ["__proto__", "prototype", "constructor"].includes(row.name.trim())
        )
          throw Error("提取变量名称无效");
        if (
          ![
            "json",
            "header",
            "cookie",
            "duration",
            "text",
            "regex",
            "xml",
          ].includes(row.source) ||
          !["runtime", "local", "environment", "global"].includes(row.scope)
        )
          throw Error("提取来源或作用域无效");
        const group = Number(row.group || 0);
        if (!Number.isInteger(group) || group < 0 || group > 99)
          throw Error("捕获组须为0至99");
        return {
          ...rule,
          name: row.name.trim(),
          source: row.source,
          scope: row.scope,
          path: row.path,
          group,
        };
      });
    }
  return next;
}

export function stepRuleRow(kind, index, rule = {}) {
  const input = (key, value, placeholder = "") =>
    `<input data-step-rule-field="${key}" value="${esc(value)}" placeholder="${placeholder}">`;
  const select = (key, values, value) =>
    `<select data-step-rule-field="${key}">${values.map((v) => `<option ${v === value ? "selected" : ""}>${v}</option>`).join("")}</select>`;
  const fields =
    kind === "assertions"
      ? input(
          "target",
          rule.target || "status",
          "status / header:name / $.path",
        ) +
        select(
          "op",
          ["eq", "neq", "contains", "exists", "lt", "gt"],
          rule.op || "eq",
        ) +
        input(
          "value",
          JSON.stringify(Object.hasOwn(rule, "value") ? rule.value : 200),
          "JSON或文本",
        )
      : input("name", rule.name || "", "变量名") +
        select(
          "scope",
          ["runtime", "local", "environment", "global"],
          rule.scope || "runtime",
        ) +
        select(
          "source",
          ["json", "header", "cookie", "duration", "text", "regex", "xml"],
          rule.source || "json",
        ) +
        input("path", rule.path || "", "路径 / Header / XPath") +
        input("group", rule.group ?? 0, "捕获组");
  return `<div class="row step-rule-row" data-step-rule-row="${kind}:${index}">${fields}<button data-step-rule-remove aria-label="移除规则">×</button></div>`;
}
export function bindStepEditor(container, step) {
  let auth = structuredClone(step.request.auth || { type: "none" });
  const authHolder = container.querySelector("#step-auth");
  const collectAuth = () => {
    for (const element of authHolder.querySelectorAll("[data-auth]"))
      auth[element.dataset.auth] = element.value;
    return auth;
  };
  const bindAuth = () => {
    authHolder.querySelector("#auth-type").onchange = (event) => {
      collectAuth();
      auth.type = event.target.value;
      authHolder.innerHTML = authPanel(auth, { acquire: false });
      bindAuth();
    };
  };
  bindAuth();
  const bindRemove = () => {
    for (const button of container.querySelectorAll(
      "[data-step-remove], [data-step-rule-remove]",
    )) {
      button.type = "button";
      button.onclick = () =>
        button.closest("[data-step-pair-row], [data-step-rule-row]").remove();
    }
  };
  for (const button of container.querySelectorAll("[data-step-add]"))
    button.onclick = () => {
      const group = button.dataset.stepAdd;
      container
        .querySelector('[data-step-pairs="' + group + '"]')
        .insertAdjacentHTML("beforeend", pairRow(group, -1));
      bindRemove();
    };
  for (const button of container.querySelectorAll("[data-step-rule-add]"))
    button.onclick = () => {
      const kind = button.dataset.stepRuleAdd;
      container
        .querySelector('[data-step-rules="' + kind + '"]')
        .insertAdjacentHTML("beforeend", stepRuleRow(kind, -1));
      bindRemove();
    };
  bindRemove();
  return () => {
    const fields = Object.fromEntries(
      [...container.querySelectorAll("[data-step-field]")].map((element) => [
        element.dataset.stepField,
        element.value,
      ]),
    );
    fields.auth = collectAuth();
    const groups = {},
      rules = {};
    for (const kind of ["headers", "query", "path", "cookies"])
      groups[kind] = [
        ...container.querySelectorAll(
          '[data-step-pairs="' + kind + '"] [data-step-pair-row]',
        ),
      ].map((row) => ({
        index: Number(row.dataset.stepPairRow.split(":")[1]),
        key: row.querySelector("[data-step-key]").value,
        value: row.querySelector("[data-step-value]").value,
        enabled: row.querySelector("[data-step-enabled]").checked,
      }));
    for (const kind of ["assertions", "extract"])
      rules[kind] = [
        ...container.querySelectorAll(
          '[data-step-rules="' + kind + '"] [data-step-rule-row]',
        ),
      ].map((row) => ({
        index: Number(row.dataset.stepRuleRow.split(":")[1]),
        ...Object.fromEntries(
          [...row.querySelectorAll("[data-step-rule-field]")].map((element) => [
            element.dataset.stepRuleField,
            element.value,
          ]),
        ),
      }));
    return applyStepEdits(step, fields, groups, rules);
  };
}
