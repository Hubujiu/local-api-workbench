import {
  normalizeScriptDialect,
  scriptDialectOptions,
  scriptDialectNotice,
} from "./script-dialect.js";
import {
  dynamicEditor,
  parseDynamicEdits,
  bindDynamicEditors,
} from "./dynamic-editor.js";
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
    '<details><summary>Raw Body动态值</summary><p class="muted">JSON输出自动转义，不要再给占位符加引号。移除会删除当前正文中的同名占位符，保存前可取消。</p><div data-step-body-dynamics>' +
    Object.entries(r.bodyDynamic || {})
      .map(([id, spec]) => bodyDynamicRow(id, spec))
      .join("") +
    '</div><button type="button" data-step-body-add>添加Body动态值</button></details>' +
    '<details><summary>表单字段（form-data / urlencoded）</summary><div data-step-pairs="form">' +
    (r.form || []).map((row, index) => pairRow("form", index, row)).join("") +
    '</div><button data-step-add="form">添加表单字段</button></details><p class="muted">文件由你选择后保存在步骤快照，最多6MiB；参数动态值可在各行配置，Raw Body占位符在上方独立编辑。</p></details>' +
    '<details><summary>连接与证书</summary><label>超时（100–60000ms）</label><input type="number" min="100" max="60000" data-step-field="timeout" value="' +
    esc(r.timeout ?? 15000) +
    '"><label>协议版本</label><select data-step-field="httpVersion"><option value="1.1" ' +
    (r.httpVersion !== "2" ? "selected" : "") +
    '>HTTP/1.1</option><option value="2" ' +
    (r.httpVersion === "2" ? "selected" : "") +
    ">HTTP/2</option></select>" +
    input("proxy", "HTTP/HTTPS代理", r.proxy) +
    ["ca", "proxyCa", "cert", "key"]
      .map(
        (key) =>
          "<label>" +
          {
            ca: "自定义CA（PEM）",
            proxyCa: "HTTPS代理CA（PEM）",
            cert: "客户端证书（PEM）",
            key: "客户端私钥（PEM）",
          }[key] +
          '</label><textarea data-step-tls="' +
          key +
          '" spellcheck="false">' +
          esc(r.tls?.[key] || "") +
          "</textarea>",
      )
      .join("") +
    '<label>私钥口令</label><input type="password" data-step-tls="passphrase" value="' +
    esc(r.tls?.passphrase || "") +
    '"><p class="notice">TLS验证始终开启。证书与私钥会保存到本地计划快照，导出前请清除敏感凭据。HTTP/2代理使用CONNECT隧道。</p></details>' +
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
    `<label>脚本兼容模式<select data-step-field="scriptDialect">${scriptDialectOptions(r.scriptDialect)}</select></label><p class="muted">${scriptDialectNotice}</p>` +
    textarea("beforeScript", "前置脚本（隔离 VM）", r.beforeScript) +
    textarea("afterScript", "后置脚本（隔离 VM）", r.afterScript) +
    "</details></div>"
  );
}
function bodyDynamicRow(id, spec) {
  return `<div data-step-body-dynamic="${esc(id)}"><code>{{@value:${esc(id)}}}</code><label>输出格式<select data-step-body-format><option value="json" ${spec.format !== "text" ? "selected" : ""}>JSON值</option><option value="text" ${spec.format === "text" ? "selected" : ""}>原始文本</option></select></label><button type="button" data-step-body-insert>插入正文光标处</button><button type="button" data-step-body-remove>移除定义和占位符</button>${dynamicEditor(spec)}</div>`;
}
export function pairRow(key, index, row = {}) {
  if (key === "form")
    return (
      '<div class="step-form-row" data-step-pair-row="form:' +
      index +
      '"><input type="checkbox" data-step-enabled ' +
      (row.enabled !== false ? "checked" : "") +
      ' aria-label="启用参数"><input data-step-key aria-label="参数名" value="' +
      esc(row.key) +
      '"><select data-step-form-type aria-label="表单类型"><option value="text" ' +
      (row.type !== "file" ? "selected" : "") +
      '>文本</option><option value="file" ' +
      (row.type === "file" ? "selected" : "") +
      '>文件</option></select><input data-step-value aria-label="参数值" value="' +
      esc(row.type === "file" ? "" : row.value) +
      '" ' +
      (row.type === "file" ? "hidden" : "") +
      '><input type="file" data-step-file ' +
      (row.type === "file" ? "" : "hidden") +
      '><span class="step-file-status">' +
      esc(row.type === "file" ? row.filename || "未选择文件" : "") +
      '</span><button data-step-remove aria-label="移除参数">×</button>' +
      dynamicEditor(row.dynamic) +
      "</div>"
    );
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
    '" placeholder="参数值" aria-label="参数值"><button data-step-remove aria-label="移除参数">×</button>' +
    dynamicEditor(row.dynamic) +
    "</div>"
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
    "proxy",
  ])
    if (Object.hasOwn(fields, key)) next.request[key] = fields[key];
  if (Object.hasOwn(fields, "scriptDialect"))
    next.request.scriptDialect = normalizeScriptDialect(fields.scriptDialect);
  if (Object.hasOwn(fields, "timeout")) {
    const timeout = Number(fields.timeout);
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000)
      throw Error("超时须为100至60000毫秒");
    next.request.timeout = timeout;
  }
  if (Object.hasOwn(fields, "httpVersion")) {
    if (!["1.1", "2"].includes(fields.httpVersion)) throw Error("协议版本无效");
    next.request.httpVersion = fields.httpVersion;
  }
  if (fields.tls) {
    next.request.tls = { ...next.request.tls };
    for (const key of ["ca", "proxyCa", "cert", "key", "passphrase"])
      if (Object.hasOwn(fields.tls, key))
        next.request.tls[key] = String(fields.tls[key]);
  }
  for (const key of ["headers", "query", "path", "cookies", "form"]) {
    if (!pairGroups[key]) continue;
    next.request[key] = pairGroups[key].map((row) => {
      const result = {
        ...(Number.isInteger(row.index)
          ? structuredClone(step.request[key]?.[row.index] || {})
          : {}),
        key: String(row.key),
        value: String(row.value),
        enabled: Boolean(row.enabled),
      };
      if (Object.hasOwn(row, "dynamic")) {
        if (row.dynamic === null) delete result.dynamic;
        else result.dynamic = structuredClone(row.dynamic);
      }
      if (key === "form") {
        if (row.type === "file" && result.dynamic)
          throw Error("文件参数不能配置动态文本，请关闭动态值");
        if (!["text", "file"].includes(row.type)) throw Error("表单类型无效");
        result.type = row.type;
        if (row.type === "file") {
          result.filename = String(row.filename || "");
          result.requiresFile = Boolean(row.requiresFile);
        } else {
          delete result.filename;
          delete result.requiresFile;
        }
      }
      return result;
    });
  }
  if (Object.hasOwn(fields, "bodyDynamic")) {
    const definitions = fields.bodyDynamic;
    if (
      !definitions ||
      typeof definitions !== "object" ||
      Array.isArray(definitions) ||
      Object.keys(definitions).length > 100
    )
      throw Error("Body动态定义最多100项");
    for (const [id, spec] of Object.entries(definitions)) {
      if (
        !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
        ["__proto__", "prototype", "constructor"].includes(id)
      )
        throw Error("Body动态标识无效");
      if (!spec || !["json", "text"].includes(spec.format))
        throw Error("Body动态值输出格式无效");
    }
    for (const match of String(next.request.body || "").matchAll(
      /\{\{@value:([A-Za-z0-9_-]{1,100})\}\}/g,
    ))
      if (!Object.hasOwn(definitions, match[1]))
        throw Error("正文仍引用已关闭或移除的Body动态值");
    next.request.bodyDynamic = structuredClone(definitions);
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
  const bodyDefinitions = structuredClone(step.request.bodyDynamic || {});
  const bodyHolder = container.querySelector("[data-step-body-dynamics]");
  const bodyText = container.querySelector('[data-step-field="body"]');
  const bindBodyDynamics = () => {
    bindDynamicEditors(container);
    for (const row of bodyHolder.querySelectorAll("[data-step-body-dynamic]")) {
      const id = row.dataset.stepBodyDynamic,
        token = "{{@value:" + id + "}}";
      row.querySelector("[data-step-body-insert]").onclick = () => {
        const start = bodyText.selectionStart,
          end = bodyText.selectionEnd;
        bodyText.value =
          bodyText.value.slice(0, start) + token + bodyText.value.slice(end);
        bodyText.focus();
        bodyText.setSelectionRange(start + token.length, start + token.length);
      };
      row.querySelector("[data-step-body-remove]").onclick = () => {
        bodyText.value = bodyText.value.split(token).join("");
        row.remove();
        container.querySelector("[data-step-body-add]").disabled =
          bodyHolder.children.length >= 100;
      };
    }
  };
  container.querySelector("[data-step-body-add]").onclick = () => {
    if (bodyHolder.children.length >= 100) return;
    const id = crypto.randomUUID(),
      spec = { source: "fixed", value: null, format: "json", functions: [] };
    bodyDefinitions[id] = spec;
    bodyHolder.insertAdjacentHTML("beforeend", bodyDynamicRow(id, spec));
    bindBodyDynamics();
    bodyHolder.lastElementChild.querySelector(".step-dynamic").open = true;
    container.querySelector("[data-step-body-add]").disabled =
      bodyHolder.children.length >= 100;
  };
  bindBodyDynamics();
  container.querySelector("[data-step-body-add]").disabled =
    bodyHolder.children.length >= 100;
  container.querySelector("[data-step-body-add]").title =
    "最多100个Body动态定义";
  const formRows = new WeakMap();
  const bindFormRows = () => {
    bindDynamicEditors(container);
    for (const row of container.querySelectorAll(
      '[data-step-pairs="form"] [data-step-pair-row]',
    )) {
      if (formRows.has(row)) continue;
      const index = Number(row.dataset.stepPairRow.split(":")[1]);
      const original = step.request.form?.[index] || {};
      const state = {
        type: original.type || "text",
        value: original.value || "",
        filename: original.filename || "",
        requiresFile:
          original.requiresFile ??
          (original.type === "file" && !original.filename),
        generation: 0,
        pending: false,
        error: "",
      };
      formRows.set(row, state);
      const status = row.querySelector(".step-file-status");
      row.querySelector("[data-step-form-type]").onchange = (event) => {
        state.type = event.target.value;
        state.value = "";
        state.filename = "";
        state.requiresFile = state.type === "file";
        state.generation++;
        state.pending = false;
        state.error = "";
        row.querySelector("[data-step-value]").hidden = state.type === "file";
        row.querySelector("[data-step-file]").hidden = state.type !== "file";
        row.querySelector("[data-step-file]").value = "";
        row.querySelector("[data-step-value]").value = "";
        status.textContent = state.type === "file" ? "未选择文件" : "";
      };
      row.querySelector("[data-step-file]").onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const generation = ++state.generation;
        state.pending = true;
        state.error = "";
        status.textContent = "读取中…";
        try {
          if (file.size > 6 * 1024 * 1024) throw Error("文件不能超过6MiB");
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (generation !== state.generation) return;
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          state.value = btoa(binary);
          state.filename = file.name;
          state.requiresFile = false;
          status.textContent = file.name;
        } catch (error) {
          if (generation === state.generation) {
            state.error = error.message;
            status.textContent = error.message;
          }
        } finally {
          if (generation === state.generation) state.pending = false;
        }
      };
    }
  };
  bindFormRows();
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
      bindFormRows();
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
    fields.bodyDynamic = Object.fromEntries(
      [...bodyHolder.querySelectorAll("[data-step-body-dynamic]")].flatMap(
        (row) => {
          const id = row.dataset.stepBodyDynamic;
          const spec = parseDynamicEdits(
            {
              enabled: row.querySelector("[data-dynamic-enabled]").checked,
              ...Object.fromEntries(
                [...row.querySelectorAll("[data-dynamic-field]")].map(
                  (element) => [element.dataset.dynamicField, element.value],
                ),
              ),
            },
            bodyDefinitions[id],
          );
          return spec
            ? [
                [
                  id,
                  {
                    ...spec,
                    format: row.querySelector("[data-step-body-format]").value,
                  },
                ],
              ]
            : [];
        },
      ),
    );
    fields.auth = collectAuth();
    fields.tls = Object.fromEntries(
      [...container.querySelectorAll("[data-step-tls]")].map((element) => [
        element.dataset.stepTls,
        element.value,
      ]),
    );
    const groups = {},
      rules = {};
    for (const kind of ["headers", "query", "path", "cookies", "form"])
      groups[kind] = [
        ...container.querySelectorAll(
          '[data-step-pairs="' + kind + '"] [data-step-pair-row]',
        ),
      ].map((row) => {
        const state = formRows.get(row);
        if (state?.pending) throw Error("文件正在读取，请稍后保存");
        if (state?.error) throw Error(state.error);
        return {
          index: Number(row.dataset.stepPairRow.split(":")[1]),
          key: row.querySelector("[data-step-key]").value,
          value: row.querySelector("[data-step-value]").value,
          enabled: row.querySelector("[data-step-enabled]").checked,
          dynamic: parseDynamicEdits(
            {
              enabled: row.querySelector("[data-dynamic-enabled]").checked,
              ...Object.fromEntries(
                [...row.querySelectorAll("[data-dynamic-field]")].map(
                  (element) => [element.dataset.dynamicField, element.value],
                ),
              ),
            },
            step.request[kind]?.[Number(row.dataset.stepPairRow.split(":")[1])]
              ?.dynamic,
          ),
          ...(state
            ? {
                type: state.type,
                ...(state.type === "file"
                  ? {
                      value: state.value,
                      filename: state.filename,
                      requiresFile: state.requiresFile,
                    }
                  : {}),
              }
            : {}),
        };
      });
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
