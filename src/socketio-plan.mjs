import { planLeaves, activePlanLeaves } from "./plan-repeat.mjs";
import { randomUUID } from "node:crypto";
import {
  SocketIOSessions,
  normalizeSocketIODefinition,
  validateSocketIOConnection,
  validateSocketIOEvent,
  validateSocketIOArgs,
} from "./socketio.mjs";
import { jsonPathSegments } from "./json-path.mjs";
const plain = (x) =>
  x !== null &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
function commands(input) {
  if (
    !Array.isArray(input) ||
    input.length > 100 ||
    Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024
  )
    throw Error("Socket.IO计划命令最多100项及1MiB");
  return input.map((c) => {
    if (!plain(c) || !["emit", "wait", "ack"].includes(c.type))
      throw Error("Socket.IO计划仅支持emit/wait/ack");
    const allowed =
      c.type === "emit"
        ? ["type", "event", "args", "ackTimeoutMs"]
        : c.type === "wait"
          ? ["type", "event", "timeoutMs"]
          : ["type", "args"];
    if (Object.keys(c).some((k) => !allowed.includes(k)))
      throw Error("Socket.IO计划命令字段无效");
    if (c.type !== "ack") validateSocketIOEvent(c.event);
    if (c.type !== "wait") validateSocketIOArgs(c.args);
    const timeout =
      c.type === "emit"
        ? c.ackTimeoutMs
        : c.type === "wait"
          ? (c.timeoutMs ?? 5000)
          : undefined;
    if (
      timeout !== undefined &&
      (!Number.isInteger(timeout) || timeout < 50 || timeout > 30000)
    )
      throw Error("Socket.IO命令超时须为50至30000毫秒");
    return {
      ...structuredClone(c),
      ...(c.type === "wait" ? { timeoutMs: timeout } : {}),
    };
  });
}
export function snapshotSocketIOStep(step) {
  if (
    Object.keys(step).some(
      (k) =>
        ![
          "id",
          "name",
          "enabled",
          "type",
          "socketio",
          "extract",
          "assertions",
          "expectedStatus",
        ].includes(k),
    ) ||
    !plain(step.socketio) ||
    Object.keys(step.socketio).some(
      (k) => !["definition", "commands", "timeoutMs"].includes(k),
    )
  )
    throw Error("Socket.IO计划只接受冻结定义和命令，不保存凭据或脚本");
  const definition = normalizeSocketIODefinition(step.socketio.definition);
  const timeoutMs = step.socketio.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000)
    throw Error("Socket.IO计划整体超时须为50至30000毫秒");
  const expectedStatus = step.expectedStatus ?? "passed";
  if (!["passed", "failed"].includes(expectedStatus))
    throw Error("Socket.IO计划预期状态须为passed/failed");
  const extract = step.extract ?? [],
    assertions = step.assertions ?? [];
  if (
    !Array.isArray(extract) ||
    extract.length > 100 ||
    !Array.isArray(assertions) ||
    assertions.length > 100
  )
    throw Error("Socket.IO计划提取和断言最多100项");
  for (const e of extract) {
    if (
      !plain(e) ||
      Object.keys(e).some((k) => !["name", "path", "scope"].includes(k)) ||
      typeof e.name !== "string" ||
      !e.name.trim() ||
      e.name.length > 100 ||
      ["__proto__", "constructor", "prototype"].includes(e.name) ||
      typeof e.path !== "string" ||
      (e.scope !== undefined &&
        !["runtime", "environment", "global"].includes(e.scope))
    )
      throw Error("Socket.IO提取字段无效");
    jsonPathSegments(e.path);
  }
  for (const a of assertions) {
    if (
      !plain(a) ||
      Object.keys(a).some((k) => !["target", "op", "value"].includes(k)) ||
      typeof a.target !== "string" ||
      !["eq", "neq", "contains", "exists", "lt", "gt"].includes(a.op) ||
      !(
        a.target === "status" ||
        a.target === "duration" ||
        a.target.startsWith("$")
      )
    )
      throw Error("Socket.IO断言字段无效");
    if (a.target.startsWith("$")) jsonPathSegments(a.target);
  }
  const normalizedCommands = commands(step.socketio.commands ?? []);
  if (
    definition.events &&
    normalizedCommands.some(
      (c) => c.type === "wait" && !definition.events.includes(c.event),
    )
  )
    throw Error("Socket.IO计划等待事件未在监听过滤器中启用");
  return {
    ...structuredClone(step),
    socketio: {
      definition,
      commands: normalizedCommands,
      timeoutMs,
    },
    extract: structuredClone(extract),
    assertions: structuredClone(assertions),
    expectedStatus,
  };
}
export function freezeSocketIOStep(project, step) {
  if (!step.socketio?.definitionId) return step;
  if (step.socketio.definition)
    throw Error("Socket.IO计划定义与引用不能同时存在");
  const definition = (project.settings?.socketioDefinitions || []).find(
    (d) => d.id === step.socketio.definitionId,
  );
  if (!definition) throw Error("项目Socket.IO定义不存在");
  const { definitionId, ...rest } = step.socketio;
  return {
    ...step,
    socketio: { ...rest, definition: structuredClone(definition) },
  };
}
export function socketioPlanCredentials(plan, input = {}) {
  if (!plain(input) || Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024)
    throw Error("Socket.IO临时凭据映射无效或超限");
  const result = new Map();
  for (const [id, value] of Object.entries(input)) {
    const steps = planLeaves(plan.steps).filter((s) => s.id === id);
    if (
      steps.length !== 1 ||
      steps[0].type !== "socketio" ||
      !plain(value) ||
      Object.keys(value).some(
        (k) => !["auth", "query", "headers", "tls"].includes(k),
      )
    )
      throw Error("Socket.IO临时凭据步骤或字段无效");
    validateSocketIOConnection({ ...steps[0].socketio.definition, ...value });
    result.set(id, structuredClone(value));
  }
  for (const step of activePlanLeaves(plan.steps))
    if (step.type === "socketio")
      validateSocketIOConnection({
        ...step.socketio.definition,
        ...result.get(step.id),
      });
  return result;
}
function awaitState(
  sessions,
  projectId,
  id,
  { event, after = 0, timeoutMs, signal },
) {
  const s = sessions.get(projectId, id);
  const inspect = () =>
    event
      ? s.events.find(
          (e) =>
            e.direction === "received" &&
            e.event === event &&
            e.sequence > after,
        )
      : s.state === "open";
  return new Promise((resolve, reject) => {
    const socket = s.socket;
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      socket?.off("connect", check);
      socket?.off("connect_error", check);
      socket?.off("disconnect", check);
      socket?.offAny(check);
    };
    const finish = (error, value) => {
      if (done) return;
      done = true;
      cleanup();
      error ? reject(error) : resolve(value);
    };
    const check = () => {
      if (signal?.aborted) return finish(Error("Socket.IO计划已取消"));
      const value = inspect();
      if (value) return finish(null, value);
      if (["closed", "error"].includes(s.state))
        finish(Error(s.error || "Socket.IO连接已关闭"));
    };
    const aborted = () => finish(Error("Socket.IO计划已取消"));
    const timer = setTimeout(
      () => finish(Error("Socket.IO等待超时")),
      Math.max(1, timeoutMs),
    );
    signal?.addEventListener("abort", aborted, { once: true });
    socket?.on("connect", check);
    socket?.on("connect_error", check);
    socket?.on("disconnect", check);
    socket?.onAny(check);
    check();
  });
}
export async function executeSocketIOFlow(
  input,
  signal,
  { sessions, projectId = "plan" } = {},
) {
  if (
    !plain(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          "definition",
          "commands",
          "timeoutMs",
          "auth",
          "query",
          "headers",
          "tls",
        ].includes(k),
    )
  )
    throw Error("Socket.IO计划执行字段无效");
  const step = snapshotSocketIOStep({
    type: "socketio",
    socketio: {
      definition: input.definition,
      commands: input.commands,
      timeoutMs: input.timeoutMs,
    },
  });
  const flow = step.socketio,
    credentials = Object.fromEntries(
      ["auth", "query", "headers", "tls"]
        .filter((k) => input[k] !== undefined)
        .map((k) => [k, input[k]]),
    );
  validateSocketIOConnection({ ...flow.definition, ...credentials });
  const own = !sessions;
  sessions ||= new SocketIOSessions();
  const started = performance.now(),
    results = [];
  let sessionId,
    timer,
    timedOut = false,
    resultTruncated = false,
    error,
    status = "passed";
  const stop = () => {
    if (sessionId) sessions.stop(projectId, sessionId);
  };
  const abort = () => stop();
  const remaining = () =>
    Math.max(0, flow.timeoutMs - (performance.now() - started));
  let snapshot;
  try {
    if (signal?.aborted) throw Error("Socket.IO计划已取消");
    const session = sessions.start(projectId, {
      ...flow.definition,
      ...credentials,
      connectTimeoutMs: flow.timeoutMs,
    });
    sessionId = session.id;
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, remaining());
    await awaitState(sessions, projectId, sessionId, {
      timeoutMs: remaining(),
      signal,
    });
    let cursor = 0,
      pendingAck = null;
    for (const c of flow.commands) {
      if (signal?.aborted || timedOut || remaining() < 1)
        throw Error("Socket.IO计划已取消或整体超时");
      let result;
      const commandStarted = performance.now();
      if (c.type === "emit") {
        cursor = sessions.get(projectId, sessionId).sequence;
        const ackTimeoutMs =
          c.ackTimeoutMs === undefined
            ? undefined
            : Math.min(c.ackTimeoutMs, Math.floor(remaining()));
        if (ackTimeoutMs !== undefined && ackTimeoutMs < 50)
          throw Error("Socket.IO计划剩余确认时间不足");
        result = await sessions.send(projectId, sessionId, {
          event: c.event,
          args: c.args,
          ...(ackTimeoutMs !== undefined ? { ackTimeoutMs } : {}),
        });
      } else if (c.type === "ack") {
        if (!pendingAck) throw Error("Socket.IO计划没有可确认的上一个等待事件");
        sessions.acknowledge(projectId, sessionId, {
          ackId: pendingAck,
          args: c.args,
        });
        pendingAck = null;
        result = { status: "ack-sent", remoteOutcome: "unknown" };
      } else {
        const event = await awaitState(sessions, projectId, sessionId, {
          event: c.event,
          after: cursor,
          timeoutMs: Math.min(c.timeoutMs, remaining()),
          signal,
        });
        cursor = event.sequence;
        pendingAck = event.ackId || null;
        result = { status: "received", event: event.event, args: event.args };
      }
      result = {
        ...result,
        commandIndex: results.length,
        type: c.type,
        ...(c.event ? { event: c.event } : {}),
        durationMs: performance.now() - commandStarted,
      };
      if (
        Buffer.byteLength(JSON.stringify([...results, result])) >
        2 * 1024 * 1024
      ) {
        resultTruncated = true;
        throw Error("Socket.IO计划结果超过2MiB");
      }
      results.push(result);
      if (
        !["sent", "ack-sent", "acknowledged", "received"].includes(
          result.status,
        )
      )
        throw Error("Socket.IO命令未完成：" + result.status);
    }
  } catch (e) {
    error = String(e.message || e);
    status = signal?.aborted ? "cancelled" : "failed";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (sessionId) snapshot = sessions.stop(projectId, sessionId);
    if (own) sessions.close();
  }
  if (signal?.aborted) status = "cancelled";
  else if (timedOut) {
    status = "failed";
    error = "Socket.IO计划整体超时";
  }
  return {
    id: randomUUID(),
    sessionId,
    status,
    state: snapshot?.state || "closed",
    results,
    events: snapshot?.events || [],
    truncated: resultTruncated || snapshot?.truncated || false,
    resultTruncated,
    error,
    durationMs: performance.now() - started,
  };
}
