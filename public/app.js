import { builtinVariableNames } from "./builtin-variable-catalog.js";
import {
  schemaEditor,
  bindSchemaEditor,
  editResponseDefinition,
} from "./schema-editor.js";
import { authPanel } from "./auth-view.js";
import { renderMarkdown } from "./vendor/markdown-renderer.js";
import { attributeFields, attributeChooser } from "./attribute-view.js";
import {
  attributeInputValue,
  validateAttributeDefinitions,
  validateAttributeValues,
  attributeTypes,
} from "./attribute-model.js";
import { errorCodeHTML } from "./error-code-view.js";
import { settingsPanel } from "./settings-view.js";
import { adoptVariableWrites } from "./variable-write-receipt.js";
import { stepEditor, bindStepEditor } from "./step-editor.js";
import {
  dictionaryPanel,
  dictionaryValue,
  insertDictionaryField,
  effectiveParameterDictionary,
} from "./dictionary-view.js";
import { clientConfiguration, mcpClients } from "./mcp-client-config.js";
import { renderPlans } from "./plan-view.js";
import { resources, settingsSidebar } from "./resource-view.js";
import { highlightJSON } from "./code-format.js";
import { snapshotInterfaceForPlan } from "./plan-snapshots.js";
import { exportDocumentation } from "./document-export.js";
import { icon as lineIcon } from "./icons.js";
const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const uid = () => crypto.randomUUID();
const responses = new Map();
const caseResults = new Map();
const temporaryParameters = new Map();
const collapsedFolders = new Set();
const loadOptions = new Map();
let opened = [],
  token = "",
  projects = [],
  project = null,
  current = null,
  page = "apis",
  mode = "debug",
  param = "body",
  responseTab = "body",
  response = null,
  dirty = false,
  saving = false,
  editVersion = 0,
  busy = false,
  runId = "",
  search = "",
  searchType = "all",
  selectedProtocolId = "",
  planId = "",
  planTab = "plans",
  lastRun = null,
  loadResult = null,
  activeSession = null,
  sessionTimer = null,
  mcpState = { enabled: false, activities: [] },
  helperOpen = false,
  bodyExpanded = false,
  responseLayout = "stacked",
  compactUI = false,
  settingsSection = "settings-basic";
