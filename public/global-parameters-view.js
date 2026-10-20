const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function globalParametersPanel(project) {
  const value = project.settings?.globalParameters || {};
  return (
    '<div class="notice">全局参数会用于本项目所有继承它的 HTTP 请求，请勿填入跨站点通用密钥。同名接口参数优先，禁用的同名行也会屏蔽全局值；Header 忽略大小写。已有计划与用例保留原快照。</div>' +
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
    '<p class="muted">当前全局编辑范围：Header、Query、Cookie、表单文本。认证和前后置脚本仍在各接口配置。</p>'
  );
}
