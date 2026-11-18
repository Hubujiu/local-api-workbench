// Host capability controls discoverability, not authority. Server rechecks every
// registration/query. No localStorage, project settings, credential cache or gate setter.
const enabled = new WeakSet();
const requests = new WeakMap();
export async function loadSQLServerPreviewCapability(selector, api) {
  if (!selector) return;
  enabled.delete(selector);
  selector.querySelector('option[value="sqlserver"]')?.remove();
  const request = {};
  requests.set(selector, request);
  try {
    const result = await api("/database-capabilities");
    if (
      !selector.isConnected ||
      requests.get(selector) !== request ||
      result?.sqlserverReadOnlyPreview !== true
    )
      return;
    enabled.add(selector);
    if (!selector.querySelector('option[value="sqlserver"]')) {
      const option = document.createElement("option");
      option.value = "sqlserver";
      option.textContent = "SQL Server（只读预览）";
      selector.append(option);
    }
  } catch {
    // Authentication/network/unsupported-host failure stays closed.
  }
}
export function sqlServerPortInput(raw) {
  if (raw === "") return undefined;
  if (
    typeof raw !== "string" ||
    !/^[1-9][0-9]{0,4}$/.test(raw) ||
    Number(raw) > 65535
  )
    throw Error(
      "SQL Server端口须留空或为1至65535的十进制整数，不接受空格、零或科学计数法",
    );
  return Number(raw);
}
export function readSQLServerPreviewConnection(selector, read) {
  if (!enabled.has(selector))
    throw Error("服务端尚未确认 SQL Server 只读预览能力，请重新打开数据库页");
  if (!read("#db-tls").checked) throw Error("SQL Server预览必须启用并验证TLS");
  const port = sqlServerPortInput(read("#db-port").value);
  const ca = read("#db-ca").value;
  return {
    type: "sqlserver",
    host: read("#db-host").value,
    user: read("#db-user").value,
    password: read("#db-password").value,
    database: read("#db-name").value,
    ssl: true,
    ...(port === undefined ? {} : { port }),
    ...(ca === "" ? {} : { ca }),
  };
}
