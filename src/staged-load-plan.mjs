import { performance } from "node:perf_hooks";
import { isProxy } from "node:util/types";
import { snapshotPlan, runPlan } from "./core.mjs";
import {
  activePlanLeaves,
  hasRepeatSteps,
  hasRuntimeRows,
  planLeaves,
  potentialPlanStepCount,
} from "./plan-repeat.mjs";
import {
  selectedEnvironment,
  environmentVariables,
  resolveServiceRequest,
} from "./environments.mjs";
import { projectScopes } from "./variable-scopes.mjs";
import {
  collectionIdentifier,
  collectionScope,
  validatePostmanCollections,
} from "./postman-collection-scopes.mjs";
import { memoryCookieSession } from "./cookie-jar.mjs";
import { denyNativeWrites } from "./native-redis-write-intent.mjs";
import { normalizeRedirect } from "./http-redirect.mjs";
import { executeRequest } from "./runtime.mjs";
import { analyzePlanRequirements } from "./plan-requirements.mjs";
import { liveRequestId } from "./live-plan-reference.mjs";

// Bounded canonical contract. VU changes are linear, based on monotonic time.
export function buildLoadSchedule(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "initialVUs",
          "stages",
          "maxIterations",
          "reportIntervalSeconds",
        ].includes(key),
    )
  )
    throw Error("阶段压测参数无效");
  const {
    initialVUs,
    stages,
    maxIterations,
    reportIntervalSeconds = 1,
  } = input;
  if (
    !Number.isInteger(initialVUs) ||
    initialVUs < 0 ||
    initialVUs > 10 ||
    !Number.isInteger(reportIntervalSeconds) ||
    reportIntervalSeconds < 1 ||
    reportIntervalSeconds > 10 ||
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > 100 ||
    !Array.isArray(stages) ||
    !stages.length ||
    stages.length > 10
  )
    throw Error("阶段压测须为 0–10 个初始 VU、1–100 次迭代及 1–10 个阶段");
  let now = 0,
    current = initialVUs,
    maximum = initialVUs;
  const changes = [];
  for (const stage of stages) {
    if (
      !stage ||
      typeof stage !== "object" ||
      Array.isArray(stage) ||
      Object.keys(stage).some(
        (key) => !["durationSeconds", "targetVUs"].includes(key),
      ) ||
      !Number.isInteger(stage.durationSeconds) ||
      stage.durationSeconds < 1 ||
      !Number.isInteger(stage.targetVUs) ||
      stage.targetVUs < 0 ||
      stage.targetVUs > 10
    )
      throw Error("阶段持续时间和目标 VU 无效");
    const length = stage.durationSeconds * 1000;
    now += length;
    if (now > 60000) throw Error("阶段压测总时长不能超过 60 秒");
    const delta = stage.targetVUs - current;
    maximum = Math.max(maximum, stage.targetVUs);
    for (let i = 1; i <= Math.abs(delta); i++) {
      const atMs = now - length + Math.ceil((length * i) / Math.abs(delta));
      // The final endpoint is the overall deadline if it falls at 60 seconds;
      // the host never launches work after the deadline.
      changes.push({ atMs, vus: current + Math.sign(delta) * i });
    }
    current = stage.targetVUs;
  }
  if (!maximum) throw Error("阶段压测至少需要一个 VU");
  return {
    initialVUs,
    maxIterations,
    reportIntervalSeconds,
    durationMs: now,
    changes,
  };
}

// Prepared objects are not authority. Recheck the bounded schedule and static
// graph on both entry points, before reading runtime scopes or starting work.
function scheduleRecord(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("阶段压测调度须为普通数据");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length)
    throw Error("阶段压测调度字段无效");
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw Error("阶段压测调度不能包含访问器");
    result[key] = descriptor.value;
  }
  return result;
}

