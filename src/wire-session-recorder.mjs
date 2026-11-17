import { finalizeWireSession } from "./wire-session-evidence.mjs";
import { recordSaveFailure, recordSaveSuccess } from "./execution-evidence.mjs";

// Shared by interactive hosts: one automatic save, no network replay, and an
// explicit receipt even when durable storage cannot be confirmed.
export function createWireSessionRecorder(store) {
  return function saveWireSession(session) {
    if (!session.projectId) return;
    if (session.recordSaved || session.recordPromise)
      return session.recordPromise;
    session.recordPending = true;
    session.recordPromise = (async () => {
      try {
        const recordId = await finalizeWireSession(
          store,
          session.projectId,
          session,
          session.finalSnapshot,
        );
        session.recordSaved = true;
        session.receipt = recordSaveSuccess(recordId);
      } catch (error) {
        session.receipt = recordSaveFailure(
          session.projectId,
          session.finalRecord?.id ?? null,
          error,
        );
      }
      session.recordPending = false;
      return session.receipt;
    })();
    return session.recordPromise;
  };
}
