import { validateSocketIORecord } from "./socketio.mjs";
import { protocolEvidenceHash } from "./wire-evidence.mjs";

// Freeze once, then reconcile storage only. A lost save acknowledgement must
// never trigger another connection/send or allow a different record to win by ID.
export async function finalizeSocketIOSession(
  store,
  projectId,
  session,
  snapshot,
) {
  session.finalRecord ??= {
    id: session.id,
    type: "socketio",
    createdAt: snapshot.createdAt,
    definition: structuredClone(snapshot.definition),
    result: structuredClone(snapshot),
    source: "manual",
    status:
      snapshot.state === "error" ||
      snapshot.events.some((x) =>
        ["ack-timeout", "disconnected"].includes(x.direction),
      )
        ? "failed"
        : snapshot.connected
          ? "passed"
          : "cancelled",
  };
  const record = session.finalRecord;
  validateSocketIORecord(record);
  const existing =
    (await store.get(projectId)).protocolRuns?.filter(
      (item) => item.id === record.id,
    ) || [];
  if (existing.length) {
    // Recompute both hashes from the full evidence, not a stored hash field.
    if (
      existing.length !== 1 ||
      protocolEvidenceHash(existing[0]) !== protocolEvidenceHash(record)
    )
      throw Error("Socket.IO记录ID冲突，不能覆盖已有证据");
    validateSocketIORecord(existing[0]);
    return record.id;
  }
  await store.append(projectId, "protocolRuns", record);
  return record.id;
}
