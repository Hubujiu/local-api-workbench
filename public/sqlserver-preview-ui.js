// Host capability controls discoverability, not authority. Server rechecks every
// registration/query. No localStorage, project settings, credential cache or gate setter.
const providers = new Map([
  ["sqlserver", "SQL Server"],
  ["oracle", "Oracle"],
  ["dameng", "达梦 DM8"],
]);
export const isPreviewDatabase = (type) => providers.has(type);
const enabled = new WeakMap();
const requests = new WeakMap();
export async function loadDatabasePreviewCapabilities(selector, api) {
  if (!selector) return;
  enabled.delete(selector);
  for (const type of providers.keys())
    selector.querySelector(`option[value="${type}"]`)?.remove();
  const request = {};
  requests.set(selector, request);
  try {
    const result = await api("/database-capabilities");
    if (!selector.isConnected || requests.get(selector) !== request) return;
    const available = new Set();
    for (const [type, title] of providers) {
      if (result?.[type + "ReadOnlyPreview"] !== true) continue;
      available.add(type);
      const option = document.createElement("option");
      option.value = type;
      option.textContent = title + "（只读预览）";
      selector.append(option);
    }
    enabled.set(selector, available);
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
      "数据库端口须留空或为1至65535的十进制整数，不接受空格、零或科学计数法",
    );
  return Number(raw);
}
export function readDatabasePreviewConnection(
  selector,
  read,
  type = "sqlserver",
) {
  if (!enabled.get(selector)?.has(type))
    throw Error("服务端尚未确认此数据库的只读预览能力，请重新打开数据库页");
  if (!read("#db-tls").checked) throw Error("只读预览必须启用并验证TLS");
  const port = sqlServerPortInput(read("#db-port").value);
  const ca = read("#db-ca").value;
  return {
    type,
    host: read("#db-host").value,
    user: read("#db-user").value,
    password: read("#db-password").value,
    ...(type !== "dameng" && { database: read("#db-name").value }),
    ssl: true,
    ...(port === undefined ? {} : { port }),
    ...(ca !== "" && { ca }),
    ...(type === "oracle" && { serverDN: read("#db-server-dn").value }),
    ...(type !== "sqlserver" && {
      relations: read("#db-relations")
        .value.trim()
        .split(/[\s,]+/)
        .filter(Boolean),
    }),
  };
}

export {
  loadDatabasePreviewCapabilities as loadSQLServerPreviewCapability,
  readDatabasePreviewConnection as readSQLServerPreviewConnection,
};
