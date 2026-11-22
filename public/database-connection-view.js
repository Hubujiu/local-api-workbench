export function databaseConnectionHTML() {
  return `<div class="page database-connection-page">
    <section class="database-connection-config" aria-labelledby="database-connection-heading">
      <header class="database-connection-heading">
        <h1 id="database-connection-heading">数据库连接</h1>
        <button type="button" class="ghost" data-page="database-manager">数据库管理</button>
      </header>
      <div class="form-grid database-connection-engine">
        <label for="db-type">数据库类型</label><select id="db-type"><option value="sqlite">SQLite</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="clickhouse">ClickHouse（HTTP只读）</option><option value="redis">Redis（默认只读）</option><option value="mongodb">MongoDB（find只读）</option></select>
      </div>
      <p class="database-connection-safety">连接凭据仅本次使用，不自动保存。仅连接你有权访问的数据库；只读事务不能保证数据库自定义函数无外部副作用。</p>
      <section class="database-connection-parameters" aria-labelledby="database-connection-parameters-heading">
        <h2 id="database-connection-parameters-heading">连接配置</h2>
        <div class="form-grid database-connection-fields">
          <label for="db-host">主机</label><input id="db-host" value="127.0.0.1">
          <label for="db-port">端口</label><input id="db-port" placeholder="5432 / 3306 / 6379">
          <label for="db-user">用户名</label><input id="db-user" autocomplete="off">
          <label for="db-password">密码</label><input id="db-password" type="password" autocomplete="off">
          <label for="db-name">数据库名 / Redis数据库索引</label><input id="db-name">
          <label for="db-auth-source">MongoDB认证库</label><input id="db-auth-source" value="admin">
          <label for="db-tls">TLS</label><input id="db-tls" type="checkbox">
          <label for="db-ca">自定义CA（PEM，可选）</label><textarea id="db-ca" placeholder="留空使用系统信任的证书"></textarea>
          <label for="db-client-cert">达梦客户端证书链（PEM，双向 TLS）</label><textarea id="db-client-cert" spellcheck="false" autocomplete="off"></textarea>
          <label for="db-client-key">达梦客户端私钥（PEM，双向 TLS）</label><textarea id="db-client-key" spellcheck="false" autocomplete="off"></textarea>
          <label for="db-server-dn">服务端证书 DN</label><input id="db-server-dn" placeholder="CN=db.example.com">
          <label for="db-relations">授权表（每行一个 SCHEMA.TABLE，有效期 15 分钟）</label><textarea id="db-relations" placeholder="APP.ITEMS"></textarea>
          <label for="db-path">SQLite 文件路径</label><input id="db-path" placeholder="C:\\data\\app.db 或 /data/app.db">
        </div>
      </section>
      <p id="db-sqlserver-notice" class="notice" hidden>SQL Server 只读预览：必须验证TLS，目标数据库须为 READ_ONLY；仅显式 schema.table 列查询，参数使用 @p0。最多1000行，不支持写入/SSH。尚未完成真实服务与 Windows 验收。</p>
    </section>
    <section class="database-query-section" aria-labelledby="database-query-heading">
      <div class="database-query-heading"><h2 id="database-query-heading">数据库查询</h2><span class="muted">默认只读 · 最多返回 1000 行</span></div>
      <div class="form-grid database-query-fields">
          <label for="db-sql">SQL / Redis命令JSON数组（如 ["GET","key"]）</label><textarea id="db-sql">SELECT name FROM sqlite_master WHERE type = 'table'</textarea>
          <label for="db-params">绑定参数 JSON</label><input id="db-params" value="[]">
      </div>
      <p><label id="db-write-label"><input id="db-write" type="checkbox"><span id="db-write-description">仅本次允许SQLite写入（INSERT / UPDATE / DELETE）</span></label></p>
      <div class="database-query-actions"><button type="button" id="db-query" class="primary">执行只读查询</button> <button type="button" id="db-register">授权为本项目会话连接</button> <button type="button" id="db-connections">管理会话连接</button></div>
      <pre id="db-result"></pre>
    </section>
  </div>`;
}