function admitSchedule(input) {
  // Never invoke caller hooks, even while copying a forged prepared schedule.
  // Capture own data descriptors once, then validate exactly the copy we use.
  const schedule = scheduleRecord(input, [
    "initialVUs",
    "maxIterations",
    "reportIntervalSeconds",
    "durationMs",
    "changes",
  ]);
  const changes = schedule.changes;
  if (
    isProxy(changes) ||
    !Array.isArray(changes) ||
    Object.getPrototypeOf(changes) !== Array.prototype
  )
    throw Error("阶段压测调度变化须为普通数组");
  const length = Object.getOwnPropertyDescriptor(changes, "length").value;
  if (length > 100) throw Error("阶段压测调度变化无效或超限");
  const descriptors = Object.getOwnPropertyDescriptors(changes);
  if (Reflect.ownKeys(descriptors).length !== length + 1)
    throw Error("阶段压测调度变化无效或超限");
  schedule.changes = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw Error("阶段压测调度变化不能包含空洞或访问器");
    schedule.changes.push(scheduleRecord(descriptor.value, ["atMs", "vus"]));
  }
  if (
    !schedule ||
    !Number.isInteger(schedule.initialVUs) ||
    schedule.initialVUs < 0 ||
    schedule.initialVUs > 10 ||
    !Number.isInteger(schedule.maxIterations) ||
    schedule.maxIterations < 1 ||
    schedule.maxIterations > 100 ||
    !Number.isInteger(schedule.reportIntervalSeconds) ||
    schedule.reportIntervalSeconds < 1 ||
    schedule.reportIntervalSeconds > 10 ||
    !Number.isInteger(schedule.durationMs) ||
    schedule.durationMs < 1000 ||
    schedule.durationMs > 60000 ||
    !Array.isArray(schedule.changes) ||
    schedule.changes.length > 100
  )
    throw Error("阶段压测调度无效");
  let previous = 0;
  let maximum = schedule.initialVUs;
  for (const change of schedule.changes) {
    if (
      !change ||
      !Number.isInteger(change.atMs) ||
      change.atMs < previous ||
      change.atMs > schedule.durationMs ||
      !Number.isInteger(change.vus) ||
      change.vus < 0 ||
      change.vus > 10
    )
      throw Error("阶段压测调度无效");
    previous = change.atMs;
    maximum = Math.max(maximum, change.vus);
  }
  if (!maximum) throw Error("阶段压测至少需要一个 VU");
  return schedule;
}

function admitPlan(plan, schedule) {
  const snapshot = snapshotPlan(plan, { allowRuntimeRows: true });
  // Even disabled live references must be frozen by the server first.
  for (const step of planLeaves(snapshot.steps))
    if (liveRequestId(step) !== undefined)
      throw Error("实时计划须先在项目快照中冻结引用");
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024)
    throw Error("阶段压测计划快照超过 1 MiB");
  const leaves = activePlanLeaves(snapshot.steps, { allowRuntimeRows: true });
  // Preserve legacy linear metadata admission; control graphs alone need the
  // strict model validator and multiplicity calculation.
  const worstCaseSteps = hasRepeatSteps(snapshot.steps)
    ? potentialPlanStepCount(snapshot, { allowRuntimeRows: true })
    : leaves.length;
  if (
    !leaves.length ||
    worstCaseSteps < 1 ||
    worstCaseSteps > 10 ||
    leaves.some(
      (step) =>
        (step.type !== undefined && step.type !== "http") || !step.request,
    )
  )
    throw Error("阶段压测仅支持至多 10 个展开后的启用 HTTP 步骤");
  if (worstCaseSteps * schedule.maxIterations > 100)
    throw Error("最大展开步骤数乘迭代上限不得超过 100");
  for (const { request } of leaves) {
    if (normalizeRedirect(request.redirect))
      throw Error("阶段压测暂不支持重定向策略");
  }
  denyNativeWrites(leaves.map((step) => step.request));
  // Runtime rows must admit all potential work before their producer runs.
  // Keep legacy no-runtime-row DB failure timing in the existing runner.
  if (hasRuntimeRows(snapshot.steps, { activeOnly: true })) {
    const requirements = analyzePlanRequirements(snapshot, {
      allowRuntimeRows: true,
    });
    if (requirements.executorTypes.some((type) => type !== "http"))
      throw Error("阶段压测仅支持 HTTP，不能执行数据库操作");
  }
  return snapshot;
}

// Bindings on disabled leaves still belong to the admitted graph. Prepared
// objects confer no authority: check again against the execution project before
// reading environment/debug scopes, creating timers or running any iteration.
function admitCollections(project, snapshot) {
  const ids = new Set();
  for (const step of planLeaves(snapshot.steps)) {
    const id = step.request?.postmanCollectionId;
    if (id !== undefined) ids.add(collectionIdentifier(id));
  }
  if (ids.size) {
    validatePostmanCollections(project);
    const available = new Set(
      project.postmanCollections?.items.map((item) => item.id),
    );
    for (const id of ids)
      if (!available.has(id))
        throw Error("Postman collection 引用不存在于当前项目");
  }
  return [...ids];
}

