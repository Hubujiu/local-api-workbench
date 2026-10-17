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
  planId = "",
  lastRun = null,
  loadResult = null,
  activeSession = null,
  sessionTimer = null;
const methodOptions = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];
const env = () =>
  $("#env")?.value ||
  sessionStorage.getItem("env") ||
  project?.environments[0]?.id;
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
  if ($("#body-type")) r.bodyType = $("#body-type").value;
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
  sessionStorage.setItem("project", id);
  render();
}
function modal(title, html, onSave, label = "确定") {
  const d = $("#dialog");
  $("#dialog-title").textContent = title;
  $("#dialog-content").innerHTML = html;
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
    ["plans", "☷", "执行计划"],
    ["settings", "⚙", "配置"],
    ["protocols", "⇄", "实时协议"],
    ["database", "▥", "数据库"],
    ["git", "⑂", "Git"],
  ]
    .map(
      ([key, icon, title]) =>
        `<button data-page="${key}" class="${page === key ? "active" : ""}" title="${title}"><span class="icon">${lineIcon(icon)}</span>${title}</button>`,
    )
    .join("");
}
function tree() {
  const requests =
    project?.requests.filter(
      (r) =>
        !r.deletedAt &&
        (r.name + " " + r.url + " " + r.folder)
          .toLowerCase()
          .includes(search.toLowerCase()),
    ) || [];
  const folders = [
    ...new Set([
      ...(project?.folders || []),
      ...requests.map((r) => r.folder || "未分组"),
    ]),
  ];
  return (
    folders
      .map(
        (folder) =>
          `<div class="folder"><button class="ghost folder-edit" data-edit-folder="${esc(folder)}">⌄ &nbsp;▱ ${esc(folder)}</button> <span>(${requests.filter((r) => (r.folder || "未分组") === folder).length})</span></div>${requests
            .filter((r) => (r.folder || "未分组") === folder)
            .map(
              (r) =>
                `<button class="tree-item ${r.id === current ? "active" : ""}" data-request="${r.id}"><span class="method ${r.method}">${r.method === "DELETE" ? "DEL" : r.method}</span><span>${esc(r.name)}</span></button>`,
            )
            .join("")}`,
      )
      .join("") ||
    '<div class="notice">暂无接口。新建接口，或导入已有定义。</div>'
  );
}
function render() {
  const r = request();
  $("#app").innerHTML =
    `<header class="top"><div class="top-group"><div class="brand"><span class="logo">↗</span>Local API <span class="subtle">单机版</span></div><button id="new-project" ${busy || saving ? "disabled" : ""} class="ghost">＋ 新建/导入项目</button></div><div class="top-group"><select id="project-select" ${busy || saving ? "disabled" : ""} aria-label="项目">${projects
      .filter((p) => !p.archived && !p.error)
      .map(
        (p) =>
          `<option value="${p.id}" ${p.id === project?.id ? "selected" : ""}>${esc(p.name)}</option>`,
      )
      .join(
        "",
      )}</select><button id="save-project" ${saving ? "disabled" : ""} class="${dirty ? "primary" : "ghost"}">保存项目</button><button id="open-location" class="ghost">打开位置</button><span class="offline">● 纯本地 · 无云端同步</span><button id="theme" class="ghost" aria-label="切换主题">◐</button></div></header><div class="shell"><nav class="rail">${nav()}<button data-page="trash" class="bottom ${page === "trash" ? "active" : ""}"><span class="icon">${lineIcon("♲")}</span>回收站</button></nav><aside class="sidebar"><div class="search"><input id="search" placeholder="⌕ 关键字 / URL" aria-label="搜索接口" value="${esc(search)}"><button id="add-request" class="primary" aria-label="新建接口">＋</button></div><div class="section-label">▧ 全部接口 <button id="import" class="ghost" title="导入">⇥</button></div><div id="tree">${tree()}</div><button class="new-item" id="new-request">＋ 新建</button><button class="new-item" id="new-folder">＋ 新建目录</button><button class="new-item" id="export">⇧ 导出项目</button></aside><main class="workspace">${
      page === "apis"
        ? `<div class="tabs">${opened
            .filter((id) =>
              project.requests.some((r) => r.id === id && !r.deletedAt),
            )
            .map((id) => {
              const item = project.requests.find((r) => r.id === id);
              return `<div class="tab ${current === id ? "selected" : ""}"><button class="ghost tab-switch" data-open-tab="${id}"><span class="method ${item.method}">${item.method}</span> ${esc(item.name)}</button><button class="ghost tab-close" data-close-tab="${id}" aria-label="关闭 ${esc(item.name)}">×</button></div>`;
            })
            .join(
              "",
            )}<button id="tab-add" class="ghost">＋</button><div class="tools"><select id="env" aria-label="执行环境">${project?.environments.map((e) => `<option value="${e.id}" ${e.id === env() ? "selected" : ""}>${esc(e.name)}</option>`).join("") || ""}</select><button data-page="settings" class="ghost" title="环境设置">☷</button></div></div>${r ? editor(r) : '<div class="empty"><span class="empty-symbol">↗</span><p>从一个请求开始</p><small>创建或导入接口，所有数据只留在本机。</small><button id="welcome-add" class="primary">＋ 新建接口</button></div>'}`
        : renderPage()
    }</main></div><footer class="statusbar"><span>◈ 本地工作空间 &nbsp; / &nbsp; ${esc(project?.name || "")} &nbsp; <span id="saved-state">${dirty ? "● 未保存" : "✓ 已保存"}</span></span><span>Local API 0.1.0 &nbsp; · &nbsp; 无订阅 / 无遥测</span></footer>`;
  bind();
}
function editor(r) {
  return `<section class="editor"><div class="subnav">${[
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
    )}<input id="request-name" class="request-name" aria-label="接口名称" value="${esc(r.name)}"><button id="duplicate" title="复制接口">⧉</button><button id="delete" title="删除接口" class="danger">×</button></div><div class="urlbar"><div class="url-input"><select id="method" aria-label="请求方法">${methodOptions.map((m) => `<option ${r.method === m ? "selected" : ""}>${m}</option>`).join("")}</select><input id="url" aria-label="请求 URL" placeholder="输入请求地址，支持 {{变量}}" value="${esc(r.url)}"></div><button id="send" class="primary" ${busy ? "disabled" : ""}>${busy ? "请求中…" : "发 送"}</button>${busy ? '<button id="cancel">取消</button>' : ""}<button id="save" class="${dirty ? "primary" : ""}">保存</button><button id="curl" title="生成 cURL">⌘</button></div>${
    mode === "debug"
      ? `<div class="param-tabs">${[
          ["headers", "Header"],
          ["query", "Query"],
          ["path", "Path"],
          ["body", "Body"],
          ["auth", "认证"],
          ["cookies", "Cookie"],
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
          )}</div><div class="request-panel">${paramPanel(r)}</div><div class="response"><div class="response-top"><div class="response-tabs">${[
          ["body", "实时响应"],
          ["headers", "响应头"],
          ["cookies", "Cookie"],
          ["request", "实际请求"],
          ["assertions", "断言结果"],
          ["extracted", "提取变量"],
          ["logs", "控制台"],
        ]
          .map(
            ([key, label]) =>
              `<button data-response="${key}" class="${responseTab === key ? "active" : ""}">${label}</button>`,
          )
          .join(
            "",
          )}</div><div class="metrics">${response ? `<span class="${response.status < 400 ? "success" : "failed"}">${response.status || "ERROR"}</span><span>${response.duration ?? 0} ms</span><span>${response.size ?? 0} B</span>` : ""}</div></div><div class="response-body">${responseContent()}</div></div>`
      : modePanel(r)
  }</section>`;
}
function pairs(rows, key) {
  return `<table><thead><tr><th width="30"></th><th>参数名</th><th>参数值</th><th width="35"></th></tr></thead><tbody>${rows.map((p, i) => `<tr><td><input type="checkbox" data-pair-enabled="${key}:${i}" ${p.enabled !== false ? "checked" : ""} aria-label="启用参数"></td><td><input data-pair="${key}:${i}:key" placeholder="参数名" value="${esc(p.key)}"></td><td>${key === "form" ? `<select data-field-type="${i}"><option value="text" ${p.type !== "file" ? "selected" : ""}>文本</option><option value="file" ${p.type === "file" ? "selected" : ""}>文件</option></select>` : ""}${p.type === "file" ? `<input type="file" data-field-file="${i}"><small>${esc(p.filename || "未选择文件")}</small>` : `<input data-pair="${key}:${i}:value" placeholder="参数值 / {{变量}}" value="${esc(p.value)}">`}</td><td><button data-remove-pair="${key}:${i}" aria-label="删除参数">×</button></td></tr>`).join("")}</tbody></table><div class="pair-actions"><button data-add-pair="${key}">＋ 添加参数</button></div>`;
}
function paramPanel(r) {
  if (["headers", "query", "path", "cookies"].includes(param))
    return pairs(r[param], param);
  if (param === "body")
    return `<div class="body-types"><select id="body-type" aria-label="请求体类型">${["none", "json", "raw", "urlencoded", "form-data", "msgpack", "binary"].map((t) => `<option ${r.bodyType === t ? "selected" : ""}>${t}</option>`).join("")}</select><span>${r.bodyType === "binary" ? "输入 Base64 编码的二进制数据" : "请求体 · 保存在本地"}</span><button id="format-json" class="ghost">格式化 JSON</button><button id="generate-body" class="ghost">基于数据结构生成</button></div>${
      ["form-data", "urlencoded"].includes(r.bodyType)
        ? pairs(r.form, "form")
        : r.bodyType === "none"
          ? '<div class="empty"><p>此请求没有 Body</p></div>'
          : `<div class="code-editor"><pre id="code-gutter" aria-hidden="true">${r.body
              .split("\n")
              .map((_, i) => i + 1)
              .join(
                "\n",
              )}</pre><pre id="code-highlight" aria-hidden="true">${highlightJSON(r.body)}\n</pre><textarea id="body-code" class="code" wrap="off" spellcheck="false" aria-label="请求体">${esc(r.body)}</textarea></div>`
    }`;
  if (param === "auth" && r.auth.type === "oauth2")
    return `<div class="form-grid"><label>认证类型</label><select id="auth-type">${["none", "bearer", "basic", "digest", "oauth2", "apiKey"].map((type) => `<option ${type === "oauth2" ? "selected" : ""}>${type}</option>`).join("")}</select><label>授权方式</label><select data-auth="grantType">${["client_credentials", "authorization_code", "refresh_token"].map((type) => `<option ${r.auth.grantType === type ? "selected" : ""}>${type}</option>`).join("")}</select>${["authorizationEndpoint", "tokenEndpoint", "clientId", "clientSecret", "clientAuthentication", "scope", "refreshToken", "token"].map((key) => `<label>${key}</label><input data-auth="${key}" value="${esc(r.auth[key])}" type="${["clientSecret", "refreshToken", "token"].includes(key) ? "password" : "text"}" placeholder="${key === "clientAuthentication" ? "body 或 basic" : ""}">`).join("")}</div><p><button id="oauth-get" class="primary">获取令牌</button></p><div class="notice">授权码模式启用 PKCE S256。凭据只发到你配置的 endpoint；请优先使用 HTTPS。令牌获取后仅在当前编辑状态中，点击保存才写入本地项目。</div>`;
  if (param === "auth")
    return `<div class="form-grid"><label>认证类型</label><select id="auth-type">${["none", "bearer", "basic", "digest", "oauth2", "apiKey"].map((t) => `<option ${r.auth.type === t ? "selected" : ""}>${t}</option>`).join("")}</select>${(r.auth.type === "bearer" ? ["token"] : r.auth.type === "basic" || r.auth.type === "digest" ? ["username", "password"] : r.auth.type === "apiKey" ? ["key", "value", "in"] : []).map((k) => `<label>${k}</label><input data-auth="${k}" value="${esc(r.auth[k])}" placeholder="${k === "in" ? "header 或 query" : "支持 {{变量}}"}" type="${k === "password" || k === "token" ? "password" : "text"}">`).join("")}</div>`;
  if (param === "assertions")
    return `<table><thead><tr><th>目标</th><th>操作</th><th>预期值（JSON 或文本）</th><th></th></tr></thead><tbody>${r.assertions.map((a, i) => `<tr><td><input data-rule="${i}:target" value="${esc(a.target)}" placeholder="status / $.data.id / duration"></td><td><select data-rule="${i}:op">${["eq", "neq", "contains", "exists", "lt", "gt"].map((op) => `<option ${a.op === op ? "selected" : ""}>${op}</option>`).join("")}</select></td><td><input data-rule="${i}:value" value="${esc(JSON.stringify(a.value))}"></td><td><button data-remove-rule="${i}">×</button></td></tr>`).join("")}</tbody></table><p><button id="add-assertion">＋ 添加断言</button> <button id="edit-operations">JSON 高级编辑</button></p><div class="notice">status 为状态码，duration 为毫秒，body 为原文；JSON 路径如 $.data.id；响应头使用 header:content-type。</div>`;
  if (param === "extract")
    return `<table><thead><tr><th>变量名</th><th>响应 JSON 路径</th><th></th></tr></thead><tbody>${r.extract.map((a, i) => `<tr><td><input data-extract="${i}:name" value="${esc(a.name)}"></td><td><input data-extract="${i}:path" value="${esc(a.path)}" placeholder="$.data.token"></td><td><button data-remove-extract="${i}">×</button></td></tr>`).join("")}</tbody></table><p><button id="add-extract">＋ 提取变量</button></p><div class="notice">在计划内传递给后续步骤；单次调试返回提取结果，不自动覆盖持久化环境。</div>`;
  if (param === "before" || param === "after")
    return `<div class="notice">JavaScript 在独立 QuickJS 沙箱中执行，无文件/网络/Node 访问。支持 apt.setVar/getVar、pm.environment、pm.response、pm.test 和 console.log；250ms CPU 截止、16MiB VM 内存限制。</div><textarea id="script-code" class="full-code" spellcheck="false" placeholder="${param === "before" ? "apt.setVar('requestId', 'demo');" : "pm.test('status', () => pm.expect(pm.response.code).to.equal(200));"}">${esc(r[param + "Script"] || "")}</textarea><p><button id="edit-operations">声明式操作（高级）</button></p><pre>${esc(JSON.stringify(r[param], null, 2))}</pre>`;
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
  if (!response)
    return '<div class="empty"><div class="empty-symbol">♧</div><p>输入 URL 后点击发送获取响应结果</p><small>Ctrl + Enter 发送请求 · Ctrl + S 保存接口</small></div>';
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
    return `<div class="page"><div class="form-grid"><label>接口描述</label><textarea id="description">${esc(r.description)}</textarea><label>所属目录</label><input id="folder" value="${esc(r.folder)}"><label>超时（ms）</label><input id="timeout" type="number" min="100" max="60000" value="${r.timeout}"><label>HTTP/HTTPS 代理</label><input id="request-proxy" value="${esc(r.proxy)}" placeholder="http://127.0.0.1:8080"><label>自定义 CA（PEM）</label><textarea data-tls="ca">${esc(r.tls?.ca || "")}</textarea><label>客户端证书（PEM）</label><textarea data-tls="cert">${esc(r.tls?.cert || "")}</textarea><label>客户端私钥（PEM）</label><textarea data-tls="key">${esc(r.tls?.key || "")}</textarea><label>私钥口令</label><input data-tls="passphrase" type="password" value="${esc(r.tls?.passphrase || "")}"><label>请求 JSON Schema</label><textarea id="schema">${esc(JSON.stringify(r.schema, null, 2))}</textarea></div><div class="notice">TLS 校验始终开启，可粘贴自定义 CA。保存接口会将证书/私钥写入本地项目；导出前务必删除敏感凭据。执行计划保存独立快照。</div></div>`;
  if (mode === "mock")
    return `<div class="page"><h2>本地 Mock 与响应示例</h2><p class="muted">Mock 地址只在本机应用运行时可用。</p><input class="mock-url" readonly value="${location.origin}/mock/${project.id}/${r.id}"><div class="toolbar"><button id="add-example">＋ 新增示例</button><button id="use-mock">用 Mock 地址调试</button></div>${r.examples.map((e, i) => `<div class="card"><div class="row"><strong class="grow">${esc(e.name)} · ${e.status}</strong><button data-edit-example="${i}">编辑</button></div><pre>${esc(e.body)}</pre></div>`).join("")}</div>`;
  if (mode === "cases")
    return `<div class="page"><h2>接口用例</h2><p class="muted">将当前接口保存为独立快照；每个场景可覆盖参数、断言和变量提取。</p><button id="create-case" class="primary">＋ 从当前接口创建执行计划</button><div class="notice">在「执行计划」中添加同一接口的多个步骤，验证正常与异常输入。预期 4xx 可以用状态码断言明确验证，不误判为请求异常。</div></div>`;
  return `<div class="page"><h2>一键压测</h2><p class="muted">仅对你有权测试的接口使用。上限 100 次、并发 10，支持取消。</p><div class="row"><label>请求数 <input id="load-count" type="number" value="10" min="1" max="100"></label><label>并发 <input id="load-concurrency" type="number" value="1" min="1" max="10"></label><button id="load-run" class="primary" ${busy ? "disabled" : ""}>开始压测</button>${busy ? '<button id="cancel">停止</button>' : ""}</div>${
    loadResult
      ? `<div class="grid-stats">${[
          ["完成", loadResult.count],
          ["通过", loadResult.passed],
          ["P50", loadResult.p50 + " ms"],
          ["P95", loadResult.p95 + " ms"],
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
  if (page === "settings")
    return `<div class="page"><div class="page-head"><div><h1>项目配置</h1><span class="muted">环境、变量与本地存储</span></div><div class="toolbar"><button id="archive-project" class="danger">归档项目</button><button id="save" class="primary">保存配置</button></div></div><div class="card"><div class="form-grid"><label>项目名称</label><input id="project-name" value="${esc(project.name)}"></div></div><div class="page-head"><h2>环境管理</h2><button id="clear-session">清空调试临时变量</button><button id="add-env">＋ 新建环境</button></div>${project.environments.map((e) => `<div class="card"><div class="row"><strong class="grow">${esc(e.name)}</strong><button data-edit-env="${e.id}">编辑变量</button><button data-delete-env="${e.id}" class="danger">删除</button></div><pre>${esc(JSON.stringify(e.variables, null, 2))}</pre></div>`).join("")}<div class="notice">数据保存在启动目录的 .local-api 文件夹。变量可能包含密钥；导出或 Git 提交前请移除秘密。默认不上传任何内容。</div><div class="card"><h3>MCP 接入</h3><button id="mcp-config" class="primary">配置本地 HTTP MCP 服务</button><p class="muted">默认关闭。项目与读写/执行权限需分别授权；本次启动有效，重启后自动关闭。</p><p>使用 stdio 模式启动，默认只读；必须显式授权项目。</p><pre>node src/mcp.mjs --project ${esc(project.id)}</pre><p class="muted">需要写入时加入 --write，需要执行请求时额外加入 --execute。不会自动更改你的 Agent 配置。</p></div></div>`;
  if (page === "plans") {
    const plan = project.plans.find((p) => p.id === planId);
    return `<div class="page"><div class="page-head"><div><h1>AI 执行计划</h1><span class="muted">固定步骤 · 独立快照 · 完整证据 · 可重复运行</span></div><button id="new-plan" class="primary">＋ 新建计划</button></div><div class="toolbar">${project.plans.map((p) => `<button data-plan="${p.id}" class="${planId === p.id ? "primary" : ""}">${esc(p.name)}</button>`).join("") || '<p class="muted">尚无计划。先创建接口，再组合成可重复的业务流程。</p>'}</div>${plan ? `<div class="card"><div class="row"><h3 class="grow">${esc(plan.name)}</h3><button id="edit-plan">编辑 JSON</button><button id="add-step">＋ 添加步骤</button><button id="run-plan" class="primary" ${busy ? "disabled" : ""}>${busy ? "执行中…" : "执行计划"}</button>${busy ? '<button id="cancel">停止</button>' : ""}</div><div class="row"><label>执行环境</label><select id="plan-env">${project.environments.map((e) => `<option value="${e.id}" ${e.id === plan.environmentId ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select></div>${plan.steps.map((s, i) => `<div class="plan-step"><span class="step-number">${i + 1}</span><input type="checkbox" data-step-enable="${i}" ${s.enabled ? "checked" : ""} aria-label="启用步骤"><span class="method ${s.request.method}">${s.request.method}</span><div class="grow"><strong>${esc(s.name)}</strong><div class="subtle">${esc(s.request.url)}</div></div><button data-step-up="${i}" ${i === 0 ? "disabled" : ""}>↑</button><button data-step-edit="${i}">编辑</button><button data-step-delete="${i}" class="danger">×</button></div>`).join("") || '<div class="notice">添加步骤后执行。每一步保存接口的独立快照。</div>'}</div>` : ""}<h2>执行记录 <span class="subtle">最近 50 条</span></h2>${(lastRun ? [lastRun, ...project.runs.filter((r) => r.id !== lastRun.id)] : project.runs).map((r) => `<details class="card" ${r.id === lastRun?.id ? "open" : ""}><summary><span class="${r.status === "passed" ? "success" : "failed"}">${r.status === "passed" ? "✓ 通过" : r.status === "cancelled" ? "■ 已取消" : "× 失败"}</span> &nbsp; ${esc(r.planName)} &nbsp; <span class="subtle">${esc(r.createdAt)} · ${r.results.length} 步</span></summary><p class="subtle">快照 SHA256: ${esc(r.planHash)}</p>${r.results.map((s, i) => `<details class="card"><summary>${i + 1}. <span class="${s.status === "passed" ? "success" : "failed"}">${s.status}</span> ${esc(s.name)} · ${s.response?.status || ""} ${s.response?.duration || 0}ms</summary><pre>${esc(JSON.stringify(s, null, 2))}</pre></details>`).join("")}<button data-export-run="${r.id}">导出证据 JSON</button></details>`).join("") || '<div class="empty"><span class="empty-symbol">☷</span><p>计划运行后，逐步结果将显示在这里</p></div>'}</div>`;
  }
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
    return `<div class="page"><div class="page-head"><div><h1>数据字典</h1><span class="muted">统一管理可复用的字段定义与枚举</span></div><button id="add-dictionary" class="primary">＋ 新建数据模型</button></div>${project.dictionary.map((d, i) => `<div class="card"><div class="row"><strong class="grow">${esc(d.name)}</strong><button data-edit-dictionary="${i}">编辑</button><button data-use-dictionary="${i}">应用到当前接口</button></div><pre>${esc(JSON.stringify(d.schema, null, 2))}</pre></div>`).join("") || '<div class="empty"><p>暂无数据模型</p></div>'}</div>`;
  if (page === "protocols")
    return `<div class="page"><h1>实时协议调试</h1><p class="muted">支持短时采集与交互会话。交互会话最长 15 分钟、8 MiB，保留最近 200 条消息。</p><div class="form-grid"><label>协议</label><select id="protocol-type"><option value="sse">SSE</option><option value="websocket">WebSocket</option><option value="tcp">TCP</option></select><label>URL / TCP Host</label><input id="protocol-url" placeholder="http://localhost:8080/events"><label>TCP 端口</label><input id="protocol-port" type="number" value="8080"><label>采集时长 ms</label><input id="protocol-duration" type="number" value="3000" min="100" max="30000"><label>发送消息</label><textarea id="protocol-message"></textarea></div><p><button id="protocol-run" class="primary" ${busy ? "disabled" : ""}>连接并采集</button> <button id="cancel">断开</button></p><pre id="protocol-result"></pre><div class="card"><div class="toolbar"><button id="session-connect" class="primary">建立交互会话</button><button id="session-send">发送消息</button><button id="session-stop">断开会话</button><button id="session-export">导出消息</button><span id="session-status">${esc(activeSession?.state || "未连接")}</span></div><pre id="session-events">${esc(activeSession?.events?.map((event) => `${event.at} ${event.direction} ${event.data}`).join("\n") || "")}</pre></div></div>`;
  if (page === "database")
    return `<div class="page"><h1>数据库连接</h1><p class="muted">SQLite / PostgreSQL / MySQL · 只读事务 · 最多返回 1000 行</p><div class="form-grid"><label>类型</label><select id="db-type"><option value="sqlite">SQLite</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option></select><label>主机</label><input id="db-host" value="127.0.0.1"><label>端口</label><input id="db-port" placeholder="5432 / 3306"><label>用户名</label><input id="db-user" autocomplete="off"><label>密码</label><input id="db-password" type="password" autocomplete="off"><label>数据库名</label><input id="db-name"><label>TLS</label><input id="db-tls" type="checkbox"><label>SQLite 文件路径</label><input id="db-path" placeholder="C:\\data\\app.db 或 /data/app.db"><label>SQL</label><textarea id="db-sql">SELECT name FROM sqlite_master WHERE type = 'table'</textarea><label>绑定参数 JSON</label><input id="db-params" value="[]"></div><p><button id="db-query" class="primary">执行只读查询</button></p><pre id="db-result"></pre><div class="notice">连接凭据仅本次使用，不自动保存。仅连接你有权访问的数据库；只读事务不能保证数据库自定义函数无外部副作用。</div></div>`;
  if (page === "git")
    return `<div class="page"><h1>Git 协同</h1><p><button id="git-terminal" class="primary">在项目位置打开终端</button></p><p class="muted">本地项目是格式化 JSON 文件，可以纳入你自己的 Git 仓库。</p><div class="card"><h3>推荐流程</h3><ol class="markdown"><li>导出项目，检查并移除环境密钥与历史中的敏感信息。</li><li>把接口定义文件放入项目仓库。</li><li>通过 Git diff 审查变更，通过 PR 协作。</li><li>其他成员导入同一文件，继续本地编辑。</li></ol><button id="export">导出项目文件</button></div><div class="notice">打开终端后由你执行 Git 命令；本应用不会自动提交凭据或推送代码。执行记录与历史可能含敏感数据，请勿公开提交。</div></div>`;
  return `<div class="page"><div class="page-head"><div><h1>接口文档</h1><span class="muted">从当前项目定义生成，离线阅读与导出</span></div><div class="toolbar"><button id="new-document">＋ 新建文档</button><button id="export-docs" class="primary">导出文档</button></div></div>${
    project.documents
      .map(
        (document, index) =>
          `<article class="card markdown"><div class="row"><h3 class="grow">${esc(document.title)}</h3><button data-edit-document="${index}">编辑</button><button data-delete-document="${index}" class="danger">删除</button></div><pre>${esc(document.content)}</pre></article>`,
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
  const projectId = project.id;
  const result = await api("/projects/" + projectId + "/plans", "POST", {
    ...plan,
    projectConfigRevision: project.configRevision ?? project.revision,
  });
  if (project.id !== projectId) return;
  const { projectRevision, projectConfigRevision, ...saved } = result;
  const index = project.plans.findIndex((item) => item.id === saved.id);
  if (index < 0) project.plans.push(saved);
  else project.plans[index] = saved;
  planId = saved.id;
  project.revision = projectRevision;
  project.configRevision = projectConfigRevision;
  render();
}

function editRules() {
  const r = request();
  const sample = {
    assertions: [{ target: "status", op: "eq", value: 200 }],
    extract: [{ name: "token", path: "$.token" }],
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
function bind() {
  on("[data-page]", "click", (_, e) => {
    collect();
    page = e.dataset.page;
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
      `<label><input id="mcp-enabled" type="checkbox" ${config.enabled ? "checked" : ""}> 开启本次运行的 MCP 服务</label><label><input id="mcp-write" type="checkbox" ${config.write ? "checked" : ""}> 允许写入项目</label><label><input id="mcp-execute" type="checkbox" ${config.execute ? "checked" : ""}> 允许执行已有计划（会向计划 URL 发送请求）</label><h4>授权项目</h4>${projects.map((p) => `<label><input data-mcp-project="${p.id}" type="checkbox" ${config.projects.includes(p.id) ? "checked" : ""}> ${esc(p.name)}</label>`).join("")}<div class="notice">凭据只用于本机 MCP 接入。不要分享给不信任的 Agent。关闭服务会立即撤销当前令牌。</div>`,
      async () => {
        const result = await api("/mcp/config", "POST", {
          enabled: $("#mcp-enabled").checked,
          write: $("#mcp-write").checked,
          execute: $("#mcp-execute").checked,
          projects: [
            ...document.querySelectorAll("[data-mcp-project]:checked"),
          ].map((e) => e.dataset.mcpProject),
        });
        if (result.enabled) {
          const configuration = {
            mcpServers: {
              localapi: {
                type: "http",
                url: result.endpoint,
                headers: { Authorization: "Bearer " + result.token },
              },
            },
          };
          setTimeout(
            () =>
              modal(
                "MCP 连接配置",
                `<pre>${esc(JSON.stringify(configuration, null, 2))}</pre><p>把此配置添加到你选择的 MCP 客户端。不会自动配置或联系任何 Agent。</p>`,
                () =>
                  navigator.clipboard.writeText(
                    JSON.stringify(configuration, null, 2),
                  ),
                "复制配置",
              ),
            0,
          );
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
  on("#env", "change", (_, e) => sessionStorage.setItem("env", e.value));
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
  on("#request-name,#url,#body-code,#description", "input", () => {
    collect();
    mark();
  });
  on("#method", "change", () => {
    collect();
    mark();
    render();
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
  on("#body-type", "change", (_, e) => {
    collect();
    request().bodyType = e.value;
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
      `<p class="muted">按当前环境生成，不执行前后置脚本。可能包含认证凭据，请勿公开分享。</p><textarea id="curl-output" readonly>${esc(r.curl)}</textarea>`,
      () => navigator.clipboard.writeText(r.curl),
      "复制",
    );
  });
  on("#import", "click", () =>
    modal(
      "导入接口",
      `<p class="muted">支持项目 JSON、OpenAPI JSON/YAML、Postman Collection 与 cURL。仅解析，不执行导入内容。</p><label>导入方式</label><select id="import-mode"><option value="interfaces">导入接口到当前项目</option><option value="restore">完整恢复项目备份为新副本</option></select><input id="import-file" type="file" accept=".json,.yaml,.yml,.txt"><textarea id="import-text" placeholder="粘贴 JSON 或 cURL"></textarea>`,
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
          render();
        }
        toast("导入完成");
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
  on("#clear-session", "click", async () => {
    await api("/projects/" + project.id + "/clear-session", "POST", {});
    toast("临时变量已清空，后续调试使用已保存的环境值");
  });
  on("#project-name", "input", (_, e) => {
    project.name = e.value;
    mark();
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
    modal("编辑 " + v.name, jsonEditor(v.variables), () => {
      v.variables = JSON.parse($("#modal-json").value);
      mark();
      render();
    });
  });
  on("[data-delete-env]", "click", (_, e) => {
    if (project.environments.length === 1) throw Error("至少保留一个环境");
    project.environments = project.environments.filter(
      (v) => v.id !== e.dataset.deleteEnv,
    );
    mark();
    render();
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
  on("#load-run", "click", async () => {
    collect();
    if (!confirm("确认你有权对该地址执行压测？")) return;
    const count = Number($("#load-count").value),
      concurrency = Number($("#load-concurrency").value);
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
      '<label>计划名称</label><input id="plan-name" value="业务流程验证"><p class="muted">保存当前接口快照，后续接口变更不会影响计划。</p>',
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
  on("[data-plan]", "click", (_, e) => {
    planId = e.dataset.plan;
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
    modal("编辑步骤快照", jsonEditor(p.steps[i]), () => {
      p.steps[i] = JSON.parse($("#modal-json").value);
      return savePlan(p);
    });
  });
  on("#run-plan", "click", async () => {
    busy = true;
    runId = uid();
    render();
    try {
      lastRun = await api("/projects/" + project.id + "/run", "POST", {
        planId,
        runId,
      });
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
      '<label>格式</label><select id="document-format"><option value="html">独立 HTML（浏览器直接打开）</option><option value="markdown">Markdown</option></select><div class="notice">文档包含请求和响应示例，可能含敏感字段。请检查后再分享。</div>',
      () => {
        const format = $("#document-format").value;
        download(
          project.name + (format === "html" ? ".html" : ".md"),
          exportDocumentation(project, format),
          format === "html" ? "text/html" : "text/markdown",
        );
      },
      "导出",
    ),
  );
}
function bindTree() {
  on("[data-edit-folder]", "click", (_, element) => {
    const old = element.dataset.editFolder;
    modal(
      "编辑目录",
      `<label>目录名称</label><input id="folder-name" value="${esc(old)}"><label><input id="folder-remove" type="checkbox">删除目录并将接口移至未分组</label>`,
      () => {
        const remove = $("#folder-remove").checked,
          name = $("#folder-name").value.trim();
        if (!remove && !name) throw Error("名称不能为空");
        for (const item of project.requests)
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
      if (updated.revision === revision + 1)
        project.revision = updated.revision;
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

function editDocument(index) {
  const existing = project.documents[index] || {
    title: "新文档",
    content: "# 使用说明\n\n",
  };
  modal(
    "项目文档",
    `<label>标题</label><input id="document-title" value="${esc(existing.title)}"><label>Markdown 正文</label><textarea id="document-content">${esc(existing.content)}</textarea>`,
    () => {
      const document = {
        title: $("#document-title").value,
        content: $("#document-content").value,
      };
      if (index === undefined) project.documents.push(document);
      else project.documents[index] = document;
      mark();
      render();
    },
  );
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
