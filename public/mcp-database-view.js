import {
  isPreviewDatabase,
  readDatabasePreviewConnection,
} from "./sqlserver-preview-ui.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function mcpDatabaseAllowed(config, projectId) {
  return (
    config?.enabled === true &&
    config.write === true &&
    config.execute === true &&
    Array.isArray(config.projects) &&
    config.projects.includes(projectId)
  );
}
export function mcpDatabasePanel(project) {
  const bindings = project.settings?.apipostDatabases || [];
  return `<section id="mcp-database-panel" class="mcp-access-card"><h3>MCP 数据库临时授权 · ${esc(project.name || project.id)}</h3><p class="notice">默认拒绝。仅授权当前项目的 MCP 只读查询，不共享手动调试连接。查询结果可以被 Agent 读取，进入变量、HTTP 请求和历史；只读 SQL 中的自定义函数仍可能有副作用。凭据仅保存在应用进程内存，重启、关闭 MCP 或更改服务授权后失效，不随“保留授权”保存。</p><p id="mcp-db-policy" role="status"></p><button type="button" id="mcp-db-refresh">刷新授权列表</button><div id="mcp-db-list"></div><form id="mcp-db-form" autocomplete="off"><fieldset id="mcp-db-fields" disabled><legend>新增独立连接授权</legend><label>名称<input name="name" required maxlength="100"></label><label>数据库类型<select name="type"><option value="sqlite">SQLite</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="redis">Redis</option><option value="mongodb">MongoDB</option><option value="clickhouse">ClickHouse</option></select></label><label>原生导入连接绑定<select name="bindingId"><option value="">不绑定，使用新连接 ID</option>${bindings.map((b) => `<option value="${esc(b.id)}">${esc(b.name || b.id)} (${esc(b.type)})</option>`).join("")}</select></label><div id="mcp-db-local"><label>SQLite 文件路径<input name="filename" autocomplete="off"></label></div><div id="mcp-db-remote" hidden><label>主机<input name="host" autocomplete="off"></label><label>端口（空白使用默认）<input name="port" type="number" min="1" max="65535"></label><label>数据库<input name="database"></label><label>用户名<input name="user" autocomplete="off"></label><label>密码<input name="password" type="password" autocomplete="new-password"></label><label>MongoDB 认证数据库<input name="authSource"></label><label><input name="ssl" type="checkbox">验证 TLS</label><label>自定义 CA（可选）<textarea name="ca"></textarea></label><label id="mcp-db-client-cert" hidden>达梦客户端证书链（PEM，双向 TLS）<textarea name="clientCert" spellcheck="false" autocomplete="off"></textarea></label><label id="mcp-db-client-key" hidden>达梦客户端私钥（PEM，双向 TLS）<textarea name="clientKey" spellcheck="false" autocomplete="off"></textarea></label><label id="mcp-db-server-dn" hidden>Oracle 服务端证书 DN<input name="serverDN"></label><label id="mcp-db-relations" hidden>授权表（每行一个 SCHEMA.TABLE，有效期 15 分钟）<textarea name="relations"></textarea></label><details><summary>SSH（仅 PostgreSQL / MySQL / Redis）</summary><p>字段：host、port、username、password 或 privateKey（二选一）、可选 passphrase、hostKeySHA256。需要 SSH 的导入绑定必须提供；主机密钥指纹必须独立核对。不会自动信任首次连接。</p><label>SSH 配置 JSON（可选，含凭据）<input name="ssh" type="password" autocomplete="new-password"></label></details></div><label><input name="confirm" type="checkbox" required>我确认向此项目的 MCP 客户端提供上述数据库的临时只读访问及查询结果</label><button type="submit">确认临时授权</button><button type="reset">清空输入</button></fieldset></form><p id="mcp-db-message" role="status" aria-live="polite"></p></section>`;
}
export function readMCPDatabaseInput(form) {
  const value = (key) => form.elements.namedItem(key).value;
  if (!form.elements.namedItem("confirm").checked)
    throw Error("请先确认授权范围");
  const input = { name: value("name").trim(), type: value("type") };
  if (!input.name) throw Error("请输入连接名称");
  if (value("bindingId")) input.bindingId = value("bindingId");
  if (isPreviewDatabase(input.type)) {
    const fields = {
      "#db-tls": "ssl",
      "#db-port": "port",
      "#db-ca": "ca",
      "#db-host": "host",
      "#db-name": "database",
      "#db-user": "user",
      "#db-password": "password",
      "#db-server-dn": "serverDN",
      "#db-client-cert": "clientCert",
      "#db-client-key": "clientKey",
      "#db-relations": "relations",
    };
    return {
      ...input,
      ...readDatabasePreviewConnection(
        form.elements.namedItem("type"),
        (id) => form.elements.namedItem(fields[id]),
        input.type,
      ),
    };
  }
  if (input.type === "sqlite") {
    input.filename = value("filename");
    if (!input.filename) throw Error("请输入 SQLite 文件路径");
  } else {
    for (const key of [
      "host",
      "database",
      "user",
      "password",
      "authSource",
      "ca",
    ])
      if (value(key)) input[key] = value(key);
    if (!input.host) throw Error("请输入主机");
    if (value("port")) {
      input.port = Number(value("port"));
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
        throw Error("端口须为 1 至 65535 的整数");
    }
    input.ssl = form.elements.namedItem("ssl").checked;
    if (value("ssh").trim()) {
      try {
        input.ssh = JSON.parse(value("ssh"));
      } catch {
        throw Error("SSH 配置必须为有效 JSON");
      }
    }
  }
  return input;
}
export function bindMCPDatabase(
  root,
  { projectId, config, request, loadCapabilities },
) {
  const find = (s) => root.querySelector(s),
    form = find("#mcp-db-form"),
    fields = find("#mcp-db-fields"),
    list = find("#mcp-db-list"),
    message = find("#mcp-db-message"),
    refresh = find("#mcp-db-refresh");
  let policyKey = null;
  let allowed = false,
    busy = false,
    generation = 0;
  const endpoint =
    "/projects/" + encodeURIComponent(projectId) + "/mcp-database-connections";
  const present = () => root.isConnected;
  const paint = () => {
    fields.disabled = !allowed || busy;
    refresh.disabled = !allowed || busy;
  };
  const clear = () => {
    form.reset();
    toggle();
  };
  const toggle = () => {
    const type = form.elements.namedItem("type").value;
    const local = type === "sqlite";
    const tls = form.elements.namedItem("ssl");
    tls.disabled = isPreviewDatabase(type);
    if (tls.disabled) tls.checked = true;
    find("#mcp-db-relations").hidden = !["oracle", "dameng"].includes(type);
    find("#mcp-db-server-dn").hidden = type !== "oracle";
    find("#mcp-db-client-cert").hidden = type !== "dameng";
    find("#mcp-db-client-key").hidden = type !== "dameng";
    for (const [name, visible] of [
      ["authSource", type === "mongodb"],
      ["database", type !== "dameng"],
      ["ssh", ["postgres", "mysql", "redis"].includes(type)],
    ]) {
      const label = form.elements
        .namedItem(name)
        .closest?.(name === "ssh" ? "details" : "label");
      if (label) label.hidden = !visible;
    }
    find("#mcp-db-local").hidden = !local;
    find("#mcp-db-remote").hidden = local;
  };
  form.elements.namedItem("type").onchange = () => {
    for (const key of ["password", "ssh", "ca", "clientCert", "clientKey"])
      form.elements.namedItem(key).value = "";
    form.elements.namedItem("confirm").checked = false;
    toggle();
  };
  form.onreset = () => queueMicrotask(toggle);
  async function reload() {
    if (!present() || !allowed || busy) return;
    const current = ++generation;
    busy = true;
    list.textContent = "读取中…";
    paint();
    try {
      const rows = await request(endpoint);
      if (!present() || current !== generation) return;
      list.innerHTML = rows.length
        ? rows
            .map(
              (row) =>
                `<div class="row"><span class="grow">${esc(row.name)} · ${esc(row.type)}<br>连接 ID：<code>${esc(row.id)}</code>${row.bindingId ? `<br>导入绑定：<code>${esc(row.bindingId)}</code>` : ""}</span><button type="button" data-mcp-db-revoke="${esc(row.id)}">撤销</button></div>`,
            )
            .join("")
        : '<p class="muted">尚未授权数据库连接</p>';
    } catch {
      if (present() && current === generation) {
        list.textContent =
          "无法读取授权列表，请检查 MCP 服务和项目授权后刷新。";
      }
    } finally {
      if (present() && current === generation) {
        busy = false;
        paint();
      }
    }
  }
  async function mutate(method, payload) {
    if (!present() || !allowed || busy) return;
    const current = ++generation;
    busy = true;
    paint();
    let succeeded = false;
    try {
      await request(endpoint, method, payload);
      succeeded = true;
    } catch {
      /* Never reflect provider errors or submitted credentials. */
    } finally {
      if (present() && current === generation) {
        busy = false;
        paint();
        message.textContent = succeeded
          ? method === "DELETE"
            ? "已撤销此连接。"
            : "已临时授权；请使用列表中的连接 ID，或已有导入绑定。"
          : "操作未确认，可能失败或响应丢失。请先核对刷新后的列表，不要盲目重复授权。配置校验由服务端执行。";
        await reload();
      }
    }
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!present() || !allowed || busy) return;
    let input;
    try {
      input = readMCPDatabaseInput(form);
    } catch (error) {
      message.textContent = error.message;
      return;
    }
    clear();
    await mutate("POST", input);
  };
  list.onclick = async (event) => {
    const target = event.target.closest("[data-mcp-db-revoke]");
    if (target && list.contains(target))
      await mutate("DELETE", { id: target.dataset.mcpDbRevoke });
  };
  refresh.onclick = reload;
  function update(next) {
    if (!present()) return;
    const key = JSON.stringify([
      next?.enabled,
      next?.write,
      next?.execute,
      next?.projects,
      next?.token,
      next?.endpoint,
      next?.databaseGrantEpoch,
    ]);
    if (key === policyKey) return;
    policyKey = key;
    generation++;
    busy = false;
    allowed = mcpDatabaseAllowed(next, projectId);
    clear();
    list.textContent = "";
    message.textContent = "";
    find("#mcp-db-policy").textContent = allowed
      ? "当前项目已允许 MCP 写入项目及执行计划。数据库仍须在下方单独确认授权。"
      : "未开放：请先在“编辑授权与服务”中显式允许当前项目、写入项目及执行已有计划。这里不会自动扩大服务权限。";
    paint();
    if (allowed) {
      void loadCapabilities?.(form.elements.namedItem("type"), request);
      void reload();
    }
  }
  update(config);
  return update;
}