const methodOptions = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];
const env = () => {
  const selected = $("#env")?.value || project?.currentEnvironmentId;
  return project?.environments.some((e) => e.id === selected)
    ? selected
    : project?.environments[0]?.id;
};
async function api(path, method = "GET", data) {
  const r = await fetch("/api" + path, {
    method,
    headers: { "content-type": "application/json", "x-local-token": token },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.error || r.statusText);
  return b;
}
function toast(s) {
  $("#toast").textContent = s;
  $("#toast").style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").style.display = "none"), 3500);
}
function request() {
  return project?.requests.find((r) => r.id === current);
}
function defaultRequest(name = "新建接口") {
  return {
    id: uid(),
    name,
    folder: "",
    method: "GET",
    url: "{{baseUrl}}",
    query: [],
    path: [],
    headers: [],
    cookies: [],
    auth: { type: "none" },
    bodyType: "none",
    body: "",
    form: [],
    assertions: [],
    extract: [],
    before: [],
    after: [],
    examples: [],
    schema: {},
    description: "",
    timeout: 15000,
  };
}
function mark() {
  editVersion++;
  dirty = true;
  $("#save")?.classList.add("primary");
  $("#save-project")?.classList.add("primary");
  const s = $("#saved-state");
  if (s) s.textContent = "● 未保存";
}
async function save() {
  if (!project || saving) return;
  collect();
  const snapshot = structuredClone(project),
    version = editVersion;
  snapshot.history = [];
  snapshot.runs = [];
  saving = true;
  for (const button of document.querySelectorAll("#save,#save-project"))
    button.disabled = true;
  try {
    const saved = await api("/projects/" + snapshot.id, "PUT", snapshot);
    const metadata = projects.find((item) => item.id === saved.id);
    if (metadata)
      Object.assign(metadata, {
        name: saved.name,
        archived: !!saved.archived,
        updatedAt: saved.updatedAt,
      });
    if (project.id === snapshot.id) {
      if (editVersion === version) {
        project = saved;
        dirty = false;
      } else {
        project.revision = saved.revision;
        project.configRevision = saved.configRevision;
        project._diskFingerprint = saved._diskFingerprint;
        project.history = saved.history;
        project.runs = saved.runs;
      }
    }
    toast(dirty ? "已保存本次快照，后续修改仍未保存" : "已保存到本地");
  } finally {
    saving = false;
    render();
  }
}

function collect() {
  const r = request();
  if (!r || page !== "apis") return;
  for (const [selector, key] of [
    ["#request-name", "name"],
    ["#url", "url"],
    ["#method", "method"],
    ["#body-code", "body"],
    ["#description", "description"],
  ]) {
    if ($(selector)) r[key] = $(selector).value;
  }
  const bodySelection = $('input[name="body-type"]:checked');
  if (bodySelection)
    r.bodyType =
      bodySelection.value === "raw"
        ? $("#raw-format")?.value || "raw"
        : bodySelection.value;
  if ($("#request-service")) r.serviceId = $("#request-service").value;
  if ($("#response-definitions")) {
    try {
      r.responses = JSON.parse($("#response-definitions").value);
      if (!Array.isArray(r.responses)) throw Error("必须为数组");
    } catch {
      throw Error("响应定义必须是有效JSON数组");
    }
  }
  if ($("#schema")) {
    try {
      r.schema = JSON.parse($("#schema").value);
    } catch {
      throw Error("JSON Schema 格式无效，请修正后再保存或切换");
    }
  }
}
async function openProject(id) {
  if (busy || saving) throw Error("请先结束当前请求或保存，再切换项目");
  if (dirty && !confirm("当前修改尚未保存，确定切换项目？")) return;
  project = await api("/projects/" + id);
  current = project.requests.find((r) => !r.deletedAt)?.id;
  opened = current ? [current] : [];
  dirty = false;
  response = null;
  lastRun = null;
  loadResult = null;
  planId = "";
  selectedProtocolId = "";
  sessionStorage.setItem("project", id);
  render();
}
function modal(title, html, onSave, label = "确定") {
  const d = $("#dialog");
  $("#dialog-title").textContent = title;
  $("#dialog-content").innerHTML = html;
  for (const button of $("#dialog-content").querySelectorAll("button"))
    button.type = "button";
  $("#dialog-save").textContent = label;
  $("#dialog-save").onclick = async () => {
    try {
      await onSave();
      d.close();
    } catch (e) {
      toast(e.message);
    }
  };
  d.showModal();
  if ($("#pick-directory"))
    $("#pick-directory").onclick = async () => {
      if (!window.desktop?.chooseDirectory) {
        toast("浏览器模式请直接填写绝对路径；桌面版支持选择文件夹");
        return;
      }
      const directory = await window.desktop.chooseDirectory();
      if (directory) $("#new-directory").value = directory;
    };
  $("#dialog-content input")?.focus();
}
const jsonEditor = (value, id = "modal-json") =>
  `<textarea id="${id}" spellcheck="false">${esc(JSON.stringify(value, null, 2))}</textarea>`;
function nav() {
  return [
    ["history", "◷", "最近"],
    ["apis", "▤", "APIs"],
    ["docs", "▧", "文档"],
    ["dictionary", "♧", "字典"],
    ["settings", "⚙", "配置"],
    ["git", "⑂", "Git"],
  ]
    .map(
      ([key, icon, title]) =>
        `<button data-page="${key}" class="${page === key ? "active" : ""}" title="${title}"><span class="icon">${lineIcon(icon)}</span>${title}</button>`,
    )
    .join("");
}
function tree() {
  const items = [
    ...(project?.requests || [])
      .filter((item) => !item.deletedAt)
      .map((item) => ({
        ...item,
        kind: "http",
        label: item.method === "DELETE" ? "DEL" : item.method,
        attribute: 'data-request="' + esc(item.id) + '"',
      })),
    ...(project?.documents || []).map((item, index) => ({
      ...item,
      name: item.title,
      url: "",
      kind: "document",
      label: "MD",
      attribute: 'data-document-index="' + index + '"',
    })),
    ...(project?.protocols || []).map((item) => ({
      ...item,
      kind: item.type,
      label: item.type === "websocket" ? "WS" : item.type.toUpperCase(),
      attribute: 'data-protocol-id="' + esc(item.id) + '"',
    })),
  ].filter(
    (item) =>
      (searchType === "all" || item.kind === searchType) &&
      (item.name + " " + (item.url || "") + " " + (item.folder || ""))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const folders = [
    ...new Set([
      ...(project?.folders || []),
      ...items.map((item) => item.folder || "未分组"),
    ]),
  ];
  return (
    folders
      .map(
        (folder) =>
          `<details class="tree-folder" data-tree-folder="${esc(folder)}" ${search || !collapsedFolders.has(project.id + ":" + folder) ? "open" : ""}><summary class="folder"><span>${esc(folder)}</span> <span>(${items.filter((item) => (item.folder || "未分组") === folder).length})</span><button class="ghost folder-edit" data-edit-folder="${esc(folder)}" aria-label="编辑目录 ${esc(folder)}">设置</button></summary>${items
            .filter((item) => (item.folder || "未分组") === folder)
            .map(
              (item) =>
                `<button class="tree-item ${(item.kind === "http" && item.id === current && page === "apis") || (item.kind !== "http" && item.id === selectedProtocolId && page === "protocols") ? "active" : ""}" ${item.attribute}><span class="method ${esc(item.method || item.label)}">${esc(item.label)}</span><span>${esc(item.name)}</span></button>`,
            )
            .join("")}</details>`,
      )
      .join("") || '<div class="notice">没有匹配的项目内容。</div>'
  );
}

function render() {
  const r = request();
  document.body.classList.toggle("compact-ui", compactUI);
  $("#app").innerHTML =
    `<header class="top"><div class="top-group"><div class="brand"><span class="logo">↗</span>Local API <span class="subtle">单机版</span></div><button id="new-project" ${busy || saving ? "disabled" : ""} class="ghost">＋ 新建/导入项目</button></div><div class="top-group project-group"><select id="project-select" ${busy || saving ? "disabled" : ""} aria-label="项目">${projects
      .filter((p) => !p.archived && !p.error)
      .map(
        (p) =>
          `<option value="${p.id}" ${p.id === project?.id ? "selected" : ""}>${esc(p.name)}</option>`,
      )
      .join(
        "",
      )}</select><button id="save-project" ${saving ? "disabled" : ""} class="${dirty ? "primary" : "ghost"}">保存项目</button><button id="open-location" class="ghost">打开位置</button></div><div class="top-group top-actions"><button data-page="plans" class="ghost ${page === "plans" ? "active" : ""}">执行计划</button><button id="mcp-status" data-page="settings" data-settings-target="settings-mcp" class="offline">MCP · ${mcpState.enabled ? "已开启" : "未开启"}</button><button id="theme" class="ghost" aria-label="切换主题">◐</button></div></header><div class="shell"><nav class="rail">${nav()}<button data-page="trash" class="bottom ${page === "trash" ? "active" : ""}"><span class="icon">${lineIcon("♲")}</span>回收站</button></nav><aside class="sidebar">${
      page === "settings"
        ? settingsSidebar(settingsSection)
        : `<div class="search"><div class="search-filter"><input id="search" placeholder="⌕ 关键字 / URL" aria-label="搜索接口" value="${esc(search)}"><select id="tree-type" aria-label="内容类型">${[
            ["all", "全部"],
            ["http", "HTTP"],
            ["sse", "SSE"],
            ["websocket", "WebSocket"],
            ["tcp", "TCP"],
            ["document", "文档"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${value === searchType ? "selected" : ""}>${label}</option>`,
            )
            .join(
              "",
            )}</select></div><button id="add-request" class="primary" aria-label="新建接口">＋</button></div><div class="section-label"><span>全部接口</span><div><button id="locate-request" class="ghost" title="定位当前接口" aria-label="定位当前接口">定位</button><button id="import" class="ghost" title="导入" aria-label="导入项目">导入</button><button id="export" class="ghost" title="导出项目" aria-label="导出项目">导出</button></div></div><div id="tree">${tree()}</div><details class="tree-create"><summary class="new-item">＋ 新建</summary><div><button id="new-request">HTTP 接口</button><button data-page="protocols">SSE / WebSocket / TCP</button><button id="new-folder">新建目录</button></div></details>`
    }</aside><main class="workspace">${
      page === "apis"
        ? `<div class="tabs">${opened
            .filter((id) =>
              project.requests.some((r) => r.id === id && !r.deletedAt),
            )
            .map((id) => {
              const item = project.requests.find((r) => r.id === id);
              return `<div class="tab ${current === id ? "selected" : ""}"><button class="ghost tab-switch" data-open-tab="${id}"><span class="method ${item.method}">${item.method}</span> <span data-tab-name="${id}">${esc(item.name)}</span></button><button class="ghost tab-close" data-close-tab="${id}" aria-label="关闭 ${esc(item.name)}">×</button></div>`;
            })
            .join(
              "",
            )}<button id="tab-add" class="ghost">＋</button><div class="tools"><select id="env" aria-label="执行环境">${project?.environments.map((e) => `<option value="${e.id}" ${e.id === env() ? "selected" : ""}>${esc(e.name)}</option>`).join("") || ""}</select><button data-page="settings" data-settings-target="settings-environments" class="ghost" title="环境设置">☷</button></div></div>${r ? editor(r) : '<div class="empty"><span class="empty-symbol">↗</span><p>从一个请求开始</p><small>创建或导入接口，所有数据只留在本机。</small><button id="welcome-add" class="primary">＋ 新建接口</button></div>'}`
        : renderPage()
    }</main></div><footer class="statusbar"><span>◈ 本地工作空间 &nbsp; / &nbsp; ${esc(project?.name || "")} &nbsp; <span id="saved-state">${dirty ? "● 未保存" : "✓ 已保存"}</span></span><span class="status-actions"><button id="compact-ui" aria-pressed="${compactUI}" title="隐藏项目树，保留导航和工作区">${compactUI ? "完整模式" : "精简模式"}</button><button id="response-layout" ${page !== "apis" || mode !== "debug" ? "disabled" : ""} aria-pressed="${responseLayout === "split"}">${responseLayout === "split" ? "上下布局" : "左右布局"}</button><span>Local API 0.1.0</span></span></footer>`;
  bind();
}
function editor(r) {
  return `<section class="editor ${mode === "debug" && responseLayout === "split" ? "split-layout" : ""}"><div class="subnav">${[
    ["design", "设计"],
    ["debug", "调试"],
    ["cases", "接口用例"],
    ["load", "一键压测"],
    ["mock", "Mock"],
  ]
    .map(
      ([key, label]) =>
        `<button data-mode="${key}" class="${mode === key ? "active" : ""}">${label}</button>`,
    )
    .join(
      "",
    )}<select id="request-status" aria-label="接口状态"><option value="">未设置状态</option>${(project.settings?.statuses || []).map((status) => `<option value="${esc(status.id)}" ${r.statusId === status.id ? "selected" : ""}>${esc(status.name)}</option>`).join("")}</select><input id="request-name" class="request-name" aria-label="接口名称" value="${esc(r.name)}"><button id="share-api">分享</button><button id="duplicate" title="复制接口">⧉</button><button id="delete" title="删除接口" class="danger">×</button></div><div class="urlbar"><div class="url-input"><select id="method" aria-label="请求方法">${methodOptions.map((m) => `<option ${r.method === m ? "selected" : ""}>${m}</option>`).join("")}</select><input id="url" aria-label="请求 URL" placeholder="输入请求地址，支持 {{变量}}" value="${esc(r.url)}"><select id="http-version" aria-label="HTTP协议版本"><option value="1.1" ${r.httpVersion !== "2" ? "selected" : ""}>http/1.1</option><option value="2" ${r.httpVersion === "2" ? "selected" : ""}>http/2</option></select></div><button id="send" class="primary" ${busy ? "disabled" : ""}>${busy ? "请求中…" : "发 送"}</button><details class="button-menu"><summary aria-label="发送更多操作">▾</summary><div><button id="send-menu-curl">生成 cURL</button><button id="send-menu-plan">创建执行计划</button></div></details>${busy ? '<button id="cancel">取消</button>' : ""}<button id="save" class="${dirty ? "primary" : ""}">保存</button><details class="button-menu"><summary aria-label="保存更多操作">▾</summary><div><button id="save-menu-copy">创建接口副本</button><button id="save-menu-project">保存整个项目</button></div></details><button id="curl" title="生成 cURL">⌘</button></div>${
    mode === "debug"
      ? `<div class="param-tabs">${[
          ["headers", "Header"],
          ["query", "Query"],
          ["path", "Path"],
          ["body", "Body"],
          ["auth", "认证"],
          ["cookies", "Cookie"],
          ["examples", "响应示例"],
          ["before", "前执行操作"],
          ["after", "后执行操作"],
          ["assertions", "断言"],
          ["extract", "提取变量"],
        ]
          .map(
            ([key, label]) =>
              `<button data-param="${key}" class="${param === key ? "active" : ""}">${label}${key === "body" ? (r.bodyType !== "none" ? " (1)" : "") : Array.isArray(r[key]) && r[key].length ? " (" + r[key].length + ")" : ""}</button>`,
          )
          .join(
            "",
          )}</div><div class="request-panel ${bodyExpanded && param === "body" ? "body-expanded" : ""} ${param === "body" && !["none", "form-data", "urlencoded"].includes(r.bodyType) ? "body-panel" : ""}">${paramPanel(r)}</div><div class="response"><div class="response-top"><div class="response-tabs">${[
          ["body", "实时响应"],
          ["headers", "响应头"],
          ["cookies", "Cookie"],
          ["examples", "响应示例"],
          ["request", "实际请求"],
          ["assertions", "断言结果"],
          ["extracted", "提取变量"],
          ["logs", "控制台"],
          ...(response?.subrequests?.length
            ? [["subrequests", "脚本子请求"]]
            : []),
        ]
          .map(
            ([key, label]) =>
              `<button data-response="${key}" class="${responseTab === key ? "active" : ""}">${label}</button>`,
          )
          .join(
            "",
          )}</div><div class="metrics">${response ? `<span class="${response.status < 400 ? "success" : "failed"}">${response.status || "ERROR"} ${esc(project.settings?.statusCodes?.find((item) => item.httpHint === true && String(item.code) === String(response.status))?.label || "")}</span><span>${response.duration ?? 0} ms</span><span>${response.size ?? 0} B</span>` : ""}</div></div><div class="response-body">${responseContent()}</div></div>`
      : modePanel(r)
  }</section>`;
}
function pairs(rows, key) {
  return `<table><thead><tr><th width="30"></th><th>参数名</th><th>参数值</th><th width="35"></th></tr></thead><tbody>${rows.map((p, i) => `<tr><td><input type="checkbox" data-pair-enabled="${key}:${i}" ${p.enabled !== false ? "checked" : ""} aria-label="启用参数"></td><td><input data-pair="${key}:${i}:key" placeholder="参数名" value="${esc(p.key)}"></td><td>${key === "form" ? `<select data-field-type="${i}"><option value="text" ${p.type !== "file" ? "selected" : ""}>文本</option><option value="file" ${p.type === "file" ? "selected" : ""}>文件</option></select>` : ""}${p.type === "file" ? `<input type="file" data-field-file="${i}"><small>${esc(p.filename || "未选择文件")}</small>` : `<input data-pair="${key}:${i}:value" placeholder="参数值 / {{变量}}" value="${esc(p.value)}">`}</td><td><button data-dynamic-pair="${key}:${i}">${p.dynamic ? "动态✓" : "动态"}</button><button data-dictionary-pair="${key}:${i}">字典</button><button data-define-pair="${key}:${i}" title="参数类型、必填与说明">定义</button><button data-remove-pair="${key}:${i}" aria-label="删除参数">×</button></td></tr>`).join("")}</tbody></table><div class="pair-actions"><button data-add-pair="${key}">＋ 添加参数</button></div>`;
}
function paramPanel(r) {
  if (["headers", "query", "path", "cookies"].includes(param))
    return (
      (param === "cookies"
        ? '<button id="cookie-manager">Cookie管理器</button><span class="muted">按项目与环境隔离，默认关闭</span>'
        : "") + pairs(r[param], param)
    );
  if (param === "body")
    return `<div class="body-types">${["none", "form-data", "urlencoded", "binary", "msgpack", "raw"].map((type) => `<label><input type="radio" name="body-type" value="${type}" ${(r.bodyType === "json" ? "raw" : r.bodyType) === type ? "checked" : ""}>${type}</label>`).join("")}${["json", "raw"].includes(r.bodyType) ? `<select id="raw-format" aria-label="Raw格式"><option value="json" ${r.bodyType === "json" ? "selected" : ""}>JSON</option><option value="raw" ${r.bodyType === "raw" ? "selected" : ""}>Text</option></select>` : ""}</div><div class="body-actions"><button id="generate-body" class="ghost">基于数据结构生成</button><span class="grow">${r.bodyType === "binary" ? "输入 Base64 编码的二进制数据" : "请求体 · 保存在本地"}</span><button id="format-json" class="ghost">格式化 JSON</button><button id="expand-body" class="ghost" ${["none", "form-data", "urlencoded"].includes(r.bodyType) ? "disabled" : ""} aria-pressed="${bodyExpanded}" title="展开编辑器，Esc 收起">${bodyExpanded ? "收起编辑器" : "展开编辑器"}</button></div>${
      ["form-data", "urlencoded"].includes(r.bodyType)
        ? pairs(r.form, "form")
        : r.bodyType === "none"
          ? '<div class="empty"><p>此请求没有 Body</p></div>'
          : `<div class="body-editor-shell"><div class="code-editor"><pre id="code-gutter" aria-hidden="true">${r.body
              .split("\n")
              .map((_, i) => i + 1)
              .join(
                "\n",
              )}</pre><pre id="code-highlight" aria-hidden="true">${highlightJSON(r.body)}\n</pre><textarea id="body-code" class="code" wrap="off" spellcheck="false" aria-label="请求体">${esc(r.body)}</textarea></div><button id="toggle-parameter-helper" class="helper-toggle" aria-label="参数助手" aria-expanded="${helperOpen}"><span class="helper-label" aria-hidden="true"><span>参</span><span>数</span><span>助</span><span>手</span></span></button>${
              helperOpen
                ? `<aside class="parameter-helper"><h4>动态值</h4><button id="new-body-dynamic">插入动态值</button>${Object.keys(
                    r.bodyDynamic || {},
                  )
                    .map(
                      (id) =>
                        `<button data-edit-body-dynamic="${esc(id)}">编辑 ${esc(id.slice(0, 8))}</button>`,
                    )
                    .join("")}<h4>插入环境变量</h4>${
                    Object.keys({
                      ...project.globalVariables,
                      ...project.environments.find((item) => item.id === env())
                        ?.variables,
                    })
                      .map(
                        (key) =>
                          `<button data-insert-variable="${esc(key)}">{{${esc(key)}}}</button>`,
                      )
                      .join("") || "<p>暂无变量</p>"
                  }<h4>内置动态变量</h4><select id="builtin-variable" aria-label="内置动态变量">${builtinVariableNames.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}</select><button id="insert-builtin-variable">插入占位符</button><small>每次发送生成；JSON字符串值须加引号。</small><h4>参数字典 · 插入 JSON 字段</h4>${
                    effectiveParameterDictionary(project)
                      .map(
                        (entry) =>
                          `<button data-insert-dictionary="${esc(entry.id)}" title="${esc(entry.description)}">${esc(entry.key)} · ${esc(entry.type)}</button>`,
                      )
                      .join("") || "<p>暂无字典参数</p>"
                  }<h4>共享函数</h4><p class="muted">供前后置脚本调用</p>${(project.settings?.functions || []).map((fn) => `<code>utils.${esc(fn.name)}(...)</code>`).join("<br>")}<h4>请求结构</h4><pre>${esc(JSON.stringify(r.schema, null, 2))}</pre></aside>`
                : ""
            }</div>`
    }`;
  if (param === "auth") return authPanel(r.auth);
  if (param === "assertions")
    return `<table><thead><tr><th>目标</th><th>操作</th><th>预期值（JSON 或文本）</th><th></th></tr></thead><tbody>${r.assertions.map((a, i) => `<tr><td><input data-rule="${i}:target" value="${esc(a.target)}" placeholder="status / $.data.id / duration"></td><td><select data-rule="${i}:op">${["eq", "neq", "contains", "exists", "lt", "gt"].map((op) => `<option ${a.op === op ? "selected" : ""}>${op}</option>`).join("")}</select></td><td><input data-rule="${i}:value" value="${esc(JSON.stringify(a.value))}"></td><td><button data-remove-rule="${i}">×</button></td></tr>`).join("")}</tbody></table><p><button id="add-assertion">＋ 添加断言</button> <button id="edit-operations">JSON 高级编辑</button></p><div class="notice">status 为状态码，duration 为毫秒，body 为原文；JSON 路径如 $.data.id；响应头使用 header:content-type。</div>`;
  if (param === "extract")
    return `<table><thead><tr><th>变量名</th><th>保存至</th><th>来源</th><th>路径 / 头名 / Cookie / 正则</th><th>捕获组</th><th></th></tr></thead><tbody>${r.extract
      .map(
        (a, i) =>
          `<tr><td><input data-extract="${i}:name" value="${esc(a.name)}"></td><td><select data-extract="${i}:scope">${[
            ["runtime", "运行时"],
            ["local", "本请求"],
            ["environment", "环境（保存）"],
            ["global", "全局（保存）"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${(a.scope || "runtime") === value ? "selected" : ""}>${label}</option>`,
            )
            .join("")}</select></td><td><select data-extract="${i}:source">${[
            ["json", "Response JSON"],
            ["header", "Response Header"],
            ["cookie", "Response Cookie"],
            ["duration", "响应时间 (ms)"],
            ["text", "完整响应文本"],
            ["regex", "文本正则"],
            ["xml", "XML / XPath"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${(a.source || "json") === value ? "selected" : ""}>${label}</option>`,
            )
            .join(
              "",
            )}</select></td><td><input data-extract="${i}:path" value="${esc(a.path)}" placeholder="$.data.token 或 /token=(.+)/"></td><td><input type="number" min="0" max="99" data-extract="${i}:group" value="${esc(a.group ?? 0)}" aria-label="正则捕获组"></td><td><button data-remove-extract="${i}">×</button></td></tr>`,
      )
      .join(
        "",
      )}</tbody></table><p><button id="add-extract">＋ 提取变量</button><button id="edit-operations">JSON 高级编辑</button></p><div class="notice">默认运行时变量可传递给后续步骤；本请求变量不跨请求。环境/全局目的层会保存到项目，同名并发变更报错。响应时间与完整文本不需要路径；正则在隔离 VM 执行，文本上限 256 KiB，捕获组 0 为完整匹配；XML/XPath 上限 1 MiB，禁止 DTD；索引从 1 开始，多节点取首个，可使用 /root/item[1]/text()。命名空间映射可在高级 JSON 中设置 namespaces。</div>`;
  if (param === "before" || param === "after")
    return `<div class="notice">JavaScript 在独立 QuickJS 沙箱中执行，无文件/Node或任意模块访问。支持有界pm.sendRequest(config, callback) HTTP子请求（最多10次/并发4次、总计仍限2秒；非Promise API），以及 apt.setVar/getVar、set/removeRequestQuery/Header/Body、pm.environment/pm.globals（持久化）、pm.variables（仅当前请求）、pm.response、pm.test/Chai断言、CryptoJS（含受限安全随机数）和 console.log；累计250ms脚本运行预算（墙钟时间，不含HTTP等待）、2秒worker总截止、16MiB VM 内存限制。</div><textarea id="script-code" class="full-code" spellcheck="false" placeholder="${param === "before" ? "apt.setVar('requestId', 'demo');" : "pm.test('status', () => pm.expect(pm.response.code).to.equal(200));"}">${esc(r[param + "Script"] || "")}</textarea><p><button id="edit-operations">声明式操作（高级）</button></p><pre>${esc(JSON.stringify(r[param], null, 2))}</pre>`;
  const descriptions = {
    assertions:
      "状态码 / JSON 路径 / 响应时间断言。支持 eq、neq、contains、exists、lt、gt。",
    extract: "从响应 JSON 提取变量，用于执行计划后续步骤。",
    before: "声明式操作：set、uuid、timestamp、delete。不会执行任意系统代码。",
    after: "响应后的声明式变量操作，执行记录可追溯。",
  };
  return `<div class="notice">${descriptions[param]}</div><pre>${esc(JSON.stringify(r[param], null, 2))}</pre><button id="edit-operations">编辑${param === "assertions" ? "断言" : param === "extract" ? "提取规则" : "操作"}</button>`;
}
function responseContent() {
  if (responseTab === "examples")
    return (
      request()
        .examples.map(
          (example) =>
            `<h4>${esc(example.name)} · ${example.status}</h4><pre>${esc(example.body)}</pre>`,
        )
        .join("") || '<div class="empty"><p>在 Mock 页添加响应示例</p></div>'
    );
  if (!response)
    return `<div class="empty"><div class="empty-symbol">${lineIcon("rocket")}</div><p>输入 URL 后点击发送获取响应结果</p><small>Ctrl + Enter 发送请求 · Ctrl + S 保存接口</small></div>`;
  let v =
    responseTab === "body"
      ? response.body
      : responseTab === "cookies"
        ? response.headers?.["set-cookie"] || []
        : response[responseTab];
  const failure = response.error
    ? `<div class="notice failed">${esc(response.error)}</div>`
    : "";
  if (responseTab === "body") {
    try {
      v = JSON.stringify(JSON.parse(v), null, 2);
    } catch {}
  }
  return `${failure}${response.rawBodyBase64 ? '<button id="download-response-binary">下载原始二进制响应</button>' : ""}${response.codecError ? `<div class="notice">解码失败，以下为 Base64：${esc(response.codecError)}</div>` : ""}<pre>${esc(typeof v === "string" ? v : JSON.stringify(v, null, 2))}</pre>`;
}
function modePanel(r) {
  if (mode === "design")
    return `<div class="page">${r.importNotes?.length ? `<div class="notice import-notes">导入提示：${r.importNotes.map(esc).join("<br>")}</div>` : ""}<div class="form-grid"><label>接口描述</label><textarea id="description">${esc(r.description)}</textarea><label>所属目录</label><input id="folder" value="${esc(r.folder)}"><label>超时（ms）</label><input id="timeout" type="number" min="100" max="60000" value="${r.timeout}"><label>HTTP/HTTPS 代理</label><input id="request-proxy" value="${esc(r.proxy)}" placeholder="http://127.0.0.1:8080"><label>自定义 CA（PEM）</label><textarea data-tls="ca">${esc(r.tls?.ca || "")}</textarea><label>HTTPS代理 CA（PEM，与目标站点CA分开）</label><textarea data-tls="proxyCa">${esc(r.tls?.proxyCa || "")}</textarea><label>客户端证书（PEM）</label><textarea data-tls="cert">${esc(r.tls?.cert || "")}</textarea><label>客户端私钥（PEM）</label><textarea data-tls="key">${esc(r.tls?.key || "")}</textarea><label>私钥口令</label><input data-tls="passphrase" type="password" value="${esc(r.tls?.passphrase || "")}"><label>绑定服务</label><select id="request-service"><option value="">完整 URL 直连 / 相对路径继承目录</option>${(project.servers || []).map((server) => `<option value="${server.id}" ${r.serviceId === server.id ? "selected" : ""}>${esc(server.name)}</option>`).join("")}</select>${attributeFields(project.settings?.attributes || [], r.attributes)}<label>请求 JSON Schema</label><div><button id="visual-schema" type="button">可视化编辑结构</button><textarea id="schema">${esc(JSON.stringify(r.schema, null, 2))}</textarea></div><label>响应定义（状态、描述、Content 与 Schema）</label><div><div class="response-schema-actions"><button id="new-response-schema" type="button">新增响应结构</button>${(r.responses || []).flatMap((definition, index) => (Object.keys(definition.content || {}).length ? Object.keys(definition.content) : ["application/json"]).map((media) => `<button type="button" data-response-schema="${esc(JSON.stringify([index, media]))}">编辑 ${esc(definition.status)} · ${esc(media)}</button>`)).join("")}</div><textarea id="response-definitions">${esc(JSON.stringify(r.responses || [], null, 2))}</textarea></div></div><div class="notice">TLS 校验始终开启，可粘贴自定义 CA。保存接口会将证书/私钥写入本地项目；导出前务必删除敏感凭据。执行计划保存独立快照。</div></div>`;
  if (mode === "mock")
    return `<div class="page"><h2>本地 Mock 与响应示例</h2><button id="edit-mock-rules">编辑条件响应期望规则</button><button data-page="settings" data-settings-target="settings-mock-fields">配置智能字段 Mock</button><p class="muted">规则按顺序匹配；一条规则内条件全部满足才生效；不匹配时返回响应示例；没有示例时，按 2xx JSON 响应 Schema 和项目字段规则生成。</p><p class="muted">Mock 地址只在本机应用运行时可用。</p><input class="mock-url" readonly value="${location.origin}/mock/${project.id}/${r.id}"><div class="toolbar"><button id="add-example">＋ 新增示例</button><button id="use-mock">用 Mock 地址调试</button></div>${r.examples.map((e, i) => `<div class="card"><div class="row"><strong class="grow">${esc(e.name)} · ${e.status}</strong><button data-edit-example="${i}">编辑</button></div><pre>${esc(e.body)}</pre></div>`).join("")}</div>`;
  if (mode === "cases")
    return `<div class="page"><h2>接口用例</h2><p class="muted">每个用例保存独立请求快照，可覆盖参数、断言和脚本。原接口修改不会自动覆盖用例。</p><button id="new-interface-case" class="primary">＋ 新建接口用例</button><button id="create-case">从当前接口创建执行计划</button>${
      (project.cases || [])
        .filter((item) => item.sourceRequestId === r.id)
        .map(
          (item) =>
            `<div class="card"><div class="row"><strong class="grow">${esc(item.name)}</strong><button data-run-case="${item.id}" ${busy ? "disabled" : ""}>运行用例</button><button data-edit-case="${item.id}">编辑快照</button><button data-delete-case="${item.id}" class="danger">删除</button></div><p class="subtle">${esc(item.request.method)} ${esc(item.request.url)}</p>${caseResults.has(item.id) ? `<pre>${esc(JSON.stringify(caseResults.get(item.id), null, 2))}</pre>` : ""}</div>`,
        )
        .join("") ||
      '<div class="notice">尚无用例。可分别验证成功、参数缺失和认证失败等场景。</div>'
    }</div>`;
  return `<div class="page"><h2>一键压测</h2><p class="muted">仅对你有权测试的接口使用。最多100次主请求执行、并发10，支持取消。包含脚本、动态值和断言；每次执行的变量独立，不回写项目。脚本子请求另计（各自受沙箱上限约束），HTTP调用数不等于网络往返次数。P50/P95是主请求耗时，逐次elapsed另含脚本等待；脚本与子请求也可能产生副作用。</p><div class="row"><label>请求数 <input id="load-count" type="number" value="${esc(loadOptions.get(project.id + ":" + r.id)?.count ?? 10)}" min="1" max="100"></label><label>并发 <input id="load-concurrency" type="number" value="${esc(loadOptions.get(project.id + ":" + r.id)?.concurrency ?? 1)}" min="1" max="10"></label><button id="load-run" class="primary" ${busy ? "disabled" : ""}>开始压测</button>${busy ? '<button id="cancel">停止</button>' : ""}</div>${
    loadResult
      ? `<div class="grid-stats">${[
          ["完成", loadResult.count],
          ["通过", loadResult.passed],
          ["失败", loadResult.count - loadResult.passed],
          ["总耗时", loadResult.elapsed + " ms"],
          ["主请求调用", loadResult.mainRequests ?? loadResult.count],
          ["脚本子请求", loadResult.scriptRequests ?? 0],
          [
            "P50",
            loadResult.timingSamples === 0 ? "—" : loadResult.p50 + " ms",
          ],
          [
            "P95",
            loadResult.timingSamples === 0 ? "—" : loadResult.p95 + " ms",
          ],
        ]
          .map(([l, v]) => `<div class="stat">${l}<strong>${v}</strong></div>`)
          .join(
            "",
          )}</div><pre>${esc(JSON.stringify(loadResult.results, null, 2))}</pre>`
      : ""
  }</div>`;
}
function renderPage() {
  if (!project) return "";
  if (page === "settings") return settingsPanel(project, settingsSection);
  if (page === "plans")
    return renderPlans({ project, planId, lastRun, busy, tab: planTab });
  if (page === "history")
    return `<div class="page"><div class="page-head"><h1>最近请求</h1><span class="muted">本地保留最近 50 条</span></div>${project.history.map((h) => `<div class="card"><div class="row"><span class="method ${h.request?.method}">${h.request?.method}</span><strong class="grow">${esc(h.name)}</strong><span class="${h.response?.status < 400 ? "success" : "failed"}">${h.response?.status || "ERROR"}</span><button data-history="${h.id}">查看</button></div><p class="subtle">${esc(h.createdAt)} · ${esc(h.request?.url)}</p></div>`).join("") || '<div class="empty"><p>暂无请求历史</p></div>'}</div>`;
  if (page === "trash")
    return `<div class="page"><h1>回收站</h1>${projects
      .filter((p) => p.archived)
      .map(
        (p) =>
          `<div class="list-row"><strong class="grow">归档项目 · ${esc(p.name)}</strong><button data-restore-project="${p.id}">恢复项目</button></div>`,
      )
      .join("")}<p class="muted">删除的接口在这里保留，可随时恢复。</p>${
      project.requests
        .filter((r) => r.deletedAt)
        .map(
          (r) =>
            `<div class="list-row"><span class="method">${r.method}</span><strong class="grow">${esc(r.name)}</strong><span class="subtle">${esc(r.deletedAt)}</span><button data-restore="${r.id}">恢复</button></div>`,
        )
        .join("") || '<div class="empty"><p>回收站为空</p></div>'
    }</div>`;
  if (page === "dictionary")
    return `<div class="page">${dictionaryPanel(project, temporaryParameters.get(project.id) || [])}<div class="page-head"><div><h1>数据模型</h1><span class="muted">统一管理可复用的字段定义与枚举</span></div><button id="add-dictionary" class="primary">＋ 新建数据模型</button></div>${project.dictionary.map((d, i) => `<div class="card"><div class="row"><strong class="grow">${esc(d.name)}</strong><button data-edit-dictionary="${i}">编辑</button><button data-use-dictionary="${i}">应用到当前接口</button></div><pre>${esc(JSON.stringify(d.schema, null, 2))}</pre></div>`).join("") || '<div class="empty"><p>暂无数据模型</p></div>'}</div>`;
  if (page === "protocols")
    return `<div class="page"><h1>实时协议调试</h1><div class="row"><input id="protocol-name" placeholder="连接名称" value="${esc(project.protocols?.find((item) => item.id === selectedProtocolId)?.name || "")}"><button id="save-protocol">保存连接定义</button><button id="delete-protocol" class="danger">删除连接定义</button></div><p class="muted">支持短时采集与交互会话。交互会话最长 15 分钟、8 MiB，保留最近 200 条消息。</p><div class="form-grid"><label>协议</label><select id="protocol-type">${[
      ["sse", "SSE"],
      ["websocket", "WebSocket"],
      ["tcp", "TCP"],
    ]
      .map(
        ([type, label]) =>
          `<option value="${type}" ${(project.protocols?.find((item) => item.id === selectedProtocolId)?.type || "sse") === type ? "selected" : ""}>${label}</option>`,
      )
      .join(
        "",
      )}</select><label>URL / TCP Host</label><input id="protocol-url" placeholder="http://localhost:8080/events" value="${esc(project.protocols?.find((item) => item.id === selectedProtocolId)?.url || "")}"><label>TCP 端口</label><input id="protocol-port" type="number" value="${project.protocols?.find((item) => item.id === selectedProtocolId)?.port || 8080}"><label>采集时长 ms</label><input id="protocol-duration" type="number" value="3000" min="100" max="30000"><label>发送消息</label><textarea id="protocol-message"></textarea></div><p><button id="protocol-run" class="primary" ${busy ? "disabled" : ""}>连接并采集</button> <button id="cancel">断开</button></p><pre id="protocol-result"></pre><div class="card"><div class="toolbar"><button id="session-connect" class="primary">建立交互会话</button><button id="session-send">发送消息</button><button id="session-stop">断开会话</button><button id="session-export">导出消息</button><span id="session-status">${esc(activeSession?.state || "未连接")}</span></div><pre id="session-events">${esc(activeSession?.events?.map((event) => `${event.at} ${event.direction} ${event.data}`).join("\n") || "")}</pre></div></div>`;
  if (page === "database")
    return `<div class="page"><h1>数据库连接</h1><p class="muted">SQLite / PostgreSQL / MySQL · 只读事务 · 最多返回 1000 行</p><div class="form-grid"><label>类型</label><select id="db-type"><option value="sqlite">SQLite</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option></select><label>主机</label><input id="db-host" value="127.0.0.1"><label>端口</label><input id="db-port" placeholder="5432 / 3306"><label>用户名</label><input id="db-user" autocomplete="off"><label>密码</label><input id="db-password" type="password" autocomplete="off"><label>数据库名</label><input id="db-name"><label>TLS</label><input id="db-tls" type="checkbox"><label>SQLite 文件路径</label><input id="db-path" placeholder="C:\\data\\app.db 或 /data/app.db"><label>SQL</label><textarea id="db-sql">SELECT name FROM sqlite_master WHERE type = 'table'</textarea><label>绑定参数 JSON</label><input id="db-params" value="[]"></div><p><button id="db-query" class="primary">执行只读查询</button></p><pre id="db-result"></pre><div class="notice">连接凭据仅本次使用，不自动保存。仅连接你有权访问的数据库；只读事务不能保证数据库自定义函数无外部副作用。</div></div>`;
  if (page === "git")
    return `<div class="page"><h1>Git 协同</h1><p><button id="git-terminal" class="primary">在项目位置打开终端</button></p><p class="muted">本地项目是格式化 JSON 文件，可以纳入你自己的 Git 仓库。</p><div class="card"><h3>推荐流程</h3><ol class="markdown"><li>导出项目，检查并移除环境密钥与历史中的敏感信息。</li><li>把接口定义文件放入项目仓库。</li><li>通过 Git diff 审查变更，通过 PR 协作。</li><li>其他成员导入同一文件，继续本地编辑。</li></ol><button id="export">导出项目文件</button></div><div class="notice">打开终端后由你执行 Git 命令；本应用不会自动提交凭据或推送代码。执行记录与历史可能含敏感数据，请勿公开提交。</div></div>`;
  return `<div class="page"><div class="page-head"><div><h1>接口文档</h1><span class="muted">从当前项目定义生成，离线阅读与导出</span></div><div class="toolbar"><button id="new-document">＋ 新建文档</button><button id="export-docs" class="primary">导出文档</button></div></div>${
    errorCodeHTML(project.settings?.statusCodes || []) +
      project.documents
        .map(
          (document, index) =>
            `<article class="card markdown"><div class="row"><h3 class="grow">${esc(document.title)}</h3><span class="subtle">${esc((project.settings?.statuses || []).find((status) => status.id === document.statusId)?.name || "")}</span><button data-edit-document="${index}">编辑</button><button data-delete-document="${index}" class="danger">删除</button></div><div class="markdown-content">${renderMarkdown(document.content)}</div></article>`,
        )
        .join("") +
      project.requests
        .filter((r) => !r.deletedAt)
        .map(
          (r) =>
            `<article class="card markdown"><div class="row"><span class="method ${r.method}">${r.method}</span><h3>${esc(r.name)}</h3></div><pre>${esc(r.url)}</pre><p>${esc(r.description || "暂无描述")}</p>${r.query.length ? `<h4>Query 参数</h4><table>${r.query.map((p) => `<tr><td>${esc(p.key)}</td><td>${esc(p.value)}</td></tr>`).join("")}</table>` : ""}${r.bodyType !== "none" ? `<h4>请求体 · ${esc(r.bodyType)}</h4><pre>${esc(r.body)}</pre>` : ""}${r.examples.map((e) => `<h4>${esc(e.name)} · ${e.status}</h4><pre>${esc(e.body)}</pre>`).join("")}</article>`,
        )
        .join("") || '<div class="empty"><p>创建接口后自动生成文档</p></div>'
  }</div>`;
}
function on(selector, event, fn) {
  document.querySelectorAll(selector).forEach((el) =>
    el.addEventListener(event, async (e) => {
      try {
        await fn(e, el);
      } catch (err) {
        toast(err.message);
      }
    }),
  );
}
function download(name, data, type = "application/json") {
  const u = URL.createObjectURL(
    new Blob(
      [typeof data === "string" ? data : JSON.stringify(data, null, 2)],
      { type },
    ),
  );
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
function addRequest() {
  collect();
  const r = defaultRequest();
  project.requests.push(r);
  current = r.id;
  if (!opened.includes(r.id)) opened.push(r.id);
  page = "apis";
  mode = "debug";
  response = null;
  mark();
  render();
}
async function savePlan(plan) {
  plan = structuredClone(plan);
  if (dirty) {
    await save();
    if (dirty) throw Error("保存期间出现新的修改，请检查后再次保存");
  }
  const projectId = project.id;
  const result = await api("/projects/" + projectId + "/plans", "POST", {
    ...plan,
    projectConfigRevision: project.configRevision ?? project.revision,
  });
  if (project.id !== projectId) return;
  const {
    projectRevision,
    projectConfigRevision,
    projectFingerprint,
    ...saved
  } = result;
  const index = project.plans.findIndex((item) => item.id === saved.id);
  if (index < 0) project.plans.push(saved);
  else project.plans[index] = saved;
  planId = saved.id;
  project.revision = projectRevision;
  project.configRevision = projectConfigRevision;
  project._diskFingerprint = projectFingerprint;
  render();
}

function editRules() {
  const r = request();
  const sample = {
    assertions: [{ target: "status", op: "eq", value: 200 }],
    extract: [
      { name: "token", source: "json", path: "$.token" },
      {
        name: "xmlName",
        source: "xml",
        path: "/x:root/x:name/text()",
        namespaces: { x: "urn:example" },
        scope: "runtime",
      },
    ],
    before: [{ type: "uuid", name: "requestId" }],
    after: [{ type: "set", name: "completed", value: "true" }],
  };
  modal(
    "编辑 " + param,
    `<p>示例</p><pre>${esc(JSON.stringify(sample[param], null, 2))}</pre>${jsonEditor(r[param])}`,
    () => {
      const value = JSON.parse($("#modal-json").value);
      if (!Array.isArray(value)) throw Error("必须是数组");
      r[param] = value;
      mark();
      render();
    },
  );
}
function showMCPClientConfiguration(configuration) {
  let selected = "Cursor";
  modal(
    "MCP 连接配置",
    `<div class="toolbar">${mcpClients.map((client) => `<button data-mcp-client="${esc(client)}">${esc(client)}</button>`).join("")}</div><pre id="mcp-client-code">${esc(clientConfiguration(selected, configuration))}</pre><p class="muted">配置只在本机显示/复制，不会自动联系任何 Agent。模板按客户端格式生成；仍需在客户端允许此连接。Trae 为通用 HTTP 模板，尚未逐客户端实机验证。</p>`,
    () =>
      navigator.clipboard.writeText(
        clientConfiguration(selected, configuration),
      ),
    "复制配置",
  );
  for (const button of document.querySelectorAll("[data-mcp-client]"))
    button.onclick = () => {
      selected = button.dataset.mcpClient;
      $("#mcp-client-code").textContent = clientConfiguration(
        selected,
        configuration,
      );
      for (const item of document.querySelectorAll("[data-mcp-client]"))
        item.classList.toggle("primary", item === button);
    };
}
function bind() {
  on("#cookie-manager", "click", openCookieManager);
  on("#compact-ui", "click", () => {
    collect();
    compactUI = !compactUI;
    localStorage.setItem("compact-ui", String(compactUI));
    render();
  });
  on("#response-layout", "click", () => {
    collect();
    responseLayout = responseLayout === "split" ? "stacked" : "split";
    localStorage.setItem("response-layout", responseLayout);
    render();
  });
  on("[data-page]", "click", (_, e) => {
    collect();
    bodyExpanded = false;
    page = e.dataset.page;
    if (e.dataset.settingsTarget) settingsSection = e.dataset.settingsTarget;
    if (page === "plans") planTab = "plans";
    render();
  });
  on("[data-open-tab]", "click", (_, e) => {
    collect();
    current = e.dataset.openTab;
    response = responses.get(project.id + ":" + current) || null;
    render();
  });
  on("[data-close-tab]", "click", (_, e) => {
    collect();
    opened = opened.filter((id) => id !== e.dataset.closeTab);
    if (current === e.dataset.closeTab) {
      current = opened.at(-1);
      response = responses.get(project.id + ":" + current) || null;
    }
    render();
  });
  on("#git-terminal", "click", async () => {
    if (window.desktop?.openProjectTerminal)
      return window.desktop.openProjectTerminal(project.id);
    const location = await api("/projects/" + project.id + "/location");
    modal(
      "项目位置",
      `<pre>${esc(location.path)}</pre><p>浏览器模式请在该文件所在目录自行打开终端。桌面版可直接打开。</p>`,
      () => navigator.clipboard.writeText(location.path),
      "复制路径",
    );
  });
  on("#open-location", "click", async () => {
    if (window.desktop?.openProjectLocation)
      return window.desktop.openProjectLocation(project.id);
    const location = await api("/projects/" + project.id + "/location");
    modal(
      "本地项目位置",
      `<pre>${esc(location.path)}</pre><p>浏览器模式请在文件管理器中打开此路径。</p>`,
      () => navigator.clipboard.writeText(location.path),
      "复制路径",
    );
  });
  on("#mcp-config", "click", async () => {
    const config = await api("/mcp/config");
    modal(
      "MCP 项目授权",
      `${config.warning ? `<p class="notice">${esc(config.warning)}</p>` : ""}<details><summary>stdio共享进度</summary><p>stdio客户端需将LOCAL_API_DATA环境变量设为此数据根目录，并单独授权project/write/execute。HTTP开关不代替stdio权限。</p><pre>${esc(config.dataRoot)}</pre></details><label><input id="mcp-enabled" type="checkbox" ${config.enabled ? "checked" : ""}> 开启本地 MCP 服务</label><label><input id="mcp-write" type="checkbox" ${config.write ? "checked" : ""}> 允许写入项目</label><label><input id="mcp-execute" type="checkbox" ${config.execute ? "checked" : ""}> 允许执行已有计划（会向计划 URL 发送请求）</label><label><input id="mcp-remember" type="checkbox" ${config.remember ? "checked" : ""}>下次启动保留本机授权、端口和连接密钥</label><label><input id="mcp-rotate" type="checkbox">重新生成连接密钥（使旧配置失效）</label><p class="notice">持久授权会将连接密钥写入本机应用数据目录；仅对可信客户端开启，不要分享配置。</p><h4>授权项目</h4>${projects.map((p) => `<label><input data-mcp-project="${p.id}" type="checkbox" ${config.projects.includes(p.id) ? "checked" : ""}> ${esc(p.name)}</label>`).join("")}<div class="notice">凭据只用于本机 MCP 接入。不要分享给不信任的 Agent。关闭服务会立即撤销当前令牌。</div>`,
      async () => {
        const result = await api("/mcp/config", "POST", {
          enabled: $("#mcp-enabled").checked,
          write: $("#mcp-write").checked,
          execute: $("#mcp-execute").checked,
          remember: $("#mcp-remember").checked,
          rotate: $("#mcp-rotate").checked,
          projects: [
            ...document.querySelectorAll("[data-mcp-project]:checked"),
          ].map((e) => e.dataset.mcpProject),
        });
        if (result.enabled) {
          setTimeout(() => showMCPClientConfiguration(result), 0);
        } else toast("MCP 已关闭，令牌已撤销");
      },
      "应用授权",
    );
  });
  on("#theme", "click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem(
      "theme",
      document.body.classList.contains("dark") ? "dark" : "light",
    );
  });
  on("#project-select", "change", (_, e) => openProject(e.value));
  on("#env", "change", (_, e) => {
    project.currentEnvironmentId = e.value;
    mark();
  });
  on("#search", "input", (_, e) => {
    search = e.value;
    $("#tree").innerHTML = tree();
    bindTree();
  });
  bindTree();
  on("#new-folder", "click", () =>
    modal("新建目录", '<label>目录名称</label><input id="folder-name">', () => {
      const name = $("#folder-name").value.trim();
      if (!name) throw Error("名称不能为空");
      project.folders = [...new Set([...(project.folders || []), name])];
      mark();
      render();
    }),
  );
  on("#new-document", "click", () => editDocument());
  on("[data-edit-document]", "click", (_, element) =>
    editDocument(Number(element.dataset.editDocument)),
  );
  on("[data-delete-document]", "click", (_, element) => {
    if (!confirm("删除此项目文档？")) return;
    project.documents.splice(Number(element.dataset.deleteDocument), 1);
    mark();
    render();
  });
  on("#new-project", "click", () =>
    modal(
      "新建本地项目",
      '<label>项目名称</label><input id="new-name" placeholder="例如：商城服务"><label>存储目录（留空使用默认目录）</label><input id="new-directory" placeholder="绝对路径"><button id="pick-directory" type="button">选择本地文件夹</button>',
      async () => {
        const p = await api("/projects", "POST", {
          name: $("#new-name").value,
          directory: $("#new-directory").value || undefined,
        });
        projects = await api("/projects");
        await openProject(p.id);
      },
    ),
  );
  on("#add-request,#new-request,#tab-add,#welcome-add", "click", addRequest);
  on("#save,#save-project", "click", save);
  on("#request-name,#url,#body-code,#description", "input", (_, element) => {
    collect();
    mark();
    if (element.id === "request-name") {
      const id = CSS.escape(current);
      document
        .querySelectorAll('[data-tab-name="' + id + '"]')
        .forEach((label) => {
          label.textContent = request().name;
        });
      document
        .querySelector('[data-close-tab="' + id + '"]')
        ?.setAttribute("aria-label", "关闭 " + request().name);
      if ($("#tree")) {
        $("#tree").innerHTML = tree();
        bindTree();
      }
    }
  });
  on("#method", "change", () => {
    collect();
    mark();
    render();
  });
  const editResponseSchema = (index = -1, media = "application/json") => {
    collect();
    const responses = structuredClone(request().responses || []),
      definition = responses[index] || {},
      schema = definition.content?.[media]?.schema ?? {
        type: "object",
        properties: {},
      };
    let readSchema;
    modal(
      "编辑响应定义",
      '<div class="response-schema-meta"><label>状态<input id="schema-response-status" value="' +
        esc(
          definition.status ||
            (responses.some((item) => String(item.status) === "200")
              ? ""
              : "200"),
        ) +
        '" placeholder="201 / 4XX / default"></label><label>Content-Type<input id="schema-response-media" value="' +
        esc(media) +
        '"></label><label>说明<input id="schema-response-description" value="' +
        esc(definition.description || "") +
        '"></label></div><p class="muted">更换Content-Type会新增该类型，不删除原有类型及示例。</p><div id="schema-editor">' +
        schemaEditor(schema) +
        "</div>",
      () => {
        request().responses = editResponseDefinition(responses, index, {
          status: $("#schema-response-status").value,
          description: $("#schema-response-description").value,
          mediaType: $("#schema-response-media").value,
          schema: readSchema(),
        });
        mark();
        render();
      },
    );
    readSchema = bindSchemaEditor($("#schema-editor"), schema);
  };
  on("#new-response-schema", "click", () => editResponseSchema());
  on("[data-response-schema]", "click", (_, element) =>
    editResponseSchema(...JSON.parse(element.dataset.responseSchema)),
  );
  on("#visual-schema", "click", () => {
    collect();
    const schema = request().schema;
    let readSchema;
    modal(
      "编辑请求结构",
      '<div id="schema-editor">' + schemaEditor(schema) + "</div>",
      () => {
        request().schema = readSchema();
        mark();
        render();
      },
    );
    readSchema = bindSchemaEditor($("#schema-editor"), schema);
  });
  on("#folder", "input", (_, e) => {
    request().folder = e.value;
    mark();
  });
  on("#timeout", "change", (_, e) => {
    request().timeout = Number(e.value);
    mark();
  });
  on("#request-proxy", "input", (_, element) => {
    request().proxy = element.value;
    mark();
  });
  on("[data-tls]", "input", (_, element) => {
    request().tls ??= {};
    request().tls[element.dataset.tls] = element.value;
    mark();
  });
  on("#http-version", "change", (_, element) => {
    request().httpVersion = element.value;
    mark();
  });
  on("#response-definitions", "input", () => mark());
  on("#share-api", "click", () => {
    collect();
    modal(
      "分享当前接口",
      "<p>生成单接口离线HTML文件。请检查参数和示例中的密钥/业务数据后再分享。</p>" +
        attributeChooser(project),
      () => {
        download(
          request().name + ".html",
          exportDocumentation(
            { ...project, documents: [], requests: [request()] },
            "html",
            { attributeKeys: selectedSharedAttributes() },
          ),
          "text/html",
        );
      },
      "生成离线文档",
    );
  });
  function editParameterEntry(id, initial) {
    const entry = (project.parameterDictionary || []).find(
      (item) => item.id === id,
    ) ||
      initial || { key: "", type: "string", description: "", note: "" };
    modal(
      "字典参数",
      `<label>参数名</label><input id="dict-key" value="${esc(entry.key)}"><label>类型</label><select id="dict-type">${["string", "integer", "number", "boolean", "object", "array"].map((type) => `<option ${type === entry.type ? "selected" : ""}>${type}</option>`).join("")}</select><label>说明</label><input id="dict-description" value="${esc(entry.description)}"><label>备注</label><input id="dict-note" value="${esc(entry.note)}"><label>默认值 / 示例 / 枚举（JSON对象）</label>${jsonEditor(Object.fromEntries(["default", "example", "enum"].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])))}`,
      async () => {
        const extras = JSON.parse($("#modal-json").value);
        if (!extras || typeof extras !== "object" || Array.isArray(extras))
          throw Error("扩展定义必须是JSON对象");
        const key = $("#dict-key").value.trim();
        if (
          !key ||
          key.length > 200 ||
          ["__proto__", "prototype", "constructor"].includes(key)
        )
          throw Error("参数名无效");
        if (extras.enum !== undefined && !Array.isArray(extras.enum))
          throw Error("枚举值必须是数组");
        const previous = structuredClone(project.parameterDictionary || []);
        const value = {
          ...extras,
          id: entry.id || uid(),
          key: $("#dict-key").value,
          type: $("#dict-type").value,
          description: $("#dict-description").value,
          note: $("#dict-note").value,
        };
        project.parameterDictionary ??= [];
        const index = project.parameterDictionary.findIndex(
          (item) => item.id === id,
        );
        if (index < 0) project.parameterDictionary.push(value);
        else project.parameterDictionary[index] = value;
        mark();
        try {
          await save();
        } catch (error) {
          project.parameterDictionary = previous;
          mark();
          throw error;
        }
      },
    );
  }
  on("#builtin-dictionary", "change", (_, element) => {
    project.settings ??= {};
    project.settings.builtinDictionary = element.checked;
    mark();
  });
  on("#new-parameter-entry", "click", () => editParameterEntry());
  on("[data-edit-parameter-entry]", "click", (_, element) =>
    editParameterEntry(element.dataset.editParameterEntry),
  );
  on("[data-delete-parameter-entry]", "click", async (_, element) => {
    if (!confirm("删除字典参数？已应用到接口的参数不变。")) return;
    project.parameterDictionary = project.parameterDictionary.filter(
      (item) => item.id !== element.dataset.deleteParameterEntry,
    );
    mark();
    await save();
  });
  on("[data-save-temporary-parameter]", "click", (_, element) =>
    editParameterEntry(
      undefined,
      (temporaryParameters.get(project.id) || [])[
        Number(element.dataset.saveTemporaryParameter)
      ],
    ),
  );
  on("[data-dictionary-pair]", "click", (_, element) => {
    const [kind, index] = element.dataset.dictionaryPair.split(":");
    modal(
      "选择字典参数",
      `<select id="parameter-choice">${effectiveParameterDictionary(project)
        .map(
          (entry) =>
            `<option value="${esc(entry.id)}">${esc(entry.key)} · ${esc(entry.type)} · ${esc(entry.note || entry.description)}</option>`,
        )
        .join("")}</select>`,
      () => {
        const entry = effectiveParameterDictionary(project).find(
          (item) => item.id === $("#parameter-choice").value,
        );
        if (!entry) throw Error("请先添加字典参数");
        const value = dictionaryValue(entry);
        Object.assign(request()[kind][Number(index)], {
          key: entry.key,
          value:
            typeof value === "object" ? JSON.stringify(value) : String(value),
          description: entry.description,
          required: entry.required === true,
          schema: {
            type: entry.type,
            ...(entry.enum ? { enum: entry.enum } : {}),
          },
        });
        mark();
        render();
      },
    );
  });
  on("#import-parameter-dictionary", "click", () =>
    modal(
      "导入参数字典",
      '<select id="dictionary-format"><option value="kv">key-value</option><option value="json">JSON</option><option value="mysql">MySQL CREATE TABLE</option></select><textarea id="dictionary-source" placeholder="name: 姓名"></textarea>',
      async () => {
        const preview = await api(
          "/projects/" + project.id + "/dictionary-preview",
          "POST",
          {
            format: $("#dictionary-format").value,
            source: $("#dictionary-source").value,
          },
        );
        setTimeout(
          () =>
            modal(
              "确认字典导入",
              "<p>同名同类型的已有项默认不选；源内重复项取信息更完整者。</p>" +
                preview
                  .map(
                    (item, index) =>
                      `<label><input data-import-parameter="${index}" type="checkbox" ${item.duplicate ? "" : "checked"}>${esc(item.entry.key)} · ${esc(item.entry.type)} · ${item.duplicate ? "已有重复" : "新增"}</label>`,
                  )
                  .join(""),
              async () => {
                project.parameterDictionary ??= [];
                for (const input of document.querySelectorAll(
                  "[data-import-parameter]:checked",
                ))
                  project.parameterDictionary.push(
                    preview[Number(input.dataset.importParameter)].entry,
                  );
                mark();
                await save();
              },
              "导入选中项",
            ),
          0,
        );
      },
      "预览",
    ),
  );
  on("[data-dynamic-pair]", "click", (_, element) => {
    collect();
    const [group, index] = element.dataset.dynamicPair.split(":");
    editDynamicValue(group, Number(index));
  });
  on("[data-define-pair]", "click", (_, element) => {
    const [kind, index] = element.dataset.definePair.split(":"),
      parameter = request()[kind][Number(index)];
    modal(
      "参数定义",
      `<label>说明</label><input id="parameter-description" value="${esc(parameter.description || "")}"><label><input id="parameter-required" type="checkbox" ${parameter.required ? "checked" : ""}>必填</label><label>JSON Schema</label>${jsonEditor(parameter.schema || { type: "string" })}`,
      () => {
        parameter.description = $("#parameter-description").value;
        parameter.required = $("#parameter-required").checked;
        parameter.schema = JSON.parse($("#modal-json").value);
        if (parameter.key && parameter.description) {
          const entry = {
            key: parameter.key,
            type: parameter.schema.type || "string",
            description: parameter.description,
            example: parameter.value,
          };
          const values = temporaryParameters.get(project.id) || [];
          if (
            !values.some(
              (item) => item.key === entry.key && item.type === entry.type,
            ) &&
            !(project.parameterDictionary || []).some(
              (item) => item.key === entry.key && item.type === entry.type,
            )
          ) {
            values.push(entry);
            temporaryParameters.set(project.id, values);
          }
        }
        mark();
        render();
      },
    );
  });
  on("#request-status", "change", (_, element) => {
    request().statusId = element.value;
    mark();
  });
  on("[data-attribute]", "input", (_, element) => {
    validateAttributeDefinitions(project.settings.attributes);
    const field = project.settings.attributes.find(
      (item) => item.key === element.dataset.attribute,
    );
    const value = attributeInputValue(element, field);
    request().attributes ??= {};
    if (value === undefined) delete request().attributes[field.key];
    else request().attributes[field.key] = value;
    mark();
  });
  on("#new-attribute", "click", () => editAttributeDefinition());
  on("[data-edit-attribute-def]", "click", (_, element) =>
    editAttributeDefinition(Number(element.dataset.editAttributeDef)),
  );
  on("[data-delete-attribute-def]", "click", async (_, element) => {
    if (
      !confirm(
        "删除此属性定义？已有原始值会保留，但不会出现在界面或分享文档中。",
      )
    )
      return;
    project.settings.attributes.splice(
      Number(element.dataset.deleteAttributeDef),
      1,
    );
    mark();
    await save();
  });
  on("#new-function", "click", () => editFunction());
  on("[data-edit-function]", "click", (_, element) =>
    editFunction(Number(element.dataset.editFunction)),
  );
  on("[data-delete-function]", "click", async (_, element) => {
    if (
      !confirm(
        "删除函数后，引用它的请求将无法执行。已保存快照不受影响。继续删除？",
      )
    )
      return;
    const previous = [...(project.settings.functions || [])];
    project.settings.functions.splice(
      Number(element.dataset.deleteFunction),
      1,
    );
    mark();
    try {
      await save();
    } catch (error) {
      project.settings.functions = previous;
      mark();
      throw error;
    }
  });
  on("#new-error-code", "click", () => editErrorCode());
  on("[data-edit-error-code]", "click", (_, element) =>
    editErrorCode(Number(element.dataset.editErrorCode)),
  );
  on("[data-delete-error-code]", "click", async (_, element) => {
    if (!confirm("删除此错误码？当前接口文档会同步移除。")) return;
    project.settings.statusCodes.splice(
      Number(element.dataset.deleteErrorCode),
      1,
    );
    mark();
    await save();
  });
  on("#bulk-error-codes", "click", () => {
    const source = (project.settings?.statusCodes || [])
      .map((item) => String(item.code) + ": " + JSON.stringify(item.label))
      .join("\n");
    modal(
      "批量编辑错误码",
      '<p>每行 错误码:描述。提交后整体替换字典，未列出的代码会移除。多行说明可使用带引号的 JSON 字符串。</p><textarea id="error-codes-source"></textarea>',
      async () => {
        const result = await api(
          "/projects/" + project.id + "/error-codes-preview",
          "POST",
          { source: $("#error-codes-source").value },
        );
        const previous = project.settings?.statusCodes || [];
        project.settings ??= {};
        project.settings.statusCodes = result.codes.map((item) => ({
          ...item,
          httpHint:
            previous.find((old) => String(old.code) === String(item.code))
              ?.httpHint === true,
        }));
        mark();
        try {
          await save();
        } catch (error) {
          project.settings.statusCodes = previous;
          mark();
          throw error;
        }
      },
    );
    $("#error-codes-source").value = source;
  });
  on("#mock-builtins", "change", (_, element) => {
    project.settings ??= {};
    project.settings.smartMockBuiltins = element.checked;
    mark();
  });
  on("#mock-seed", "input", (_, element) => {
    project.settings ??= {};
    project.settings.mockSeed = Number(element.value);
    mark();
  });
  on("#new-mock-field", "click", () => editMockField());
  on("[data-edit-mock-field]", "click", (_, element) =>
    editMockField(element.dataset.editMockField),
  );
  on("[data-mock-field-enabled]", "change", (_, element) => {
    project.settings.mockFieldRules.find(
      (rule) => rule.id === element.dataset.mockFieldEnabled,
    ).enabled = element.checked;
    mark();
  });
  on("[data-delete-mock-field]", "click", async (_, element) => {
    if (!confirm("删除这条字段生成规则？已有请求体不会改变。")) return;
    project.settings.mockFieldRules = project.settings.mockFieldRules.filter(
      (rule) => rule.id !== element.dataset.deleteMockField,
    );
    mark();
    await save();
  });
  on("[data-settings-anchor]", "click", (_, element) => {
    collect();
    settingsSection = element.dataset.settingsAnchor;
    render();
  });
  on("[data-edit-resource]", "click", (_, element) => {
    const key = element.dataset.editResource,
      spec = resources[key];
    modal(
      "编辑" + spec.name,
      `<p>${esc(spec.help)}</p><details><summary>示例格式</summary><pre>${esc(JSON.stringify(spec.sample, null, 2))}</pre></details>${jsonEditor(project.settings?.[key] || [])}`,
      async () => {
        const value = JSON.parse($("#modal-json").value);
        if (!Array.isArray(value)) throw Error("资源必须是数组");
        if (key === "attributes") {
          validateAttributeDefinitions(value);
          for (const record of [...project.requests, ...project.documents])
            validateAttributeValues(record.attributes, value);
        }
        const previous = project.settings?.[key];
        project.settings ??= {};
        project.settings[key] = value;
        mark();
        try {
          await save();
        } catch (error) {
          project.settings[key] = previous;
          mark();
          throw error;
        }
        render();
      },
    );
  });
  on("#request-service", "change", (_, e) => {
    request().serviceId = e.value;
    request().serviceSnapshot = false;
    mark();
  });
  on("#schema", "input", () => mark());
  on("#schema", "change", (_, e) => {
    request().schema = JSON.parse(e.value);
    mark();
  });
  on("[data-mode]", "click", (_, e) => {
    collect();
    mode = e.dataset.mode;
    render();
  });
  on("[data-param]", "click", (_, e) => {
    collect();
    param = e.dataset.param;
    render();
  });
  on("[data-response]", "click", (_, e) => {
    responseTab = e.dataset.response;
    render();
  });
  on("#body-code", "input", (_, element) => {
    if ($("#code-highlight"))
      $("#code-highlight").innerHTML = highlightJSON(element.value) + "\n";
    if ($("#code-gutter"))
      $("#code-gutter").textContent = element.value
        .split("\n")
        .map((_, index) => index + 1)
        .join("\n");
  });
  on("#body-code", "scroll", (_, element) => {
    if ($("#code-highlight")) {
      $("#code-highlight").scrollTop = element.scrollTop;
      $("#code-highlight").scrollLeft = element.scrollLeft;
    }
    if ($("#code-gutter")) $("#code-gutter").scrollTop = element.scrollTop;
  });
  on('input[name="body-type"],#raw-format', "change", (_, e) => {
    collect();
    if (["none", "form-data", "urlencoded"].includes(e.value))
      bodyExpanded = false;
    if (e.name === "body-type" && e.value === "raw" && !$("#raw-format"))
      request().bodyType = "json";
    mark();
    render();
  });
  on("#expand-body", "click", () => {
    collect();
    bodyExpanded = !bodyExpanded;
    render();
    $("#body-code")?.focus();
  });
  on("#toggle-parameter-helper", "click", () => {
    collect();
    helperOpen = !helperOpen;
    render();
  });
  on("#new-body-dynamic", "click", () => editDynamicValue("body"));
  on("[data-edit-body-dynamic]", "click", (_, element) =>
    editDynamicValue("body", element.dataset.editBodyDynamic),
  );
  on("#insert-builtin-variable", "click", () => {
    const name = $("#builtin-variable").value;
    insertVariable(name);
    if ($("#builtin-variable")) $("#builtin-variable").value = name;
  });
  on("[data-insert-variable]", "click", (_, element) => {
    insertVariable(element.dataset.insertVariable);
  });
  on("[data-insert-dictionary]", "click", (_, element) => {
    collect();
    const entry = effectiveParameterDictionary(project).find(
      (item) => item.id === element.dataset.insertDictionary,
    );
    if (!entry) throw Error("字典参数已不存在");
    request().body = insertDictionaryField(request().body, entry);
    request().bodyType = "json";
    mark();
    render();
  });
  on("#generate-body", "click", async () => {
    const data = await api("/projects/" + project.id + "/sample", "POST", {
      schema: request().schema,
    });
    request().body = JSON.stringify(data.sample, null, 2);
    request().bodyType = "json";
    mark();
    render();
  });
  on("#format-json", "click", () => {
    collect();
    request().body = JSON.stringify(JSON.parse(request().body), null, 2);
    mark();
    render();
  });
  on("[data-field-type]", "change", (_, e) => {
    request().form[e.dataset.fieldType].type = e.value;
    mark();
    render();
  });
  on("[data-field-file]", "change", async (_, e) => {
    const file = e.files[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) throw Error("文件不能超过 6 MiB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    Object.assign(request().form[e.dataset.fieldFile], {
      type: "file",
      filename: file.name,
      requiresFile: false,
      value: btoa(binary),
    });
    mark();
    render();
  });
  on("[data-pair]", "input", (_, e) => {
    const [k, i, f] = e.dataset.pair.split(":");
    request()[k][i][f] = e.value;
    mark();
  });
  on("[data-pair-enabled]", "change", (_, e) => {
    const [k, i] = e.dataset.pairEnabled.split(":");
    request()[k][i].enabled = e.checked;
    mark();
  });
  on("[data-add-pair]", "click", (_, e) => {
    request()[e.dataset.addPair].push({ key: "", value: "", enabled: true });
    mark();
    render();
  });
  on("[data-remove-pair]", "click", (_, e) => {
    const [k, i] = e.dataset.removePair.split(":");
    request()[k].splice(Number(i), 1);
    mark();
    render();
  });
  on("#auth-type", "change", (_, e) => {
    request().auth.type = e.value;
    mark();
    render();
  });
  on("[data-auth]", "input", (_, e) => {
    request().auth[e.dataset.auth] = e.value;
    mark();
  });
  on("#script-code", "input", (_, element) => {
    request()[param + "Script"] = element.value;
    mark();
  });
  on("#oauth-get", "click", async () => {
    const requestId = current,
      projectId = project.id;
    const config = structuredClone(request().auth);
    const applyToken = (result) => {
      if (project.id !== projectId)
        throw Error("项目已切换，令牌未写入其他项目");
      const target = project.requests.find((item) => item.id === requestId);
      if (!target) throw Error("原请求已不存在");
      target.auth.token = result.accessToken;
      if (result.refreshToken) target.auth.refreshToken = result.refreshToken;
      mark();
      render();
      toast("OAuth 令牌已获取，尚未保存到磁盘");
    };
    if (config.grantType === "authorization_code") {
      const flow = await api("/oauth/start", "POST", config);
      modal(
        "OAuth 授权",
        `<p>请先在身份提供方登记此回调地址：</p><pre>${esc(flow.redirectUri)}</pre><p><a href="${esc(flow.authorizationUrl)}" target="_blank" rel="noopener noreferrer">打开授权页面</a></p><p>授权结束后返回这里检查结果。流程 5 分钟后过期。</p>`,
        async () => {
          const status = await api("/oauth/status/" + flow.id);
          if (status.status === "error") throw Error(status.error);
          if (status.status !== "completed") throw Error("授权尚未完成");
          applyToken(status.result);
        },
        "检查授权结果",
      );
    } else applyToken(await api("/oauth/token", "POST", config));
  });
  on("#edit-operations", "click", editRules);
  on("#add-assertion", "click", () => {
    request().assertions.push({ target: "status", op: "eq", value: 200 });
    mark();
    render();
  });
  on("[data-rule]", "change", (_, e) => {
    const [i, key] = e.dataset.rule.split(":");
    let value = e.value;
    if (key === "value") {
      try {
        value = JSON.parse(value);
      } catch {}
    }
    request().assertions[i][key] = value;
    mark();
  });
  on("[data-remove-rule]", "click", (_, e) => {
    request().assertions.splice(Number(e.dataset.removeRule), 1);
    mark();
    render();
  });
  on("#add-extract", "click", () => {
    request().extract.push({ name: "token", path: "$.token" });
    mark();
    render();
  });
  on("[data-extract]", "input", (_, e) => {
    const [i, key] = e.dataset.extract.split(":");
    request().extract[i][key] = e.value;
    mark();
  });
  on("[data-remove-extract]", "click", (_, e) => {
    request().extract.splice(Number(e.dataset.removeExtract), 1);
    mark();
    render();
  });
  on("#send-menu-curl", "click", (_, element) => {
    element.closest("details").open = false;
    $("#curl").click();
  });
  on("#send-menu-plan", "click", () => {
    mode = "cases";
    render();
    $("#create-case").click();
  });
  on("#save-menu-copy", "click", () => $("#duplicate").click());
  on("#save-menu-project", "click", () => save());
  on("#duplicate", "click", () => {
    collect();
    const r = structuredClone(request());
    r.id = uid();
    r.name += " 副本";
    project.requests.push(r);
    current = r.id;
    response = null;
    if (!opened.includes(current)) opened.push(current);
    mark();
    render();
  });
  on("#delete", "click", () => {
    if (!confirm("将此接口移到回收站？")) return;
    request().deletedAt = new Date().toISOString();
    current = project.requests.find((r) => !r.deletedAt)?.id;
    response = responses.get(project.id + ":" + current) || null;
    mark();
    render();
  });
  on("[data-restore]", "click", (_, e) => {
    delete project.requests.find((r) => r.id === e.dataset.restore).deletedAt;
    mark();
    save();
  });
  on("#send", "click", send);
  on("#cancel", "click", () => api("/cancel", "POST", { id: runId }));
  on("#download-response-binary", "click", () => {
    const bytes = Uint8Array.from(atob(response.rawBodyBase64), (character) =>
      character.charCodeAt(0),
    );
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/octet-stream" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "response.bin";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  on("#curl", "click", async () => {
    collect();
    const r = await api("/projects/" + project.id + "/curl", "POST", {
      request: request(),
      environmentId: env(),
    });
    modal(
      "cURL（Bash）",
      `<p class="muted">按当前环境生成，不执行前后置脚本。可能包含认证凭据，请勿公开分享。HTTP/2命令需要支持HTTP/2的cURL；HTTPS严格HTTP/2需cURL8.10或更新版。</p><textarea id="curl-output" readonly>${esc(r.curl)}</textarea>`,
      () => navigator.clipboard.writeText(r.curl),
      "复制",
    );
  });
  on("#import", "click", () =>
    modal(
      "导入接口",
      `<p class="muted">支持项目JSON、OpenAPI JSON/YAML、Postman Collection、cURL及Apipost公共转换器JSON（有限兼容）。仅解析，不执行导入内容。</p><label>导入方式</label><select id="import-mode"><option value="interfaces">导入接口到当前项目</option><option value="restore">完整恢复项目备份为新副本</option></select><input id="import-file" type="file" accept=".json,.yaml,.yml,.txt"><textarea id="import-text" placeholder="粘贴 JSON 或 cURL"></textarea>`,
      async () => {
        if (dirty) {
          if (!confirm("当前有未保存修改，先保存再导入？"))
            throw Error("导入已取消，修改仍保留");
          await save();
        }
        const f = $("#import-file").files[0],
          document = f ? await f.text() : $("#import-text").value;
        if ($("#import-mode").value === "restore") {
          const restored = await api("/restore", "POST", { document });
          projects = await api("/projects");
          await openProject(restored.id);
        } else {
          project = await api("/projects/" + project.id + "/import", "POST", {
            document,
          });
          current = project.requests.at(-1)?.id;
          response = null;
          if (current && !opened.includes(current)) opened.push(current);
          if (request()?.importNotes?.length) {
            page = "apis";
            mode = "design";
          }
          render();
        }
        toast(
          request()?.importNotes?.length
            ? "导入完成，请确认导入提示"
            : "导入完成",
        );
      },
    ),
  );
  on("#export", "click", () =>
    modal(
      "导出项目",
      '<label>格式</label><select id="export-format"><option value="native">本地项目 JSON（包含环境和历史）</option><option value="openapi">OpenAPI 3 JSON（接口定义）</option></select><p class="notice">导出内容可能包含密钥、请求凭据和响应数据，请检查后再分享。</p>',
      async () => {
        await save();
        const format = $("#export-format").value;
        const data = await api(
          "/projects/" + project.id + "/export?format=" + format,
        );
        download(project.name + "." + format + ".json", data);
      },
      "导出",
    ),
  );
  on("#locate-request", "click", () => {
    collect();
    const selected = request();
    if (!selected || selected.deletedAt) throw Error("没有当前接口可定位");
    search = "";
    searchType = "all";
    collapsedFolders.delete(project.id + ":" + (selected.folder || "未分组"));
    page = "apis";
    render();
    const item = document.querySelector(
      '[data-request="' + CSS.escape(current) + '"]',
    );
    item?.scrollIntoView({ block: "nearest" });
    item?.focus({ preventScroll: true });
  });
  on("#tree-type", "change", (_, element) => {
    searchType = element.value;
    $("#tree").innerHTML = tree();
    bindTree();
  });
  on("#save-protocol", "click", async () => {
    const item = {
      id: selectedProtocolId || uid(),
      name: $("#protocol-name").value || "新连接",
      type: $("#protocol-type").value,
      url: $("#protocol-url").value,
      port: Number($("#protocol-port").value),
    };
    project.protocols ??= [];
    const index = project.protocols.findIndex(
      (existing) => existing.id === item.id,
    );
    if (index < 0) project.protocols.push(item);
    else project.protocols[index] = item;
    selectedProtocolId = item.id;
    mark();
    await save();
  });
  on("#delete-protocol", "click", async () => {
    if (!selectedProtocolId) throw Error("请从目录选择已保存的连接");
    if (!confirm("删除连接定义？当前连接不会因此断开。")) return;
    project.protocols = (project.protocols || []).filter(
      (item) => item.id !== selectedProtocolId,
    );
    selectedProtocolId = "";
    mark();
    await save();
  });
  on("#session-connect", "click", async () => {
    if (activeSession && ["open", "connecting"].includes(activeSession.state))
      throw Error("请先断开当前会话");
    activeSession = await api("/protocol-sessions", "POST", {
      type: $("#protocol-type").value,
      url: $("#protocol-url").value,
      host: $("#protocol-url").value,
      port: Number($("#protocol-port").value),
    });
    clearTimeout(sessionTimer);
    pollSession();
  });
  on("#session-send", "click", async () => {
    if (!activeSession) throw Error("尚未连接");
    activeSession = await api(
      "/protocol-sessions/" + activeSession.id + "/send",
      "POST",
      { message: $("#protocol-message").value },
    );
    showSession();
  });
  on("#session-stop", "click", async () => {
    if (!activeSession) return;
    activeSession = await api(
      "/protocol-sessions/" + activeSession.id + "/stop",
      "POST",
      {},
    );
    clearTimeout(sessionTimer);
    showSession();
  });
  on("#session-export", "click", () => {
    if (!activeSession) throw Error("没有会话消息");
    download("protocol-session.json", activeSession);
  });
  on("#protocol-run", "click", async () => {
    runId = uid();
    busy = true;
    $("#protocol-run").disabled = true;
    try {
      const type = $("#protocol-type").value;
      const result = await api(
        "/projects/" + project.id + "/protocol",
        "POST",
        {
          type,
          url: $("#protocol-url").value,
          host: $("#protocol-url").value,
          port: Number($("#protocol-port").value),
          duration: Number($("#protocol-duration").value),
          message: $("#protocol-message").value,
          runId,
        },
      );
      $("#protocol-result").textContent = JSON.stringify(result, null, 2);
    } finally {
      busy = false;
      if ($("#protocol-run")) $("#protocol-run").disabled = false;
    }
  });
  on("#db-query", "click", async () => {
    const result = await api("/projects/" + project.id + "/database", "POST", {
      type: $("#db-type").value,
      host: $("#db-host").value,
      port: Number($("#db-port").value),
      user: $("#db-user").value,
      password: $("#db-password").value,
      database: $("#db-name").value,
      ssl: $("#db-tls").checked,
      filename: $("#db-path").value,
      sql: $("#db-sql").value,
      parameters: JSON.parse($("#db-params").value),
    });
    $("#db-result").textContent = JSON.stringify(result, null, 2);
  });
  on("#archive-project", "click", async () => {
    if (!confirm("归档当前项目？文件和历史会保留，可在回收站恢复。")) return;
    project.archived = true;
    mark();
    await save();
    projects = await api("/projects");
    let next = projects.find((item) => !item.archived && !item.error);
    if (!next) {
      next = await api("/projects", "POST", { name: "默认项目" });
      projects = await api("/projects");
    }
    await openProject(next.id);
  });
  on("[data-restore-project]", "click", async (_, element) => {
    const restored = await api("/projects/" + element.dataset.restoreProject);
    restored.archived = false;
    await api("/projects/" + restored.id, "PUT", restored);
    projects = await api("/projects");
    render();
    toast("项目已恢复");
  });
  on("[data-debug-env]", "click", async (_, element) => {
    const projectId = project.id;
    const context = await api(
      "/projects/" +
        projectId +
        "/debug-variables?environmentId=" +
        encodeURIComponent(element.dataset.debugEnv),
    );
    modal(
      "调试运行时变量",
      "<p>这是当前有效值，包含全局/环境基础值。修改仅影响本进程内此环境的调试；不写入项目文件。删除基础值会临时隐藏它，清空调试变量后恢复。持久化变量变化后，旧运行值也会失效。</p>" +
        jsonEditor(context.variables),
      async () => {
        await api("/projects/" + projectId + "/debug-variables", "PUT", {
          ...context,
          variables: JSON.parse($("#modal-json").value),
        });
        toast("运行时变量已更新");
      },
    );
  });
  on("#clear-session", "click", async () => {
    await api("/projects/" + project.id + "/clear-session", "POST", {});
    toast("临时变量已清空，后续调试使用已保存的环境值");
  });
  on("#project-name", "input", (_, e) => {
    project.name = e.value;
    mark();
  });
  on("#edit-globals", "click", () =>
    modal("编辑全局变量", jsonEditor(project.globalVariables || {}), () => {
      const values = JSON.parse($("#modal-json").value);
      if (!values || typeof values !== "object" || Array.isArray(values))
        throw Error("变量必须是JSON对象");
      for (const key of Object.keys(values))
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw Error("变量名无效");
      project.globalVariables = values;
      mark();
      render();
    }),
  );
  function editService(id) {
    const server = (project.servers || []).find((item) => item.id === id);
    modal(
      server ? "编辑共享服务" : "新建共享服务",
      `<label>服务名称</label><input id="service-name" value="${esc(server?.name || "")}">${project.environments.map((environment) => `<label>${esc(environment.name)} 地址</label><input data-service-url="${environment.id}" value="${esc(environment.serverUrls?.[id] || "")}" placeholder="https://api.example.com">`).join("")}`,
      () => {
        const name = $("#service-name").value.trim();
        if (!name) throw Error("服务名称不能为空");
        const urls = [...document.querySelectorAll("[data-service-url]")].map(
          (input) => {
            const value = input.value.trim();
            if (value) {
              let parsed;
              try {
                parsed = new URL(value);
              } catch {
                throw Error("服务地址无效");
              }
              if (
                !["http:", "https:"].includes(parsed.protocol) ||
                parsed.username ||
                parsed.password
              )
                throw Error("服务地址须为不含凭据的HTTP/HTTPS URL");
            }
            return [input.dataset.serviceUrl, value.replace(/\/$/, "")];
          },
        );
        const item = server || { id: uid(), name };
        item.name = name;
        if (!server) (project.servers ??= []).push(item);
        for (const [environmentId, url] of urls) {
          const environment = project.environments.find(
            (e) => e.id === environmentId,
          );
          (environment.serverUrls ??= {})[item.id] = url;
        }
        mark();
        render();
      },
    );
  }
  on("#add-service", "click", () => editService());
  on("[data-edit-service]", "click", (_, e) =>
    editService(e.dataset.editService),
  );
  on("[data-delete-service]", "click", (_, e) => {
    if (
      !confirm(
        "删除共享服务？绑定该服务的接口会要求重新配置；请求数据不会删除。",
      )
    )
      return;
    project.servers = (project.servers || []).filter(
      (server) => server.id !== e.dataset.deleteService,
    );
    for (const environment of project.environments)
      if (environment.serverUrls)
        delete environment.serverUrls[e.dataset.deleteService];
    mark();
    render();
  });
  on("#add-env", "click", () =>
    modal(
      "新建环境",
      '<label>环境名称</label><input id="env-name"><label>变量（JSON 对象）</label>' +
        jsonEditor({ baseUrl: "http://localhost:8080" }),
      () => {
        project.environments.push({
          id: uid(),
          name: $("#env-name").value || "新环境",
          variables: JSON.parse($("#modal-json").value),
        });
        mark();
        render();
      },
    ),
  );
  on("[data-edit-env]", "click", (_, e) => {
    const v = project.environments.find((v) => v.id === e.dataset.editEnv);
    modal(
      "编辑 " + v.name,
      `<label>环境名称</label><input id="edit-env-name" value="${esc(v.name)}">` +
        jsonEditor(v.variables),
      () => {
        v.name = $("#edit-env-name").value.trim() || v.name;
        v.variables = JSON.parse($("#modal-json").value);
        mark();
        render();
      },
    );
  });
  on("[data-delete-env]", "click", (_, e) => {
    if (project.environments.length === 1) throw Error("至少保留一个环境");
    project.environments = project.environments.filter(
      (v) => v.id !== e.dataset.deleteEnv,
    );
    if (project.currentEnvironmentId === e.dataset.deleteEnv)
      project.currentEnvironmentId = project.environments[0].id;
    for (const plan of project.plans)
      if (plan.environmentId === e.dataset.deleteEnv)
        plan.environmentId = project.environments[0].id;
    mark();
    render();
  });
  on("#mock-enabled", "change", (_, e) => {
    project.settings ??= {};
    project.settings.mockEnabled = e.checked;
    mark();
  });
  on("#edit-mock-rules", "click", () => {
    modal(
      "条件响应期望",
      `<p>target 支持 method、query.key、headers.name、body.path。操作 eq / neq / contains / exists；最多100条规则，延迟最多5000ms。</p>${jsonEditor(request().mockRules?.length ? request().mockRules : [{ name: "示例规则", enabled: false, conditions: [{ target: "query.role", op: "eq", value: "admin" }], response: { status: 200, headers: { "content-type": "application/json" }, body: '{"role":"admin"}', delayMs: 0 } }])}`,
      async () => {
        request().mockRules = JSON.parse($("#modal-json").value);
        mark();
        await save();
      },
    );
  });
  on("#add-example", "click", () => editExample());
  on("[data-edit-example]", "click", (_, e) =>
    editExample(Number(e.dataset.editExample)),
  );
  on("#use-mock", "click", () => {
    request().url = `${location.origin}/mock/${project.id}/${request().id}`;
    mode = "debug";
    mark();
    render();
  });
  async function editInterfaceCase(id) {
    collect();
    const item = (project.cases || []).find((candidate) => candidate.id === id);
    const source = item?.sourceRequestId || current;
    modal(
      item ? "编辑接口用例" : "新建接口用例",
      `<label>用例名称</label><input id="case-name" value="${esc(item?.name || "新用例")}"><label>独立请求快照</label>${jsonEditor(item?.request || request())}`,
      async () => {
        if (dirty) await save();
        const result = await api("/projects/" + project.id + "/cases", "POST", {
          id: item?.id,
          name: $("#case-name").value,
          sourceRequestId: source,
          request: JSON.parse($("#modal-json").value),
          functions: item?.functions,
          createdAt: item?.createdAt,
        });
        project = result.project;
        render();
      },
    );
  }
  on("#new-interface-case", "click", () => editInterfaceCase());
  on("[data-edit-case]", "click", (_, e) =>
    editInterfaceCase(e.dataset.editCase),
  );
  on("[data-delete-case]", "click", async (_, e) => {
    if (!confirm("删除此接口用例？历史执行记录仍保留。")) return;
    project.cases = (project.cases || []).filter(
      (item) => item.id !== e.dataset.deleteCase,
    );
    mark();
    await save();
    render();
  });
  on("[data-run-case]", "click", async (_, e) => {
    const item = project.cases.find(
      (candidate) => candidate.id === e.dataset.runCase,
    );
    if (dirty) await save();
    const environmentId = env();
    busy = true;
    runId = uid();
    render();
    try {
      const result = await api("/projects/" + project.id + "/execute", "POST", {
        request: { ...item.request, name: item.name, serviceSnapshot: true },
        functions: item.functions,
        environmentId,
        runId,
      });
      caseResults.set(item.id, result);
      const latest = await api("/projects/" + project.id);
      project.history = latest.history;
      const adoption = adoptVariableWrites(
        project,
        latest,
        result.variableWrites,
      );
      if (adoption === "none") project.revision = latest.revision;
      if (adoption === "conflict")
        toast("变量已保存，但项目还有其他变更；请重新加载并检查后再保存");
    } finally {
      busy = false;
      render();
    }
  });
  on("#load-count,#load-concurrency", "input", () => {
    loadOptions.set(project.id + ":" + current, {
      count: $("#load-count").value,
      concurrency: $("#load-concurrency").value,
    });
  });
  on("#load-run", "click", async () => {
    collect();
    const count = Number($("#load-count").value),
      concurrency = Number($("#load-concurrency").value);
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 100 ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 10
    )
      throw Error("压测次数须为1至100整数，并发须为1至10整数");
    if (
      !confirm("确认你有权执行此次压测，以及其中脚本和子请求可能产生的副作用？")
    )
      return;
    loadOptions.set(project.id + ":" + current, { count, concurrency });
    loadResult = null;
    busy = true;
    runId = uid();
    render();
    try {
      loadResult = await api("/projects/" + project.id + "/load", "POST", {
        request: request(),
        environmentId: env(),
        count,
        concurrency,
        runId,
      });
    } finally {
      busy = false;
      render();
    }
  });
  on("#new-plan,#create-case", "click", () => {
    collect();
    modal(
      "新建执行计划",
      '<label>计划名称</label><input id="plan-name" class="${plan.provenance?.fields?.name==="ai"?"ai-value":""}" value="业务流程验证"><p class="muted">保存当前接口快照，后续接口变更不会影响计划。</p>',
      async () => {
        page = "plans";
        await savePlan({
          name: $("#plan-name").value,
          environmentId: env(),
          steps: request()
            ? [{ request: snapshotInterfaceForPlan(request()) }]
            : [],
        });
      },
    );
  });
  on("[data-plan-tab]", "click", (_, element) => {
    planTab = element.dataset.planTab;
    render();
  });
  on("[data-step-drag]", "dragstart", (event, element) => {
    event.dataTransfer.setData("text/plain", element.dataset.stepDrag);
    event.dataTransfer.effectAllowed = "move";
  });
  on("[data-step-drag]", "dragover", (event) => event.preventDefault());
  on("[data-step-drag]", "drop", async (event, element) => {
    event.preventDefault();
    const from = Number(event.dataTransfer.getData("text/plain")),
      to = Number(element.dataset.stepDrag);
    const plan = project.plans.find((item) => item.id === planId);
    if (
      !Number.isInteger(from) ||
      from < 0 ||
      from >= plan.steps.length ||
      from === to
    )
      return;
    const [step] = plan.steps.splice(from, 1);
    plan.steps.splice(to, 0, step);
    await savePlan(plan);
  });
  on("[data-plan]", "click", (_, e) => {
    planId = e.dataset.plan;
    planTab = "plans";
    render();
  });
  on("#plan-name,#plan-description", "input", (_, element) => {
    const plan = project.plans.find((item) => item.id === planId);
    if (plan) {
      plan[element.id === "plan-name" ? "name" : "description"] = element.value;
      mark();
    }
  });
  on("#save-plan-details", "click", async () => {
    const plan = structuredClone(project.plans.find((p) => p.id === planId));
    plan.name = $("#plan-name").value.trim();
    if (!plan.name) throw Error("计划名称不能为空");
    plan.description = $("#plan-description").value;
    plan.source = "manual";
    plan.updatedAt = new Date().toISOString();
    await savePlan(plan);
  });
  on("#delete-plan", "click", async () => {
    if (busy) throw Error("请等待执行结束");
    if (!confirm("删除这个执行计划？已有执行记录仍保留。")) return;
    project.plans = project.plans.filter((p) => p.id !== planId);
    planId = "";
    mark();
    await save();
    render();
  });
  on("#edit-plan", "click", () => {
    const p = project.plans.find((p) => p.id === planId);
    modal("编辑计划 JSON", jsonEditor(p), () =>
      savePlan(JSON.parse($("#modal-json").value)),
    );
  });
  on("#add-step", "click", () =>
    modal(
      "添加步骤",
      `<label>选择接口</label><select id="step-api">${project.requests
        .filter((r) => !r.deletedAt)
        .map(
          (r) => `<option value="${r.id}">${r.method} ${esc(r.name)}</option>`,
        )
        .join("")}</select>`,
      async () => {
        const p = project.plans.find((p) => p.id === planId);
        const r = project.requests.find((r) => r.id === $("#step-api").value);
        if (!r) throw Error("请先创建接口");
        p.steps.push({ request: snapshotInterfaceForPlan(r) });
        await savePlan(p);
      },
    ),
  );
  on("#plan-status-policy", "change", async (_, e) => {
    const plan = project.plans.find((item) => item.id === planId);
    plan.statusPolicy = e.value;
    await savePlan(plan);
  });
  on("#plan-env", "change", (_, e) => {
    const p = project.plans.find((p) => p.id === planId);
    p.environmentId = e.value;
    savePlan(p);
  });
  on("[data-step-enable]", "change", (_, e) => {
    const p = project.plans.find((p) => p.id === planId);
    p.steps[e.dataset.stepEnable].enabled = e.checked;
    savePlan(p);
  });
  on("[data-step-up]", "click", (_, e) => {
    const p = project.plans.find((p) => p.id === planId),
      i = Number(e.dataset.stepUp);
    [p.steps[i - 1], p.steps[i]] = [p.steps[i], p.steps[i - 1]];
    savePlan(p);
  });
  on("[data-step-delete]", "click", (_, e) => {
    const p = project.plans.find((p) => p.id === planId);
    p.steps.splice(Number(e.dataset.stepDelete), 1);
    savePlan(p);
  });
  on("[data-step-edit]", "click", (_, e) => {
    const p = project.plans.find((p) => p.id === planId),
      i = Number(e.dataset.stepEdit);
    let collectEdits;
    modal("编辑步骤快照", stepEditor(p.steps[i]), () => {
      const candidate = structuredClone(p);
      candidate.steps[i] = collectEdits();
      return savePlan(candidate);
    });
    collectEdits = bindStepEditor($("#dialog-content"), p.steps[i]);
  });
  on("#run-plan", "click", async () => {
    if (dirty) {
      await save();
      if (dirty) throw Error("还有新的修改，请先保存");
    }
    busy = true;
    runId = uid();
    render();
    try {
      lastRun = await api("/projects/" + project.id + "/run", "POST", {
        planId,
        runId,
      });
      planTab = "runs";
      project = await api("/projects/" + project.id);
    } finally {
      busy = false;
      render();
    }
  });
  on("[data-export-run]", "click", (_, e) =>
    download(
      "run-" + e.dataset.exportRun + ".json",
      project.runs.find((r) => r.id === e.dataset.exportRun) || lastRun,
    ),
  );
  on("[data-history]", "click", (_, e) => {
    const h = project.history.find((h) => h.id === e.dataset.history);
    modal(
      h.name,
      `<pre>${esc(JSON.stringify(h, null, 2))}</pre>`,
      () => download("request-history.json", h),
      "导出",
    );
  });
  on("#add-dictionary", "click", () => editDictionary());
  on("[data-edit-dictionary]", "click", (_, e) =>
    editDictionary(Number(e.dataset.editDictionary)),
  );
  on("[data-use-dictionary]", "click", (_, e) => {
    if (!request()) throw Error("请先选择接口");
    request().schema = structuredClone(
      project.dictionary[e.dataset.useDictionary].schema,
    );
    mark();
    page = "apis";
    mode = "design";
    render();
  });
  on("#export-docs", "click", () =>
    modal(
      "导出离线文档",
      '<label>格式</label><select id="document-format"><option value="html">独立 HTML（浏览器直接打开）</option><option value="markdown">Markdown</option></select><div class="notice">文档包含请求和响应示例，可能含敏感字段。请检查后再分享。</div>' +
        attributeChooser(project),
      () => {
        const format = $("#document-format").value;
        download(
          project.name + (format === "html" ? ".html" : ".md"),
          exportDocumentation(project, format, {
            attributeKeys: selectedSharedAttributes(),
          }),
          format === "html" ? "text/html" : "text/markdown",
        );
      },
      "导出",
    ),
  );
}
function bindTree() {
  for (const folder of document.querySelectorAll("[data-tree-folder]")) {
    const key = project.id + ":" + folder.dataset.treeFolder;
    folder.ontoggle = () => {
      if (!folder.isConnected || search) return;
      if (folder.open) collapsedFolders.delete(key);
      else collapsedFolders.add(key);
    };
  }

  on("[data-document-index]", "click", (_, element) => {
    collect();
    const index = Number(element.dataset.documentIndex);
    page = "docs";
    render();
    document
      .querySelector('[data-edit-document="' + index + '"]')
      ?.closest("article")
      ?.scrollIntoView({ block: "start" });
  });
  on("[data-protocol-id]", "click", (_, element) => {
    collect();
    const item = project.protocols.find(
      (item) => item.id === element.dataset.protocolId,
    );
    if (!item) return;
    selectedProtocolId = item.id;
    page = "protocols";
    render();
    $("#protocol-type").value = item.type;
    $("#protocol-url").value = item.url;
    $("#protocol-port").value = item.port || "";
    $("#protocol-name").value = item.name;
  });
  on("[data-edit-folder]", "click", (_, element) => {
    const old = element.dataset.editFolder;
    modal(
      "编辑目录",
      `<label>目录名称</label><input id="folder-name" value="${esc(old)}"><label>目录默认服务</label><select id="folder-service"><option value="">不绑定服务</option>${project.settings?.folderServices?.[old] && !(project.servers || []).some((service) => service.id === project.settings.folderServices[old]) ? `<option selected value="${esc(project.settings.folderServices[old])}">已删除服务（保留引用）</option>` : ""}${(project.servers || []).map((service) => `<option value="${esc(service.id)}" ${project.settings?.folderServices?.[old] === service.id ? "selected" : ""}>${esc(service.name)}</option>`).join("")}</select><p class="muted">只影响本目录未显式绑定服务的相对路径接口；完整 URL 保持直连。已有计划和用例快照不变。</p><label><input id="folder-remove" type="checkbox">删除目录并将接口移至未分组（目录服务继承会失效）</label>`,
      () => {
        const remove = $("#folder-remove").checked,
          name = $("#folder-name").value.trim();
        if (!remove && !name) throw Error("名称不能为空");
        if (
          !remove &&
          name !== old &&
          [
            ...(project.folders || []),
            ...project.requests.map((item) => item.folder),
          ].includes(name)
        )
          throw Error("目标目录已存在，请使用其他名称");
        const serviceId = $("#folder-service").value;
        const bindings = { ...(project.settings?.folderServices || {}) };
        delete bindings[old];
        if (!remove && serviceId)
          Object.defineProperty(bindings, name, {
            value: serviceId,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        project.settings ??= {};
        project.settings.folderServices = bindings;
        for (const item of [
          ...project.requests,
          ...(project.protocols || []),
          ...project.documents,
        ])
          if ((item.folder || "未分组") === old)
            item.folder = remove ? "" : name;
        project.folders = (project.folders || []).filter(
          (folder) => folder !== old,
        );
        if (!remove) project.folders.push(name);
        mark();
        render();
      },
    );
  });

  on("[data-request]", "click", (_, e) => {
    collect();
    current = e.dataset.request;
    if (!opened.includes(current)) opened.push(current);
    page = "apis";
    response = responses.get(project.id + ":" + current) || null;
    render();
  });
}
function editExample(index) {
  const r = request(),
    ex = r.examples[index] || {
      name: "成功响应",
      status: 200,
      body: '{\n  "success": true\n}',
    };
  modal(
    "响应示例",
    `<label>名称</label><input id="ex-name" value="${esc(ex.name)}"><label>状态码</label><input id="ex-status" type="number" value="${ex.status}"><label>响应内容</label><textarea id="ex-body">${esc(ex.body)}</textarea>`,
    () => {
      const val = {
        name: $("#ex-name").value,
        status: Number($("#ex-status").value),
        body: $("#ex-body").value,
      };
      if (val.status < 100 || val.status > 599) throw Error("状态码无效");
      if (index === undefined) r.examples.push(val);
      else r.examples[index] = val;
      mark();
      render();
    },
  );
}
function editDictionary(index) {
  const d = project.dictionary[index] || {
    name: "新模型",
    schema: { type: "object", properties: { id: { type: "integer" } } },
  };
  modal(
    "数据模型",
    `<label>名称</label><input id="dict-name" value="${esc(d.name)}">${jsonEditor(d.schema)}`,
    () => {
      const value = {
        name: $("#dict-name").value,
        schema: JSON.parse($("#modal-json").value),
      };
      if (index === undefined) project.dictionary.push(value);
      else project.dictionary[index] = value;
      mark();
      render();
    },
  );
}
async function send() {
  collect();
  const targetId = current,
    projectId = project.id,
    revision = project.revision;
  const snapshot = structuredClone(request());
  const environmentId = env();
  busy = true;
  runId = uid();
  render();
  let result;
  try {
    result = await api("/projects/" + projectId + "/execute", "POST", {
      request: snapshot,
      environmentId,
      runId,
    });
    const updated = await api("/projects/" + projectId);
    if (project.id === projectId) {
      const adoption = adoptVariableWrites(
        project,
        updated,
        result.variableWrites,
      );
      if (adoption === "none" && updated.revision === revision + 1)
        project.revision = updated.revision;
      if (adoption === "conflict")
        toast("变量已保存，但项目还有其他变更；请重新加载并检查后再保存");
      project.history = updated.history;
    }
  } catch (error) {
    result = { error: error.message };
  } finally {
    responses.set(projectId + ":" + targetId, result);
    if (project.id === projectId && current === targetId) response = result;
    busy = false;
    render();
  }
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && bodyExpanded && !$("#dialog").open) {
    collect();
    bodyExpanded = false;
    render();
    $("#expand-body")?.focus();
  }

  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    save().catch((e) => toast(e.message));
  }
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key === "Enter" &&
    page === "apis" &&
    !busy
  ) {
    e.preventDefault();
    send();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
async function init() {
  compactUI = localStorage.getItem("compact-ui") === "true";
  responseLayout =
    localStorage.getItem("response-layout") === "split" ? "split" : "stacked";
  if (localStorage.getItem("theme") === "dark")
    document.body.classList.add("dark");
  token =
    new URLSearchParams(location.hash.slice(1)).get("token") ||
    sessionStorage.getItem("local-api-token") ||
    "";
  if (location.hash)
    history.replaceState(null, "", location.pathname + location.search);
  token = (await api("/session")).token;
  sessionStorage.setItem("local-api-token", token);
  projects = await api("/projects");
  if (!projects.some((item) => !item.archived && !item.error)) {
    const p = await api("/projects", "POST", { name: "默认项目" });
    p.environments[0].variables.baseUrl = location.origin;
    const r = defaultRequest("示例 · 创建用户");
    r.method = "POST";
    r.bodyType = "json";
    r.body = JSON.stringify(
      {
        id: 0,
        username: "username",
        firstName: "",
        lastName: "",
        email: "",
        password: "",
        phone: "",
        userStatus: 0,
      },
      null,
      2,
    );
    r.description = "本地 Mock 响应示例，不是真实用户账户服务。";
    r.folder = "示例接口";
    r.url = location.origin + "/mock/" + p.id + "/" + r.id;
    r.examples = [
      {
        name: "成功响应",
        status: 200,
        body: '{\n  "message": "欢迎使用 Local API",\n  "local": true\n}',
      },
    ];
    r.assertions = [{ target: "status", op: "eq", value: 200 }];
    p.requests.push(r);
    await api("/projects/" + p.id, "PUT", p);
    projects = await api("/projects");
  }
  await openProject(
    projects.find(
      (p) =>
        !p.archived && !p.error && p.id === sessionStorage.getItem("project"),
    )?.id || projects.find((p) => !p.archived && !p.error).id,
  );
}
init().catch((e) => {
  $("#app").innerHTML =
    '<div class="page"><h1>无法启动工作台</h1><pre>' +
    esc(e.message) +
    "</pre><p>请确认本地服务正在运行，然后刷新页面。</p></div>";
});

function selectedSharedAttributes() {
  return [
    ...$("#dialog-content").querySelectorAll("[data-share-attribute]:checked"),
  ].map((element) => element.value);
}
function editAttributeDefinition(index) {
  const existing = project.settings?.attributes?.[index];
  const labels = {
    string: "文本",
    number: "数字",
    select: "单选",
    multiselect: "多选",
    date: "日期",
    url: "链接",
    email: "邮箱",
    boolean: "布尔（兼容）",
  };
  modal(
    existing ? "编辑接口属性" : "新增接口属性",
    `<label>稳定标识</label><input id="attribute-key" value="${esc(existing?.key || "")}" ${existing ? "disabled" : ""}><label>显示名称</label><input id="attribute-label" value="${esc(existing?.label || "")}"><label>类型</label><select id="attribute-type">${attributeTypes.map((type) => `<option value="${type}" ${(existing?.type || "string") === type ? "selected" : ""}>${labels[type]}</option>`).join("")}</select><label>单选/多选选项（每行一个值，或 JSON 数组；其他类型忽略）</label><textarea id="attribute-options">${esc(JSON.stringify(existing?.options || [], null, 2))}</textarea><p class="muted">更改类型或删除选项时，会检查现有值，避免静默丢失数据。</p>`,
    async () => {
      const type = $("#attribute-type").value;
      const field = {
        ...existing,
        key: $("#attribute-key").value.trim(),
        label: $("#attribute-label").value.trim(),
        type,
      };
      if (["select", "multiselect"].includes(type)) {
        const source = $("#attribute-options").value.trim();
        field.options = source.startsWith("[")
          ? JSON.parse(source)
          : source
              .split(/\r?\n/)
              .map((value) => value.trim())
              .filter(Boolean);
      }
      const fields = [...(project.settings?.attributes || [])];
      if (index === undefined) fields.push(field);
      else fields[index] = field;
      validateAttributeDefinitions(fields);
      for (const record of [...project.requests, ...project.documents])
        validateAttributeValues(record.attributes, fields);
      project.settings ??= {};
      const previous = project.settings.attributes;
      project.settings.attributes = fields;
      mark();
      try {
        await save();
      } catch (error) {
        project.settings.attributes = previous;
        mark();
        throw error;
      }
      if (index === undefined) index = fields.length - 1;
    },
  );
}

function editErrorCode(index) {
  const existing = project.settings?.statusCodes?.[index];
  modal(
    existing ? "编辑错误码" : "新增错误码",
    `<label>错误码</label><input id="error-code-value" value="${esc(existing?.code ?? "")}" placeholder="0、10001、AUTH_EXPIRED"><label>说明</label><textarea id="error-code-label">${esc(existing?.label || "")}</textarea><label><input id="error-code-http" type="checkbox" ${existing?.httpHint ? "checked" : ""}>同时用于 HTTP 状态提示（仅100至599）</label>`,
    async () => {
      const raw = $("#error-code-value").value.trim();
      const number = Number(raw);
      const item = {
        code:
          Number.isSafeInteger(number) && String(number) === raw ? number : raw,
        label: $("#error-code-label").value,
        httpHint: $("#error-code-http").checked,
      };
      project.settings ??= {};
      project.settings.statusCodes ??= [];
      const previous = [...project.settings.statusCodes];
      if (index === undefined) project.settings.statusCodes.push(item);
      else project.settings.statusCodes[index] = item;
      mark();
      try {
        await save();
      } catch (error) {
        project.settings.statusCodes = previous;
        mark();
        throw error;
      }
      if (index === undefined) index = project.settings.statusCodes.length - 1;
    },
  );
}

function editMockField(id) {
  const existing = project.settings?.mockFieldRules?.find(
    (rule) => rule.id === id,
  );
  const ruleId = id || uid();
  modal(
    existing ? "编辑字段 Mock 规则" : "新建字段 Mock 规则",
    `<label>规则名称</label><input id="mock-field-name" value="${esc(existing?.name || "")}"><label>字段通配符</label><input id="mock-field-pattern" value="${esc(existing?.pattern || "{name,*_name}")}"><label>字段类型</label><select id="mock-field-type">${["any", "string", "integer", "number", "boolean", "object", "array"].map((type) => `<option ${(existing?.type || "string") === type ? "selected" : ""}>${type}</option>`).join("")}</select><label>Mock 表达式 / JSON 常量</label><input id="mock-field-value" value="${esc(existing?.mock ?? "@cname()")}"><label><input id="mock-field-ignore-case" type="checkbox" ${existing?.ignoreCase ? "checked" : ""}>忽略字段名大小写</label>`,
    async () => {
      project.settings ??= {};
      project.settings.mockFieldRules ??= [];
      const rule = {
        id: ruleId,
        name: $("#mock-field-name").value,
        pattern: $("#mock-field-pattern").value,
        type: $("#mock-field-type").value,
        mock: $("#mock-field-value").value,
        ignoreCase: $("#mock-field-ignore-case").checked,
        enabled: existing?.enabled !== false,
      };
      const index = project.settings.mockFieldRules.findIndex(
        (item) => item.id === ruleId,
      );
      const previous = [...project.settings.mockFieldRules];
      if (index < 0) project.settings.mockFieldRules.push(rule);
      else project.settings.mockFieldRules[index] = rule;
      mark();
      try {
        await save();
      } catch (error) {
        project.settings.mockFieldRules = previous;
        mark();
        throw error;
      }
    },
  );
}

function editDocument(index) {
  const existing = project.documents[index] || {
    title: "新文档",
    content: "# 使用说明\n\n",
  };
  const statuses = project.settings?.statuses || [];
  modal(
    "项目文档",
    `<label>标题</label><input id="document-title" value="${esc(existing.title)}"><label>目录</label><input id="document-folder" value="${esc(existing.folder || "")}"><label>状态</label><select id="document-status"><option value="">未设置状态</option>${existing.statusId && !statuses.some((status) => status.id === existing.statusId) ? `<option selected value="${esc(existing.statusId)}">已删除状态（保留标记）</option>` : ""}${statuses.map((status) => `<option value="${esc(status.id)}" ${status.id === existing.statusId ? "selected" : ""}>${esc(status.name)}</option>`).join("")}</select><div class="form-grid">${attributeFields(project.settings?.attributes || [], existing.attributes, "doc-attribute")}</div><label>Markdown 正文</label><textarea id="document-content">${esc(existing.content)}</textarea><label>实时预览</label><div id="document-preview" class="markdown-content"></div>`,
    () => {
      const fields = project.settings?.attributes || [];
      validateAttributeDefinitions(fields);
      const attributes = { ...(existing.attributes || {}) };
      for (const element of $("#dialog-content").querySelectorAll(
        "[data-doc-attribute]",
      )) {
        const field = fields.find(
          (item) => item.key === element.dataset.docAttribute,
        );
        const value = attributeInputValue(element, field);
        if (value === undefined) delete attributes[field.key];
        else attributes[field.key] = value;
      }
      validateAttributeValues(attributes, fields);
      const record = {
        ...existing,
        id: existing.id || uid(),
        title: $("#document-title").value,
        folder: $("#document-folder").value,
        statusId: $("#document-status").value,
        attributes,
        content: $("#document-content").value,
      };
      if (index === undefined) project.documents.push(record);
      else project.documents[index] = record;
      mark();
      render();
    },
  );
  const input = $("#document-content"),
    preview = $("#document-preview");
  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      preview.innerHTML = renderMarkdown(input.value);
    }, 120);
  };
  preview.innerHTML = renderMarkdown(input.value);
}

function showSession() {
  if ($("#session-status"))
    $("#session-status").textContent = activeSession.state;
  if ($("#session-events"))
    $("#session-events").textContent = activeSession.events
      .map((event) => `${event.at} ${event.direction} ${event.data}`)
      .join("\n");
}
async function pollSession() {
  if (!activeSession) return;
  try {
    activeSession = await api("/protocol-sessions/" + activeSession.id);
    showSession();
    if (["open", "connecting"].includes(activeSession.state))
      sessionTimer = setTimeout(pollSession, 1000);
  } catch (error) {
    toast(error.message);
    clearTimeout(sessionTimer);
  }
}

async function refreshMCPActivity() {
  if (!token || document.hidden) return;
  try {
    mcpState = await api("/mcp/config");
    const running = (mcpState.activities || []).filter(
      (item) => item.status === "running",
    );
    const top = $("#mcp-status");
    if (top)
      top.textContent =
        "MCP · " +
        (running.length
          ? running.length + " 个任务运行中"
          : mcpState.enabled
            ? "已开启"
            : "未开启");
    const area = $("#mcp-plan-status");
    if (area)
      area.textContent = running
        .filter((item) => item.projectId === project?.id)
        .map(
          (item) =>
            item.tool +
            " · " +
            item.completed +
            (item.total ? "/" + item.total : "") +
            " 步",
        )
        .join("；");
  } catch {
    /* Status polling never discards an unsaved editor. */
  }
}
setInterval(refreshMCPActivity, 1000);

function editFunction(index) {
  const existing = project.settings?.functions?.[index];
  let tested = "";
  const read = () => ({
    name: $("#function-name").value.trim(),
    kind: existing?.kind || (existing ? "script" : "transform"),
    body: $("#function-body").value,
  });
  const fingerprint = () =>
    JSON.stringify([read(), $("#function-input").value]);
  modal(
    existing ? "编辑自定义函数" : "新建自定义函数",
    `<label>函数名称</label><input id="function-name" value="${esc(existing?.name || "")}" ${existing ? "disabled" : ""}><label>函数主体（${existing && existing.kind !== "transform" ? "args 数组" : "text 输入值"}）</label><textarea id="function-body"></textarea><label>测试输入（JSON）</label><textarea id="function-input">"示例"</textarea><button id="test-function" type="button">测试函数</button><pre id="function-result">尚未测试</pre>`,
    async () => {
      const fn = read();
      if (!tested || tested !== fingerprint())
        throw Error("请先测试当前函数代码和输入");
      const previous = [...(project.settings?.functions || [])];
      if (previous.some((item, i) => i !== index && item.name === fn.name))
        throw Error("函数名称已存在");
      project.settings ??= {};
      project.settings.functions = [...previous];
      if (index === undefined) project.settings.functions.push(fn);
      else project.settings.functions[index] = fn;
      mark();
      try {
        await save();
      } catch (error) {
        project.settings.functions = previous;
        mark();
        throw error;
      }
      if (index === undefined) index = project.settings.functions.length - 1;
    },
  );
  $("#function-body").value = existing?.body || "return text;";
  $("#test-function").onclick = async () => {
    const stamp = fingerprint();
    tested = "";
    const button = $("#test-function");
    const output = $("#function-result");
    button.disabled = true;
    try {
      const result = await api(
        "/projects/" + project.id + "/function-preview",
        "POST",
        {
          function: read(),
          value: JSON.parse($("#function-input").value),
        },
      );
      if (stamp !== fingerprint())
        throw Error("测试期间内容已更改，请重新测试");
      tested = stamp;
      output.textContent =
        JSON.stringify(result.value, null, 2) +
        (result.logs.length ? "\n日志：\n" + result.logs.join("\n") : "");
    } catch (error) {
      output.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}

function editDynamicValue(group, index) {
  const target = request();
  const editor = $("#body-code");
  const selection = {
    start: editor?.selectionStart || 0,
    end: editor?.selectionEnd || 0,
  };
  collect();
  const bodyId = group === "body" ? index || uid() : undefined;
  const row =
    group === "body"
      ? { dynamic: target.bodyDynamic?.[bodyId] }
      : target[group][index];
  if (row.type === "file") {
    toast("文件参数不能配置动态文本值");
    return;
  }
  const initial = row.dynamic || {
    source: "fixed",
    value: row.value || "",
    functions: [],
  };
  const read = () => ({
    source: $("#dynamic-source").value,
    value:
      $("#dynamic-source").value === "fixed"
        ? JSON.parse($("#dynamic-value").value)
        : $("#dynamic-value").value,
    ...(group === "body" ? { format: $("#dynamic-format").value } : {}),
    ...($("#dynamic-source").value === "mock"
      ? {
          type: $("#dynamic-mock-type").value,
          ...($("#dynamic-seed").value.trim()
            ? { seed: Number($("#dynamic-seed").value) }
            : {}),
        }
      : {}),
    functions: $("#dynamic-functions")
      .value.split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  });
  modal(
    "动态参数值",
    `<p>预览使用当前环境值；发送时会重新读取前置脚本运行后的值。固定值输入JSON，变量输入变量名。处理函数按逗号分隔顺序执行。</p><label>来源</label><select id="dynamic-source"><option value="fixed">固定值</option><option value="variable">变量</option><option value="mock">Mock样例</option></select><label>输入值 / 变量名 / Mock表达式</label><textarea id="dynamic-value"></textarea><details><summary>Mock类型与种子</summary><p>支持 @cname()、@email()、@integer(min,max) 等有界表达式，不是完整Faker/Mock.js。种子留空每次重新生成；填写整数可复现。预览不代表下次随机结果。</p><select id="dynamic-mock-type">${["string", "integer", "number", "boolean", "object", "array"].map((type) => `<option>${type}</option>`).join("")}</select><input id="dynamic-seed" type="number" placeholder="随机种子（可选）"></details>${group === "body" ? '<label>输出方式</label><select id="dynamic-format"><option value="json">JSON值（自动转义/引号）</option><option value="text">原始文本</option></select>' : ""}<label>处理函数</label><input id="dynamic-functions" list="dynamic-function-list"><datalist id="dynamic-function-list">${(project.settings?.functions || []).map((fn) => `<option value="${esc(fn.name)}"></option>`).join("")}</datalist><button id="dynamic-preview" type="button">预览</button><button id="dynamic-remove" type="button">移除动态值</button><pre id="dynamic-result">尚未预览</pre>`,
    () => {
      const spec = read();
      if (group === "body") {
        target.bodyDynamic ??= {};
        target.bodyDynamic[bodyId] = spec;
        if (!index)
          target.body =
            target.body.slice(0, selection.start) +
            "{{@value:" +
            bodyId +
            "}}" +
            target.body.slice(selection.end);
      } else row.dynamic = spec;
      mark();
      render();
    },
  );
  if (group === "body") $("#dynamic-format").value = initial.format || "json";
  $("#dynamic-mock-type").value = initial.type || "string";
  $("#dynamic-seed").value = initial.seed ?? "";
  $("#dynamic-source").value = initial.source;
  $("#dynamic-value").value =
    initial.source === "fixed" ? JSON.stringify(initial.value) : initial.value;
  $("#dynamic-functions").value = (initial.functions || []).join(", ");
  $("#dynamic-preview").onclick = async () => {
    const output = $("#dynamic-result");
    try {
      const result = await api(
        "/projects/" + project.id + "/dynamic-preview",
        "POST",
        {
          spec: read(),
          functions: project.settings?.functions || [],
        },
      );
      output.textContent = JSON.stringify(result.value, null, 2);
    } catch (error) {
      output.textContent = error.message;
    }
  };
  $("#dynamic-remove").onclick = () => {
    if (group === "body") {
      delete target.bodyDynamic?.[bodyId];
      target.body = target.body.split("{{@value:" + bodyId + "}}").join("");
    } else delete row.dynamic;
    mark();
    $("#dialog").close();
    render();
  };
}

async function openCookieManager() {
  collect();
  const environmentId = env(),
    endpoint = "/projects/" + project.id + "/cookies";
  const dialog = $("#dialog"),
    marker = {};
  dialog.cookieManagerRequest = marker;
  const active = () =>
    dialog.open &&
    dialog.cookieManagerRequest === marker &&
    $("#dialog-title").textContent === "Cookie管理器";
  modal(
    "Cookie管理器",
    '<p role="status">正在读取Cookie…</p>',
    () => {},
    "完成",
  );
  let state;
  try {
    state = await api(
      endpoint + "?environmentId=" + encodeURIComponent(environmentId),
    );
  } catch (error) {
    if (active())
      $("#dialog-content").textContent = "读取Cookie失败：" + error.message;
    return;
  }
  if (!active()) return;
  const view = () =>
    `<p class="notice">Cookie明文仅存当前电脑，按项目与环境隔离，Cookie库不进入项目备份，但请求/响应历史可能含Cookie，分享前请检查。开启后自动保存/发送匹配Cookie，并覆盖请求里手工填写的Cookie。此处操作立即生效，关闭窗口不撤销。</p><p id="cookie-error" class="failed" role="alert"></p><button id="cookie-toggle">${state.enabled ? "关闭自动Cookie" : "开启自动Cookie"}</button><button id="cookie-refresh">重新加载</button><button id="cookie-clear">清空当前环境Cookie</button><p>状态：${state.enabled ? "已开启" : "已关闭"} · ${state.cookies.length}/500</p><div class="cookie-table"><table><thead><tr><th>名称</th><th>值</th><th>域 / 路径</th><th>属性</th><th></th></tr></thead><tbody>${state.cookies.map((c, i) => `<tr><td>${esc(c.key)}</td><td><input type="password" readonly value="${esc(c.value)}" aria-label="Cookie值"></td><td>${esc(c.domain)}<br>${esc(c.path)}</td><td>${c.secure ? "Secure " : ""}${c.httpOnly ? "HttpOnly " : ""}${c.hostOnly ? "HostOnly" : ""}</td><td><button data-cookie-edit="${i}">编辑</button><button data-cookie-remove="${i}">删除</button></td></tr>`).join("")}</tbody></table></div><label>来源URL（HTTP/HTTPS）</label><input id="cookie-url" placeholder="https://api.example.test/"><label>Set-Cookie（同域、同路径、同名会覆盖；更改身份会新增）</label><textarea id="cookie-line" placeholder="name=value; Path=/; Secure"></textarea><button id="cookie-set">保存Cookie</button>`;
  const attempt = (fn) => async () => {
    try {
      await fn();
    } catch (error) {
      if (!active()) return;
      $("#cookie-error").textContent = error.message;
      $("#dialog-content").scrollTop = 0;
    }
  };
  const change = async (data) => {
    state = await api(endpoint, "POST", {
      environmentId,
      expectedRevision: state.revision,
      ...data,
    });
    draw();
  };
  const draw = () => {
    if (!active()) return;
    $("#dialog-content").innerHTML = view();
    $("#dialog-content").scrollTop = 0;
    for (const button of $("#dialog-content").querySelectorAll("button"))
      button.type = "button";
    $("#cookie-toggle").onclick = attempt(() =>
      change({ operation: "configure", enabled: !state.enabled }),
    );
    $("#cookie-refresh").onclick = attempt(async () => {
      state = await api(
        endpoint + "?environmentId=" + encodeURIComponent(environmentId),
      );
      draw();
    });
    $("#cookie-clear").onclick = attempt(async () => {
      if (confirm("清空当前环境的全部Cookie？"))
        await change({ operation: "clear" });
    });
    $("#cookie-set").onclick = attempt(() =>
      change({
        operation: "set",
        url: $("#cookie-url").value,
        cookie: $("#cookie-line").value,
      }),
    );
    for (const button of $("#dialog-content").querySelectorAll(
      "[data-cookie-remove]",
    ))
      button.onclick = attempt(async () => {
        const c = state.cookies[Number(button.dataset.cookieRemove)];
        if (confirm("删除此Cookie？"))
          await change({
            operation: "remove",
            domain: c.domain,
            path: c.path,
            key: c.key,
          });
      });
    for (const button of $("#dialog-content").querySelectorAll(
      "[data-cookie-edit]",
    ))
      button.onclick = () => {
        const c = state.cookies[Number(button.dataset.cookieEdit)];
        $("#cookie-url").value =
          "https://" +
          (c.domain.includes(":") ? "[" + c.domain + "]" : c.domain) +
          c.path;
        $("#cookie-line").value =
          c.key +
          "=" +
          c.value +
          "; Path=" +
          c.path +
          (c.hostOnly ? "" : "; Domain=" + c.domain) +
          (c.secure ? "; Secure" : "") +
          (c.httpOnly ? "; HttpOnly" : "") +
          (c.sameSite ? "; SameSite=" + c.sameSite : "") +
          (c.expires && c.expires !== "Infinity"
            ? "; Expires=" + new Date(c.expires).toUTCString()
            : "") +
          (c.maxAge !== undefined ? "; Max-Age=" + c.maxAge : "");
      };
  };
  draw();
}

function insertVariable(name) {
  const editor = $("#body-code");
  if (!editor) return;
  const start = editor.selectionStart,
    end = editor.selectionEnd;
  request().body =
    editor.value.slice(0, start) + "{{" + name + "}}" + editor.value.slice(end);
  mark();
  render();
}
