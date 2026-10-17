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
  busy = false,
  runId = "",
  search = "",
  planId = "",
  lastRun = null,
  loadResult = null;
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
  dirty = true;
  $("#save")?.classList.add("primary");
  const s = $("#saved-state");
  if (s) s.textContent = "● 未保存";
}
async function save() {
  if (!project) return;
  collect();
  project = await api("/projects/" + project.id, "PUT", project);
  dirty = false;
  render();
  toast("已保存到本地");
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
}
async function openProject(id) {
  if (dirty && !confirm("当前修改尚未保存，确定切换项目？")) return;
  project = await api("/projects/" + id);
  current = project.requests.find((r) => !r.deletedAt)?.id;
  opened = current ? [current] : [];
  dirty = false;
  response = null;
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
  const folders = [...new Set(requests.map((r) => r.folder || "未分组"))];
  return (
    folders
      .map(
        (folder) =>
          `<div class="folder">⌄ &nbsp;▱ ${esc(folder)} <span>(${requests.filter((r) => (r.folder || "未分组") === folder).length})</span></div>${requests
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
    `<header class="top"><div class="top-group"><div class="brand"><span class="logo">↗</span>Local API <span class="subtle">单机版</span></div><button id="new-project" class="ghost">＋ 新建/导入项目</button></div><div class="top-group"><select id="project-select" aria-label="项目">${projects.map((p) => `<option value="${p.id}" ${p.id === project?.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select><span class="offline">● 纯本地 · 无云端同步</span><button id="theme" class="ghost" aria-label="切换主题">◐</button></div></header><div class="shell"><nav class="rail">${nav()}<button data-page="trash" class="bottom ${page === "trash" ? "active" : ""}"><span class="icon">${lineIcon("♲")}</span>回收站</button></nav><aside class="sidebar"><div class="search"><input id="search" placeholder="⌕ 关键字 / URL" aria-label="搜索接口" value="${esc(search)}"><button id="add-request" class="primary" aria-label="新建接口">＋</button></div><div class="section-label">▧ 全部接口 <button id="import" class="ghost" title="导入">⇥</button></div><div id="tree">${tree()}</div><button class="new-item" id="new-request">＋ 新建</button><button class="new-item" id="export">⇧ 导出项目</button></aside><main class="workspace">${
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
              `<button data-param="${key}" class="${param === key ? "active" : ""}">${label}${r[key]?.length ? " (" + r[key].length + ")" : ""}</button>`,
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
    return `<div class="body-types"><select id="body-type" aria-label="请求体类型">${["none", "json", "raw", "urlencoded", "form-data", "binary"].map((t) => `<option ${r.bodyType === t ? "selected" : ""}>${t}</option>`).join("")}</select><span>${r.bodyType === "binary" ? "输入 Base64 编码的二进制数据" : "请求体 · 保存在本地"}</span><button id="format-json" class="ghost">格式化 JSON</button><button id="generate-body" class="ghost">基于数据结构生成</button></div>${["form-data", "urlencoded"].includes(r.bodyType) ? pairs(r.form, "form") : r.bodyType === "none" ? '<div class="empty"><p>此请求没有 Body</p></div>' : `<textarea id="body-code" class="code" spellcheck="false" aria-label="请求体">${esc(r.body)}</textarea>`}`;
  if (param === "auth")
    return `<div class="form-grid"><label>认证类型</label><select id="auth-type">${["none", "bearer", "basic", "apiKey"].map((t) => `<option ${r.auth.type === t ? "selected" : ""}>${t}</option>`).join("")}</select>${(r.auth.type === "bearer" ? ["token"] : r.auth.type === "basic" ? ["username", "password"] : r.auth.type === "apiKey" ? ["key", "value", "in"] : []).map((k) => `<label>${k}</label><input data-auth="${k}" value="${esc(r.auth[k])}" placeholder="${k === "in" ? "header 或 query" : "支持 {{变量}}"}" type="${k === "password" || k === "token" ? "password" : "text"}">`).join("")}</div>`;
  if (param === "assertions")
    return `<table><thead><tr><th>目标</th><th>操作</th><th>预期值（JSON 或文本）</th><th></th></tr></thead><tbody>${r.assertions.map((a, i) => `<tr><td><input data-rule="${i}:target" value="${esc(a.target)}" placeholder="status / $.data.id / duration"></td><td><select data-rule="${i}:op">${["eq", "neq", "contains", "exists", "lt", "gt"].map((op) => `<option ${a.op === op ? "selected" : ""}>${op}</option>`).join("")}</select></td><td><input data-rule="${i}:value" value="${esc(JSON.stringify(a.value))}"></td><td><button data-remove-rule="${i}">×</button></td></tr>`).join("")}</tbody></table><p><button id="add-assertion">＋ 添加断言</button> <button id="edit-operations">JSON 高级编辑</button></p><div class="notice">status 为状态码，duration 为毫秒，body 为原文；JSON 路径如 $.data.id；响应头使用 header:content-type。</div>`;
  if (param === "extract")
    return `<table><thead><tr><th>变量名</th><th>响应 JSON 路径</th><th></th></tr></thead><tbody>${r.extract.map((a, i) => `<tr><td><input data-extract="${i}:name" value="${esc(a.name)}"></td><td><input data-extract="${i}:path" value="${esc(a.path)}" placeholder="$.data.token"></td><td><button data-remove-extract="${i}">×</button></td></tr>`).join("")}</tbody></table><p><button id="add-extract">＋ 提取变量</button></p><div class="notice">在计划内传递给后续步骤；单次调试返回提取结果，不自动覆盖持久化环境。</div>`;
  if (param === "before" || param === "after") return `<div class="notice">JavaScript 在独立 QuickJS 沙箱中执行，无文件/网络/Node 访问。支持 apt.setVar/getVar、pm.environment、pm.response、pm.test 和 console.log；250ms CPU 截止、16MiB VM 内存限制。</div><textarea id="script-code" class="full-code" spellcheck="false" placeholder="${param === "before" ? "apt.setVar('requestId', 'demo');" : "pm.test('status', () => pm.expect(pm.response.code).to.equal(200));"}">${esc(r[param + "Script"] || "")}</textarea><p><button id="edit-operations">声明式操作（高级）</button></p><pre>${esc(JSON.stringify(r[param], null, 2))}</pre>`;
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
  if (response.error) v = response.error;
  if (responseTab === "body") {
    try {
      v = JSON.stringify(JSON.parse(v), null, 2);
    } catch {}
  }
  return `<pre>${esc(typeof v === "string" ? v : JSON.stringify(v, null, 2))}</pre>`;
}
function modePanel(r) {
  if (mode === "design")
    return `<div class="page"><div class="form-grid"><label>接口描述</label><textarea id="description">${esc(r.description)}</textarea><label>所属目录</label><input id="folder" value="${esc(r.folder)}"><label>超时（ms）</label><input id="timeout" type="number" min="100" max="60000" value="${r.timeout}"><label>请求 JSON Schema</label><textarea id="schema">${esc(JSON.stringify(r.schema, null, 2))}</textarea></div><div class="notice">定义、调试与用例共用同一接口。执行计划保存独立快照，不随接口修改。</div></div>`;
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
    return `<div class="page"><div class="page-head"><div><h1>项目配置</h1><span class="muted">环境、变量与本地存储</span></div><button id="save" class="primary">保存配置</button></div><div class="card"><div class="form-grid"><label>项目名称</label><input id="project-name" value="${esc(project.name)}"></div></div><div class="page-head"><h2>环境管理</h2><button id="add-env">＋ 新建环境</button></div>${project.environments.map((e) => `<div class="card"><div class="row"><strong class="grow">${esc(e.name)}</strong><button data-edit-env="${e.id}">编辑变量</button><button data-delete-env="${e.id}" class="danger">删除</button></div><pre>${esc(JSON.stringify(e.variables, null, 2))}</pre></div>`).join("")}<div class="notice">数据保存在启动目录的 .local-api 文件夹。变量可能包含密钥；导出或 Git 提交前请移除秘密。默认不上传任何内容。</div><div class="card"><h3>MCP 接入</h3><p>使用 stdio 模式启动，默认只读；必须显式授权项目。</p><pre>node src/mcp.mjs --project ${esc(project.id)}</pre><p class="muted">需要写入时加入 --write，需要执行请求时额外加入 --execute。不会自动更改你的 Agent 配置。</p></div></div>`;
  if (page === "plans") {
    const plan = project.plans.find((p) => p.id === planId);
    return `<div class="page"><div class="page-head"><div><h1>AI 执行计划</h1><span class="muted">固定步骤 · 独立快照 · 完整证据 · 可重复运行</span></div><button id="new-plan" class="primary">＋ 新建计划</button></div><div class="toolbar">${project.plans.map((p) => `<button data-plan="${p.id}" class="${planId === p.id ? "primary" : ""}">${esc(p.name)}</button>`).join("") || '<p class="muted">尚无计划。先创建接口，再组合成可重复的业务流程。</p>'}</div>${plan ? `<div class="card"><div class="row"><h3 class="grow">${esc(plan.name)}</h3><button id="edit-plan">编辑 JSON</button><button id="add-step">＋ 添加步骤</button><button id="run-plan" class="primary" ${busy ? "disabled" : ""}>${busy ? "执行中…" : "执行计划"}</button>${busy ? '<button id="cancel">停止</button>' : ""}</div><div class="row"><label>执行环境</label><select id="plan-env">${project.environments.map((e) => `<option value="${e.id}" ${e.id === plan.environmentId ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select></div>${plan.steps.map((s, i) => `<div class="plan-step"><span class="step-number">${i + 1}</span><input type="checkbox" data-step-enable="${i}" ${s.enabled ? "checked" : ""} aria-label="启用步骤"><span class="method ${s.request.method}">${s.request.method}</span><div class="grow"><strong>${esc(s.name)}</strong><div class="subtle">${esc(s.request.url)}</div></div><button data-step-up="${i}" ${i === 0 ? "disabled" : ""}>↑</button><button data-step-edit="${i}">编辑</button><button data-step-delete="${i}" class="danger">×</button></div>`).join("") || '<div class="notice">添加步骤后执行。每一步保存接口的独立快照。</div>'}</div>` : ""}<h2>执行记录 <span class="subtle">最近 50 条</span></h2>${(lastRun ? [lastRun, ...project.runs.filter((r) => r.id !== lastRun.id)] : project.runs).map((r) => `<details class="card" ${r.id === lastRun?.id ? "open" : ""}><summary><span class="${r.status === "passed" ? "success" : "failed"}">${r.status === "passed" ? "✓ 通过" : r.status === "cancelled" ? "■ 已取消" : "× 失败"}</span> &nbsp; ${esc(r.planName)} &nbsp; <span class="subtle">${esc(r.createdAt)} · ${r.results.length} 步</span></summary><p class="subtle">快照 SHA256: ${esc(r.planHash)}</p>${r.results.map((s, i) => `<details class="card"><summary>${i + 1}. <span class="${s.status === "passed" ? "success" : "failed"}">${s.status}</span> ${esc(s.name)} · ${s.response?.status || ""} ${s.response?.duration || 0}ms</summary><pre>${esc(JSON.stringify(s, null, 2))}</pre></details>`).join("")}<button data-export-run="${r.id}">导出证据 JSON</button></details>`).join("") || '<div class="empty"><span class="empty-symbol">☷</span><p>计划运行后，逐步结果将显示在这里</p></div>'}</div>`;
  }
  if (page === "history")
    return `<div class="page"><div class="page-head"><h1>最近请求</h1><span class="muted">本地保留最近 50 条</span></div>${project.history.map((h) => `<div class="card"><div class="row"><span class="method ${h.request?.method}">${h.request?.method}</span><strong class="grow">${esc(h.name)}</strong><span class="${h.response?.status < 400 ? "success" : "failed"}">${h.response?.status || "ERROR"}</span><button data-history="${h.id}">查看</button></div><p class="subtle">${esc(h.createdAt)} · ${esc(h.request?.url)}</p></div>`).join("") || '<div class="empty"><p>暂无请求历史</p></div>'}</div>`;
  if (page === "trash")
    return `<div class="page"><h1>回收站</h1><p class="muted">删除的接口在这里保留，可随时恢复。</p>${
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
    return `<div class="page"><h1>实时协议调试</h1><p class="muted">有界采集 SSE / WebSocket / TCP 响应，不在后台持续连接。</p><div class="form-grid"><label>协议</label><select id="protocol-type"><option value="sse">SSE</option><option value="websocket">WebSocket</option><option value="tcp">TCP</option></select><label>URL / TCP Host</label><input id="protocol-url" placeholder="http://localhost:8080/events"><label>TCP 端口</label><input id="protocol-port" type="number" value="8080"><label>采集时长 ms</label><input id="protocol-duration" type="number" value="3000" min="100" max="30000"><label>发送消息</label><textarea id="protocol-message"></textarea></div><p><button id="protocol-run" class="primary" ${busy ? "disabled" : ""}>连接并采集</button> <button id="cancel">断开</button></p><pre id="protocol-result"></pre></div>`;
  if (page === "database")
    return `<div class="page"><h1>数据库连接</h1><p class="muted">SQLite 本地只读查询 · 不会修改数据库 · 最多返回 1000 行</p><div class="form-grid"><label>数据库文件路径</label><input id="db-path" placeholder="C:\\data\\app.db 或 /data/app.db"><label>SQL</label><textarea id="db-sql">SELECT name FROM sqlite_master WHERE type = 'table'</textarea><label>绑定参数 JSON</label><input id="db-params" value="[]"></div><p><button id="db-query" class="primary">执行只读查询</button></p><pre id="db-result"></pre><div class="notice">当前仅实现 SQLite。MySQL / PostgreSQL 尚未实现，不冒充可用连接。</div></div>`;
  if (page === "git")
    return `<div class="page"><h1>Git 协同</h1><p class="muted">本地项目是格式化 JSON 文件，可以纳入你自己的 Git 仓库。</p><div class="card"><h3>推荐流程</h3><ol class="markdown"><li>导出项目，检查并移除环境密钥与历史中的敏感信息。</li><li>把接口定义文件放入项目仓库。</li><li>通过 Git diff 审查变更，通过 PR 协作。</li><li>其他成员导入同一文件，继续本地编辑。</li></ol><button id="export">导出项目文件</button></div><div class="notice">本应用不会自动执行 Git 命令、提交凭据或推送代码。执行记录与历史可能含敏感数据，请勿公开提交。</div></div>`;
  return `<div class="page"><div class="page-head"><div><h1>接口文档</h1><span class="muted">从当前项目定义生成，离线阅读与导出</span></div><button id="export-docs" class="primary">导出 Markdown</button></div>${
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
  const saved = await api("/projects/" + project.id + "/plans", "POST", {
    ...plan,
    projectRevision: project.revision,
  });
  const i = project.plans.findIndex((p) => p.id === saved.id);
  if (i < 0) project.plans.push(saved);
  else project.plans[i] = saved;
  planId = saved.id;
  project.revision = (await api("/projects/" + project.id)).revision;
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
    if (current === e.dataset.closeTab) current = opened.at(-1);
    render();
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
  on("#new-project", "click", () =>
    modal(
      "新建本地项目",
      '<label>项目名称</label><input id="new-name" placeholder="例如：商城服务">',
      async () => {
        const p = await api("/projects", "POST", {
          name: $("#new-name").value,
        });
        projects = await api("/projects");
        await openProject(p.id);
      },
    ),
  );
  on("#add-request,#new-request,#tab-add,#welcome-add", "click", addRequest);
  on("#save", "click", save);
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
  on("#script-code", "input", (_, element) => { request()[param + "Script"] = element.value; mark(); });
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
    mark();
    render();
  });
  on("#delete", "click", () => {
    if (!confirm("将此接口移到回收站？")) return;
    request().deletedAt = new Date().toISOString();
    current = project.requests.find((r) => !r.deletedAt)?.id;
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
  on("#curl", "click", async () => {
    collect();
    const r = await api("/projects/" + project.id + "/curl", "POST", {
      request: request(),
    });
    modal(
      "cURL",
      `<textarea id="curl-output" readonly>${esc(r.curl)}</textarea>`,
      () => navigator.clipboard.writeText(r.curl),
      "复制",
    );
  });
  on("#import", "click", () =>
    modal(
      "导入接口",
      `<p class="muted">支持项目 JSON、OpenAPI JSON、Postman Collection 与 cURL。仅解析，不执行导入内容。</p><label>导入方式</label><select id="import-mode"><option value="interfaces">导入接口到当前项目</option><option value="restore">完整恢复项目备份为新副本</option></select><input id="import-file" type="file" accept=".json,.txt"><textarea id="import-text" placeholder="粘贴 JSON 或 cURL"></textarea>`,
      async () => {
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
      filename: $("#db-path").value,
      sql: $("#db-sql").value,
      parameters: JSON.parse($("#db-params").value),
    });
    $("#db-result").textContent = JSON.stringify(result, null, 2);
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
          steps: request() ? [{ request: structuredClone(request()) }] : [],
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
        p.steps.push({ request: structuredClone(r) });
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
    download(
      project.name + ".md",
      "# " +
        project.name +
        "\n\n" +
        project.requests
          .filter((r) => !r.deletedAt)
          .map(
            (r) =>
              `## ${r.name}\n\n${r.method} ${r.url}\n\n${r.description}\n\n${r.bodyType !== "none" ? "```json\n" + r.body + "\n```" : ""}\n`,
          )
          .join("\n"),
      "text/markdown",
    ),
  );
}
function bindTree() {
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
  token = (await api("/session")).token;
  projects = await api("/projects");
  if (!projects.length) {
    const p = await api("/projects", "POST", { name: "默认项目" });
    p.environments[0].variables.baseUrl = location.origin;
    const r = defaultRequest("示例 · 本地响应");
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
    projects.find((p) => p.id === sessionStorage.getItem("project"))?.id ||
      projects[0].id,
  );
}
init().catch((e) => {
  $("#app").innerHTML =
    '<div class="page"><h1>无法启动工作台</h1><pre>' +
    esc(e.message) +
    "</pre><p>请确认本地服务正在运行，然后刷新页面。</p></div>";
});
