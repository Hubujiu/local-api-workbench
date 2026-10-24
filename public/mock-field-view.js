const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function mockFieldPanel(project) {
  const settings = project.settings || {};
  return (
    '<section class="card"><p>按字段名通配符和字段类型选择数据生成规则；与接口页的条件响应期望相互独立。</p><label><input id="mock-builtins" type="checkbox" ' +
    (settings.smartMockBuiltins ? "checked" : "") +
    '>启用内置姓名、邮箱、电话、URL、整数 ID 与离线头像规则</label><label>固定种子（原版日期还依赖当前时钟与本机时区）<input id="mock-seed" type="number" min="0" max="4294967295" value="' +
    esc(settings.mockSeed ?? 0) +
    '"></label><p class="muted">通配符支持 *、?、[abc]、[!abc]、{name,*_name}。规则按顺序匹配，用户显式示例优先；这不是完整 Mock.js 脚本运行器。</p><button id="new-mock-field" class="primary">新建字段规则</button><table><thead><tr><th>启用</th><th>名称 / 匹配字段</th><th>类型</th><th>Mock 数据</th><th></th></tr></thead><tbody>' +
    (settings.mockFieldRules || [])
      .map(
        (rule) =>
          '<tr><td><input type="checkbox" data-mock-field-enabled="' +
          esc(rule.id) +
          '" ' +
          (rule.enabled !== false ? "checked" : "") +
          "></td><td>" +
          esc(rule.name) +
          "<br>" +
          esc(rule.pattern) +
          "</td><td>" +
          esc(rule.type) +
          "</td><td><code>" +
          esc(rule.mock) +
          '</code></td><td><button data-edit-mock-field="' +
          esc(rule.id) +
          '">编辑</button><button data-delete-mock-field="' +
          esc(rule.id) +
          '">删除</button></td></tr>',
      )
      .join("") +
    '</tbody></table><p class="muted">支持 @cname()、@name()、@telephone()、@email()、@url()、@integer(min,max)、@float(min,max,小数位)、@boolean()、@guid()、@string(长度)、@date() 等有界函数及 JSON 常量。生成值仅用于测试，不可作为安全随机凭据。</p></section>'
  );
}
