// Explicit host-level preview gate, never inferred from a request or grant.
import { snapshotSQLServerFlatInput } from "./sqlserver-input-contract.mjs";
import { sqlServerConnectionContract } from "./sqlserver-driver-contract.mjs";
import { runSQLServerPreparationProcess } from "./sqlserver-prep-process.mjs";
export function sqlServerPreviewEnabled() {
  return process.env.LOCALAPI_SQLSERVER_PREVIEW === "read-only";
}
export function requireSQLServerPreview() {
  if (!sqlServerPreviewEnabled())
    throw Object.assign(
      Error("数据库类型无效：SQL Server 只读预览未由服务进程启用"),
      {
        code: "SQLSERVER_PREVIEW_DISABLED",
      },
    );
}
export function validateSQLServerSession(config) {
  requireSQLServerPreview();
  const { type, ...connection } = config;
  if (type !== "sqlserver") throw Error("SQL Server 会话类型无效");
  sqlServerConnectionContract(connection);
}
export async function querySQLServerPreview(input, { signal } = {}) {
  requireSQLServerPreview();
  // These synchronous snapshots happen before the first await. The process
  // supervisor separately snapshots credentials and parameters before compilation.
  const normalized = snapshotSQLServerFlatInput(input);
  const result = await runSQLServerPreparationProcess(normalized, {
    signal,
    exactOutput: true,
  });
  requireSQLServerPreview();
  return result;
}
