const outcomes = new Set(["not-sent", "acknowledged-applied", "unknown"]);
const reasons = new Set([
  "acknowledged",
  "cancelled",
  "revoked",
  "deadline",
  "transport",
  "not-reached",
  "dispatch-failed",
]);
const identifier = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
// Explicit projection only; driver error messages and credential-bearing inputs
// are never accepted as receipt fields. Imported receipts remain inert evidence.
export function databaseWriteReceipt(identity, outcome, reason) {
  if (
    !outcomes.has(outcome) ||
    !reasons.has(reason) ||
    (outcome === "acknowledged-applied") !== (reason === "acknowledged") ||
    !identifier(identity.runId) ||
    !identifier(identity.preparationId) ||
    !identifier(identity.projectId) ||
    !identifier(identity.receiptId) ||
    !identifier(identity.connectionId) ||
    !["before", "after"].includes(identity.phase) ||
    !Number.isInteger(identity.ordinal) ||
    identity.ordinal < 0 ||
    identity.ordinal >= 16 ||
    !/^[a-f0-9]{64}$/.test(identity.commandDigest) ||
    (identity.taskId !== undefined && !identifier(identity.taskId))
  )
    throw Object.assign(Error("数据库写入凭据字段无效"), {
      code: "NATIVE_WRITE_RECEIPT_INVALID",
    });
  return Object.freeze({
    version: 1,
    runId: identity.runId,
    preparationId: identity.preparationId,
    projectId: identity.projectId,
    receiptId: identity.receiptId,
    phase: identity.phase,
    ordinal: identity.ordinal,
    ...(identity.taskId === undefined ? {} : { taskId: identity.taskId }),
    connectionId: identity.connectionId,
    commandDigest: identity.commandDigest,
    outcome,
    reason,
  });
}
export function validateDatabaseWriteReceipts(value) {
  if (!Array.isArray(value) || value.length > 1)
    throw Error("数据库写入凭据数量无效");
  return value.map((entry) => {
    const projected = databaseWriteReceipt(entry, entry.outcome, entry.reason);
    if (
      entry.version !== 1 ||
      Object.keys(entry).some((key) => !Object.hasOwn(projected, key))
    )
      throw Error("数据库写入凭据字段无效");
    return projected;
  });
}

// Persistence validation is deliberately inert: no ledger entry, session or
// execution capability is constructed from imported evidence. Historical
// project/run identities remain provenance when restoring into a new project.
export function validateProjectDatabaseWriteEvidence(project) {
  for (const field of ["history", "runs"])
    for (const record of project[field] || []) {
      if (record.writeReceipts !== undefined)
        validateDatabaseWriteReceipts(record.writeReceipts);
      for (const result of record.results || [])
        if (result.writeReceipts !== undefined)
          validateDatabaseWriteReceipts(result.writeReceipts);
    }
}
