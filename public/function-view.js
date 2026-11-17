const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function functionPanel(project) {
  return (
    '<section id="resource-functions" class="card"><div class="row"><h3 class="grow">自定义函数</h3><button id="new-function">新建函数</button></div><p>参数处理函数使用 text 作为输入；保存前必须测试当前代码与输入。函数名创建后不可修改。既有共享脚本函数继续使用 args 数组。</p>' +
    (project.settings?.functions || [])
      .map(
        (fn, index) =>
          `<div class="row"><strong class="grow">${esc(fn.name)}</strong><span>${fn.kind === "transform" ? "参数处理" : "共享脚本"}</span><button data-edit-function="${index}">编辑 / 测试</button><button data-delete-function="${index}">删除</button></div>`,
      )
      .join("") +
    "</section>"
  );
}
