import { sqlServerConnectionContract } from "../../src/sqlserver-driver-contract.mjs";
export const GATE_SQL =
  "SELECT id, payload FROM dbo.workbench_sqlserver_gate WHERE id=@p0";
export const GATE_PERMISSIONS =
  "SELECT CONVERT(int, IS_SRVROLEMEMBER('sysadmin')) AS [sysadmin], CONVERT(int, HAS_PERMS_BY_NAME(NULL, NULL, 'CONTROL SERVER')) AS [server_control], CONVERT(int, HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CONTROL')) AS [database_control], CONVERT(int, HAS_PERMS_BY_NAME('dbo.workbench_sqlserver_gate', 'OBJECT', 'SELECT')) AS [can_select], CONVERT(int, HAS_PERMS_BY_NAME('dbo.workbench_sqlserver_gate', 'OBJECT', 'INSERT')) AS [can_insert], CONVERT(int, HAS_PERMS_BY_NAME('dbo.workbench_sqlserver_gate', 'OBJECT', 'UPDATE')) AS [can_update], CONVERT(int, HAS_PERMS_BY_NAME('dbo.workbench_sqlserver_gate', 'OBJECT', 'DELETE')) AS [can_delete], CONVERT(int, HAS_PERMS_BY_NAME('dbo.workbench_sqlserver_gate', 'OBJECT', 'ALTER')) AS [can_alter]";
const fail = () => {
  throw Error("SQLSERVER_REAL_GATE_CONFIG_INVALID");
};
export function gateEnabled(env) {
  if (
    env.LOCALAPI_SQLSERVER_REAL === undefined ||
    env.LOCALAPI_SQLSERVER_REAL === "0"
  )
    return false;
  if (env.LOCALAPI_SQLSERVER_REAL !== "1") fail();
  if (!env.LOCALAPI_SQLSERVER_REAL_CONFIG) fail();
  return true;
}
export function validateGateConfig(value) {
  try {
    if (
      !value ||
      value.disposable !== true ||
      Object.keys(value).sort().join() !== "disposable,readOnly,readWrite"
    )
      fail();
    for (const [key, name] of [
      ["readOnly", "localapi_gate_ro"],
      ["readWrite", "localapi_gate_rw"],
    ]) {
      const connection = value[key];
      if (
        connection.database !== name ||
        !connection.password ||
        !connection.ca
      )
        fail();
      sqlServerConnectionContract(connection);
    }
    if (
      value.readOnly.host !== value.readWrite.host ||
      (value.readOnly.port ?? 1433) !== (value.readWrite.port ?? 1433)
    )
      fail();
    return structuredClone(value);
  } catch {
    fail();
  }
}
export function requireRestrictedPermissions(row) {
  if (
    !row ||
    Object.keys(row).sort().join() !==
      "can_alter,can_delete,can_insert,can_select,can_update,database_control,server_control,sysadmin" ||
    row.can_select !== 1 ||
    Object.entries(row).some(
      ([key, value]) => key !== "can_select" && value !== 0,
    )
  )
    throw Error("SQLSERVER_REAL_GATE_LOGIN_NOT_RESTRICTED");
}
