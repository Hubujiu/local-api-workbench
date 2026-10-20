import { authPanel } from "./auth-view.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function globalParametersPanel(project, folder = "") {
  const folders = [
    ...new Set([
      ...(project.folders || []),
      ...(project.requests || []).map((item) => item.folder),
      ...Object.keys(project.settings?.folderParameters || {}),
      ...Object.keys(project.settings?.folderAuth || {}),
    ]),
  ]
    .filter(Boolean)
    .sort();
  if (!folders.includes(folder)) folder = "";
  const value = folder
    ? Object.hasOwn(project.settings?.folderParameters || {}, folder)
      ? project.settings.folderParameters[folder]
      : {}
    : project.settings?.globalParameters || {};
  const authEnabled = folder
    ? Object.hasOwn(project.settings?.folderAuth || {}, folder)
    : Object.hasOwn(project.settings || {}, "globalAuth");
  const auth = folder
    ? project.settings?.folderAuth?.[folder]
    : project.settings?.globalAuth;
  return (
    `<div class="card"><label for="parameter-scope">参数作用范围</label><select id="parameter-scope"><option value="">整个项目</option>${folders.map((name) => `<option value="${esc(name)}" ${name === folder ? "selected" : ""}>目录：${esc(name)}</option>`).join("")}</select><p class="muted">优先级：项目 → 当前目录 → 接口。同名禁用行屏蔽上层参数；目录按完整名称匹配，不递归继承。</p></div>` +
    '<div class="notice">公共参数会用于所选范围内继承它的 HTTP 请求，请勿填入跨站点通用密钥。同名接口参数优先，禁用的同名行也会屏蔽全局值；Header 忽略大小写。已有计划与用例保留原快照。</div>' +
    Object.entries({
      headers: "Header",
      query: "Query",
      cookies: "Cookie",
      form: "Body 表单文本",
    })
      .map(
        ([kind, label]) =>
          `<section class="card"><div class="row"><h3 class="grow">${label}</h3><button data-global-add="${kind}">＋ 添加参数</button></div>${kind === "form" ? '<p class="muted">仅 form-data / urlencoded 生效，不向 JSON、二进制或无 Body 请求添加内容。</p>' : ""}<table><thead><tr><th>启用</th><th>参数名</th><th>参数值 / {{变量}}</th><th></th></tr></thead><tbody>${(value[kind] || []).map((row, i) => `<tr><td><input type="checkbox" data-global-enabled="${kind}:${i}" aria-label="启用全局参数" ${row.enabled !== false ? "checked" : ""}></td><td><input data-global-field="${kind}:${i}:key" aria-label="${label}参数名" value="${esc(row.key)}"></td><td><input data-global-field="${kind}:${i}:value" aria-label="${label}参数值" value="${esc(row.value)}"></td><td><button data-global-remove="${kind}:${i}" aria-label="删除全局参数">×</button></td></tr>`).join("")}</tbody></table></section>`,
      )
      .join("") +
    `<section class="card"><h3>共享认证</h3><label><input id="shared-auth-enabled" type="checkbox" ${authEnabled ? "checked" : ""}>为本作用域设置认证覆盖</label><p class="muted">未勾选时${folder ? "继承项目认证" : "不添加项目认证"}；勾选后 none 表示明确不使用上层认证。接口已设置的具体认证始终优先。</p>${authEnabled ? authPanel(auth, { acquire: false, shared: true }) : ""}<div class="notice">共享凭据可能随本作用域多个目标站点的请求发送。请优先使用变量与 HTTPS；本地项目、导出和快照可能保存明文。此处不自动申请令牌或读取系统凭据。</div></section><p class="muted">前后置脚本仍在各接口配置。</p>`
  );
}
