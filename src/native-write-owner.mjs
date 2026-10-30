import { validateResources } from "./resources.mjs";
import { normalizeRequest, snapshotPlan } from "./core.mjs";
import {
  environmentVariables,
  selectedEnvironment,
  freezeServiceBinding,
  resolveServiceRequest,
} from "./environments.mjs";
import {
  collectNativeRedisWrites,
  nativeWriteDigest,
} from "./native-redis-write-intent.mjs";
import { NativeWriteAuthorizations } from "./native-write-authorizations.mjs";

const invalid = () =>
  Object.assign(Error("原生写入准备或授权不可用，请重新核对当前项目和目标"), {
    code: "NATIVE_WRITE_DENIED",
  });
function projectConfiguration(project, projectId) {
  if (
    !project ||
    project.id !== projectId ||
    project.archived ||
    project.deletedAt
  )
    throw invalid();
  const snapshot = structuredClone(project);
  // Activity journals are not executable configuration and may grow while a
  // prepared request waits for owner approval. Never copy them into the ledger.
  for (const key of [
    "history",
    "runs",
    "protocolRuns",
    "revision",
    "updatedAt",
    "_diskFingerprint",
  ])
    delete snapshot[key];
  return snapshot;
}
function exactData(data, keys) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).some((key) => !keys.includes(key))
  )
    throw invalid();
}

/** Owner HTTP orchestration only. Authentication/origin checks stay in the
 * owner router. runPrepared must finalize its owned write and return execution
 * plus persistence outcomes on every path; it must never retry execution. */
export function createNativeWriteOwner({
  store,
  databaseSessions,
  runPrepared,
  now,
} = {}) {
  if (!store || !databaseSessions || typeof runPrepared !== "function")
    throw invalid();
  const ledger = new NativeWriteAuthorizations(now ? { now } : {});
  const targets = new Map();
  let closed = false;
  function release(id) {
    const target = targets.get(id);
    target?.signal?.removeEventListener("abort", target.onAbort);
    targets.delete(id);
  }
  return {
    async prepare(projectId, data) {
      exactData(data, ["request", "requestId", "environmentId", "functions"]);
      if (
        closed ||
        (data.request === undefined) === (data.requestId === undefined)
      )
        throw invalid();
      const reservation = ledger.beginPreparation();
      let prepared;
      try {
        let project = await store.get(projectId);
        const config = projectConfiguration(project, projectId);
        project = undefined;
        const requested =
          data.requestId === undefined
            ? data.request
            : config.requests?.find(
                (request) =>
                  request.id === data.requestId && !request.deletedAt,
              );
        if (!requested || requested.deletedAt) throw invalid();
        const environment = selectedEnvironment(config, data.environmentId);
        const request = normalizeRequest(
          freezeServiceBinding(config, requested),
        );
        // Resolve now to validate the frozen service/environment relationship,
        // but retain service identity for the ordinary execution machinery.
        resolveServiceRequest(config, request, environment.id);
        const writes = collectNativeRedisWrites(request);
        if (writes.length !== 1) throw invalid();
        const write = writes[0];
        const fingerprint = nativeWriteDigest(config);
        const plan = snapshotPlan({
          name: request.name,
          environmentId: environment.id,
          functions: data.functions ?? config.settings?.functions ?? [],
          steps: [{ request }],
        });
        validateResources({ functions: plan.functions });
        const snapshot = {
          plan,
          variables: environmentVariables(config, environment.id),
          environmentId: environment.id,
          projectSnapshot: config,
        };
        if (Buffer.byteLength(JSON.stringify(snapshot)) > 4 * 1024 * 1024)
          throw invalid();
        const target = await databaseSessions.captureNativeRedisTarget(
          projectId,
          write.connectionId,
        );
        target.assertLive();
        const review = {
          ...write,
          command: JSON.parse(write.query),
          sessionGeneration: target.sessionGeneration,
          ...(target.bindingId ? { sourceId: target.bindingId } : {}),
          safeTarget: {
            host: target.config.host,
            port: Number(target.config.port),
            database: Number(target.config.database),
            ssl: target.config.ssl === true,
          },
        };
        prepared = await ledger.prepare(projectId, {
          snapshot,
          reservation,
          review,
          binding: {
            sessionGeneration: target.sessionGeneration,
            bindingId: target.bindingId,
            config: target.config,
            admissionFingerprint: fingerprint,
          },
          checkAdmission: async () => {
            const current = projectConfiguration(
              await store.get(projectId),
              projectId,
            );
            if (nativeWriteDigest(current) !== fingerprint) return false;
            await target.revalidate();
            target.assertLive();
            return true;
          },
          checkLive: () => {
            target.assertLive();
            return !closed;
          },
          onRelease: release,
        });
        if (closed) throw invalid();
        target.assertLive();
        const onAbort = () => {
          try {
            ledger.revoke(projectId, prepared.preparationId);
          } catch {
            /* Expired entries have no authority. */
          }
        };
        targets.set(prepared.preparationId, { ...target, onAbort });
        target.signal?.addEventListener("abort", onAbort, { once: true });
        target.assertLive();
        if (target.signal?.aborted) throw invalid();
        return prepared;
      } catch {
        if (prepared) {
          try {
            ledger.revoke(projectId, prepared.preparationId);
          } catch {}
          release(prepared.preparationId);
        }
        throw invalid();
      } finally {
        ledger.cancelPreparation(reservation);
      }
    },
    authorize(projectId, data) {
      exactData(data, [
        "preparationId",
        "digest",
        "phase",
        "ordinal",
        "acknowledgeReplacement",
      ]);
      return ledger.authorize(projectId, data.preparationId, data);
    },
    async execute(projectId, data, { signal } = {}) {
      exactData(data, ["preparationId", "token"]);
      const handle = await ledger.reserve(
        projectId,
        data.preparationId,
        data.token,
      );
      const target = targets.get(handle.preparationId);
      if (!target) throw invalid();
      const signals = [handle.signal, target.signal, signal].filter(Boolean);
      let outcome;
      try {
        outcome = await runPrepared(handle, target, {
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        // A host callback may surface its already-finalized outcome alongside
        // an error; never infer not-sent or rollback from an exception alone.
        if (!error?.nativeWriteOutcome) throw invalid();
        outcome = error.nativeWriteOutcome;
      }
      const terminal = ledger.complete(handle, outcome);
      return {
        ...outcome,
        preparationId: handle.preparationId,
        runId: handle.runId,
        writeReceipts: terminal.writeReceipts,
      };
    },
    revoke(projectId, data) {
      exactData(data, ["preparationId"]);
      return ledger.revoke(projectId, data.preparationId);
    },
    status(projectId, data) {
      exactData(data, ["preparationId"]);
      return ledger.status(projectId, data.preparationId);
    },
    close() {
      closed = true;
      ledger.close();
    },
  };
}
