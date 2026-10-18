const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function environmentExtras(project) {
  return (
    '<div class="page-head"><h2>全局变量</h2><button id="edit-globals">编辑全局变量</button></div><div class="card"><p class="muted">同名值优先级：全局 → 环境 → 本次调试运行时。全局与环境值保存在本地。</p><pre>' +
    esc(JSON.stringify(project.globalVariables || {}, null, 2)) +
    "</pre></div>" +
    '<div class="page-head"><h2>共享服务与环境地址</h2><button id="add-service">＋ 新建服务</button></div>' +
    '<div class="card"><p class="muted">服务名称跨环境共享，每个环境可配置不同地址。在接口设计中绑定服务并填写相对路径。</p>' +
    ((project.servers || [])
      .map(
        (server) =>
          '<div class="row"><strong class="grow">' +
          esc(server.name) +
          '</strong><button data-edit-service="' +
          esc(server.id) +
          '">编辑环境地址</button><button data-delete-service="' +
          esc(server.id) +
          '" class="danger">删除服务</button></div><pre>' +
          esc(
            project.environments
              .map(
                (env) =>
                  env.name + ": " + (env.serverUrls?.[server.id] || "未配置"),
              )
              .join("\n"),
          ) +
          "</pre>",
      )
      .join("") || '<p class="muted">暂无共享服务</p>') +
    "</div>"
  );
}