export function prepareStagedLoad(project, plan, input, options = {}) {
  const schedule = buildLoadSchedule(input);
  const snapshot = admitPlan(plan, schedule);
  admitCollections(project, snapshot);
  const selected = selectedEnvironment(
    project,
    options.environmentId || snapshot.environmentId,
  );
  return { schedule, snapshot, selected };
}

export async function runStagedLoad(project, prepared, options = {}) {
  const schedule = admitSchedule(prepared.schedule);
  const snapshot = admitPlan(prepared.snapshot, schedule);
  // Capture only referenced collections once at run start. runPlan deep-copies
  // these into a private session for each iteration; no persistence hook exists.
  const collectionScopes = admitCollections(project, snapshot).map((id) =>
    collectionScope(project, id),
  );
  const runtimeRowsEnabled = hasRuntimeRows(snapshot.steps, {
    activeOnly: true,
  });
  const selected = selectedEnvironment(project, prepared.selected?.id);
  const variables =
    options.variables || environmentVariables(project, selected.id);
  const scopes = projectScopes(project, selected.id, variables);
  const controller = new AbortController();
  const slots = Array.from({ length: 10 }, () => ({
    active: false,
    running: false,
  }));
  const timers = [];
  let deadlineTimer, reportTimer;
  const samples = new Map(
    activePlanLeaves(snapshot.steps, { allowRuntimeRows: true }).map((step) => [
      step.id,
      { count: 0, failed: 0, durations: [], receivedBytes: 0 },
    ]),
  );
  const start = performance.now();
  let started = 0,
    completed = 0,
    failed = 0,
    active = 0,
    running = 0,
    mainRequests = 0;
  // Fixed aggregate vocabulary only. Never expose source values or core errors.
  const iterationOutcomes = {
    passed: 0,
    failed: 0,
    cancelled: 0,
    runtimeRowsInvalid: 0,
    executionError: 0,
  };
  let stopReason;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const percentile = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)
    ];
  };
  const report = () => {
    const elapsedMs = Math.max(0, Math.round(performance.now() - start));
    const totalStepCompletions = [...samples.values()].reduce(
      (sum, item) => sum + item.count,
      0,
    );
    const rate = (count) =>
      elapsedMs > 0 ? Math.round((count * 1000000) / elapsedMs) / 1000 : 0;
    return {
      elapsedMs,
      activeVUs: active,
      runningIterations: running,
      started,
      completed,
      failed,
      mainRequests,
      ...(runtimeRowsEnabled
        ? { iterationOutcomes: { ...iterationOutcomes } }
        : {}),
      stepCompletionsPerSecond: rate(totalStepCompletions),
      iterationsCompletedPerSecond: rate(completed),
      steps: [...samples].map(([stepId, item]) => ({
        stepId,
        count: item.count,
        failed: item.failed,
        timingSamples: item.durations.length,
        p50Ms: percentile(item.durations, 0.5),
        p90Ms: percentile(item.durations, 0.9),
        p95Ms: percentile(item.durations, 0.95),
        p99Ms: percentile(item.durations, 0.99),
        receivedBytes: item.receivedBytes,
      })),
    };
  };
  const finishIfDone = () => {
    if (stopReason && running === 0) resolveDone();
  };
  const stop = (reason, abort) => {
    if (stopReason && !(abort && stopReason === "iteration-limit")) return;
    stopReason = reason;
    for (const timer of timers) clearTimeout(timer);
    for (const slot of slots) slot.active = false;
    active = 0;
    if (abort) {
      clearTimeout(deadlineTimer);
      controller.abort();
    }
    finishIfDone();
  };
  const progress = () => {
    if (!options.onProgress) return;
    try {
      const returned = options.onProgress(report());
      if (returned && typeof returned.then === "function") {
        // This internal observer is synchronous. Handle a rejected promise so an
        // accidental async callback cannot escape as an unhandled rejection.
        Promise.resolve(returned).catch(() => {});
        stop("observer-failed", true);
      }
    } catch {
      stop("observer-failed", true);
    }
  };
  const loop = async (slot) => {
    slot.running = true;
    try {
      while (slot.active && !stopReason) {
        if (performance.now() - start >= schedule.durationMs) {
          stop("duration", true);
          break;
        }
        if (started >= schedule.maxIterations) {
          stop("iteration-limit", false);
          break;
        }
        const index = started++;
        running++;
        if (started === schedule.maxIterations) {
          // Finish already admitted iterations, but do not admit a replacement.
          stop("iteration-limit", false);
        }
        try {
          const result = await runPlan(
            snapshot,
            variables,
            async (definition, signal, transport) => {
              mainRequests++;
              return executeRequest(definition, signal, transport);
            },
            {
              allowRuntimeRows: true,
              signal: controller.signal,
              executionContext: {
                environment: {
                  id: String(selected.id),
                  name: String(selected.name || ""),
                },
                iteration: index,
                iterationCount: schedule.maxIterations,
                iterationData: {},
              },
              cookieSession: memoryCookieSession(options.cookieState),
              collectionScopes,
              variableScopes: structuredClone(scopes),
              prepareRequest: (definition) =>
                resolveServiceRequest(project, definition, selected.id),
              onStep: (record) => {
                const item = samples.get(record.stepId);
                if (!item) return;
                item.count++;
                if (record.status !== "passed") item.failed++;
                const size = record.response?.size;
                if (Number.isSafeInteger(size) && size >= 0)
                  item.receivedBytes += size;
                const duration = record.response?.duration;
                if (
                  typeof duration === "number" &&
                  Number.isFinite(duration) &&
                  duration >= 0
                )
                  item.durations.push(duration);
              },
            },
          );
          completed++;
          if (result.status !== "passed") failed++;
          const outcome =
            result.status === "cancelled"
              ? "cancelled"
              : result.runtimeRowsFailure?.code === "PLAN_RUNTIME_ROWS_INVALID"
                ? "runtimeRowsInvalid"
                : result.status === "passed"
                  ? "passed"
                  : "failed";
          iterationOutcomes[outcome]++;
        } catch {
          completed++;
          failed++;
          iterationOutcomes[
            controller.signal.aborted ? "cancelled" : "executionError"
          ]++;
        } finally {
          running--;
          progress();
          finishIfDone();
        }
      }
    } finally {
      slot.running = false;
      finishIfDone();
    }
  };
  const reconcile = (count) => {
    if (stopReason) return;
    active = count;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      slot.active = i < count;
      if (slot.active && !slot.running) void loop(slot);
    }
    progress();
  };
  const cancelled = () => stop("cancelled", true);
  options.signal?.addEventListener("abort", cancelled, { once: true });
  try {
    if (options.signal?.aborted) cancelled();
    if (!stopReason) {
      const reconcileAtCurrentTime = () => {
        const elapsed = performance.now() - start;
        if (elapsed >= schedule.durationMs) {
          stop("duration", true);
          return;
        }
        let current = schedule.initialVUs;
        for (const change of schedule.changes) {
          if (change.atMs > elapsed) break;
          current = change.vus;
        }
        if (current !== active) reconcile(current);
      };
      const scheduleChange = (change) => {
        const trigger = () => {
          if (stopReason) return;
          const remaining = change.atMs - (performance.now() - start);
          if (remaining > 0) {
            timers.push(setTimeout(trigger, Math.max(1, Math.ceil(remaining))));
            return;
          }
          reconcileAtCurrentTime();
        };
        timers.push(setTimeout(trigger, change.atMs));
      };
      for (const change of schedule.changes)
        if (change.atMs < schedule.durationMs) scheduleChange(change);
      const checkDeadline = () => {
        if (stopReason && stopReason !== "iteration-limit") return;
        const remaining = schedule.durationMs - (performance.now() - start);
        if (remaining > 0) {
          deadlineTimer = setTimeout(
            checkDeadline,
            Math.max(1, Math.ceil(remaining)),
          );
          return;
        }
        stop("duration", true);
      };
      deadlineTimer = setTimeout(checkDeadline, schedule.durationMs);
      reportTimer = setInterval(
        progress,
        schedule.reportIntervalSeconds * 1000,
      );
      reconcile(schedule.initialVUs);
    }
    await done;
    return {
      ...report(),
      stopReason,
      cancelled: stopReason === "cancelled",
      variableIsolation: "per-iteration",
    };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    clearTimeout(deadlineTimer);
    clearInterval(reportTimer);
    options.signal?.removeEventListener("abort", cancelled);
  }
}
