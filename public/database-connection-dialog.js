const fields = [
  ["host", "数据库地址", "IP/Host"],
  ["port", "端口", "3306"],
  ["user", "用户名", "请输入用户名"],
  ["password", "密码", "请输入密码"],
  ["name", "数据库名", "请输入数据库名称"],
];
export function openMySQLConnectionDraft(root = document) {
  if (root.querySelector("#mysql-connection-dialog")) return;
  const owner = root.querySelector("#db-type");
  if (!owner?.isConnected) return;
  const dialog = document.createElement("dialog");
  dialog.id = "mysql-connection-dialog";
  dialog.setAttribute("aria-labelledby", "mysql-connection-title");
  dialog.innerHTML = `<form method="dialog"><header><strong id="mysql-connection-title">数据库连接</strong><button value="cancel" aria-label="关闭">×</button></header><div class="mysql-connection-body"><div class="mysql-type-row"><span>数据库类型</span><strong>MySQL</strong></div><p class="notice">仅编辑本机连接草稿，不测试连接、不保存密码、不授予访问权限。需要使用时仍须明确执行查询或确认会话授权。</p><section class="mysql-connection-grid"><aside>本次连接</aside><div><h3>常规配置</h3>${fields.map(([key, label, placeholder]) => `<label for="mysql-draft-${key}">${label}</label><input id="mysql-draft-${key}" type="${key === "password" ? "password" : "text"}" autocomplete="off" placeholder="${placeholder}">`).join("")}<label for="mysql-draft-tls">TLS</label><input id="mysql-draft-tls" type="checkbox"><label for="mysql-draft-ca">自定义 CA</label><textarea id="mysql-draft-ca" placeholder="留空使用系统信任的证书"></textarea></div></section></div><footer><button value="cancel">取消</button><button id="mysql-draft-apply" type="button" class="primary">使用此草稿</button></footer></form>`;
  const sameType = root.querySelector("#db-type").value === "mysql";
  for (const [key] of fields)
    dialog.querySelector(`#mysql-draft-${key}`).value = sameType
      ? root.querySelector(`#db-${key}`).value
      : key === "host"
        ? "127.0.0.1"
        : "";
  const tls = dialog.querySelector("#mysql-draft-tls");
  const ca = dialog.querySelector("#mysql-draft-ca");
  tls.checked = sameType && root.querySelector("#db-tls").checked;
  ca.value = sameType ? root.querySelector("#db-ca").value : "";
  const showCA = () => {
    ca.hidden = !tls.checked;
    ca.previousElementSibling.hidden = !tls.checked;
  };
  tls.onchange = showCA;
  showCA();
  dialog.querySelector("#mysql-draft-apply").onclick = () => {
    const type = root.querySelector("#db-type");
    if (!type?.isConnected || type !== owner) return dialog.close();
    type.value = "mysql";
    for (const [key] of fields)
      root.querySelector(`#db-${key}`).value = dialog.querySelector(
        `#mysql-draft-${key}`,
      ).value;
    root.querySelector("#db-tls").checked = tls.checked;
    root.querySelector("#db-ca").value = ca.value;
    type.dispatchEvent(new Event("change", { bubbles: true }));
    dialog.close();
  };
  dialog.addEventListener(
    "close",
    () => {
      for (const input of dialog.querySelectorAll("input,textarea"))
        input.value = "";
      dialog.remove();
    },
    { once: true },
  );
  document.body.append(dialog);
  dialog.showModal();
}
