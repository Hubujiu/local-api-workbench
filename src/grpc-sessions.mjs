import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import * as grpc from "@grpc/grpc-js";
import {
  GRPC_MAX_BYTES,
  normalizeGrpcDefinition,
  selectGrpcMethod,
  prepareGrpcMessage,
  grpcTransport,
  createGrpcClient,
} from "./grpc.mjs";
import { GrpcSlots } from "./grpc-slots.mjs";
import {
  grpcSessionHash,
  makeGrpcSessionRecord,
  finalizeGrpcSession,
  grpcSessionMessageBytes,
} from "./grpc-session-evidence.mjs";
import { recordSaveFailure, recordSaveSuccess } from "./execution-evidence.mjs";

const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeDetails = (value) => {
  const text = String(value).toWellFormed().slice(0, 2000);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
};
const status = (code, details = "") => ({
  code:
    Number.isInteger(code) && code >= 0 && code <= 16
      ? code
      : grpc.status.UNKNOWN,
  details: safeDetails(details),
});

export class GrpcSessions {
  constructor({
    store,
    slots = new GrpcSlots(),
    createClient = createGrpcClient,
  } = {}) {
    this.store = store;
    this.slots = slots;
    this.createClient = createClient;
    this.sessions = new Map();
    this.closing = false;
  }
  get(projectId, id) {
    const session = this.sessions.get(id);
    if (!session || session.projectId !== projectId)
      throw Error("gRPC会话不存在或不属于此项目");
    return session;
  }
  snapshot(projectId, id) {
    const s = this.get(projectId, id);
    return structuredClone({
      ...(s.finalSnapshot || {
        ...s.view,
        durationMs: Math.max(0, performance.now() - s.started),
      }),
      projectId,
      receiptState: s.receiptState,
      ...(s.receipt || {
        recordSaved: false,
        recordId: null,
        attemptedRecordId: null,
      }),
    });
  }
  start(projectId, source, input = {}) {
    if (this.closing) throw Error("gRPC会话管理器正在关闭");
    if (
      !plain(input) ||
      Object.keys(input).some(
        (key) => !["message", "metadata", "tls"].includes(key),
      )
    )
      throw Error("gRPC会话创建字段无效");
    const definition = normalizeGrpcDefinition(structuredClone(source));
    const selected = selectGrpcMethod(definition),
      { desc } = selected;
    if (!desc.requestStream && !desc.responseStream)
      throw Error("交互gRPC会话仅支持流式方法；unary请使用grpc-run");
    if (desc.requestStream && Object.hasOwn(input, "message"))
      throw Error("客户端流式会话须显式send，不接受初始message");
    const initial = desc.requestStream
      ? null
      : prepareGrpcMessage(selected, input.message);
    const transport = grpcTransport(definition.target, input);
    if (this.sessions.size >= 50)
      for (const [id, old] of this.sessions) {
        if (old.view.lifecycle === "terminal" && old.receiptState === "saved")
          this.sessions.delete(id);
        if (this.sessions.size < 50) break;
      }
    if (this.sessions.size >= 50) throw Error("gRPC会话证据已达到50条上限");
    const release = this.slots.acquire(),
      createdAt = new Date().toISOString();
    const s = {
      id: randomUUID(),
      projectId,
      definition,
      selected,
      release,
      started: performance.now(),
      receiptState: null,
      receipt: null,
      recordPromise: null,
      pending: null,
      call: null,
      client: null,
    };
    s.view = {
      id: s.id,
      type: "grpc",
      definitionId: definition.id,
      definitionHash: grpcSessionHash(definition),
      lifecycle: "active",
      requestState: desc.requestStream ? "writable" : "halfClosed",
      createdAt,
      finishedAt: null,
      durationMs: 0,
      deadlineAt: new Date(
        Date.parse(createdAt) + definition.timeoutMs,
      ).toISOString(),
      service: definition.service,
      method: definition.method,
      path: desc.path,
      streaming: { request: desc.requestStream, response: desc.responseStream },
      requestMessages: initial
        ? [{ ...initial, sendState: "submitted", at: createdAt }]
        : [],
      messages: [],
      requestBytes: initial?.jsonBytes || 0,
      requestWireBytes: initial?.wireBytes || 0,
      responseBytes: 0,
      status: null,
      remoteStatus: null,
      terminationReason: null,
      truncated: false,
      callback: null,
      responseEnded: false,
      transportError: null,
    };
    this.sessions.set(s.id, s);
    s.timer = setTimeout(
      () =>
        this.finish(
          s,
          status(grpc.status.DEADLINE_EXCEEDED, "gRPC会话总期限已到"),
          "deadline",
        ),
      definition.timeoutMs,
    );
    const callback = (error, message) => {
      this.checkDeadline(s);
      if (s.view.lifecycle !== "active") return;
      s.view.callback = {
        ...status(
          error
            ? error.code
            : message === undefined
              ? grpc.status.UNIMPLEMENTED
              : 0,
          error
            ? error.details || error.message
            : message === undefined
              ? "gRPC客户端流未收到响应"
              : "",
        ),
        responseReceived: message !== undefined,
      };
      if (!error && message !== undefined) this.receive(s, message);
      this.maybeComplete(s);
    };
    try {
      s.client = this.createClient(transport.address, transport.credentials);
      const args = [desc.path, desc.requestSerialize, desc.responseDeserialize];
      const options = { deadline: new Date(s.view.deadlineAt) };
      if (!desc.requestStream)
        s.call = s.client.makeServerStreamRequest(
          ...args,
          initial.message,
          transport.metadata,
          options,
        );
      else if (!desc.responseStream)
        s.call = s.client.makeClientStreamRequest(
          ...args,
          transport.metadata,
          options,
          callback,
        );
      else
        s.call = s.client.makeBidiStreamRequest(
          ...args,
          transport.metadata,
          options,
        );
      s.call.on("error", (error) => {
        this.checkDeadline(s);
        if (s.view.lifecycle !== "active") return;
        s.view.transportError = status(
          error.code,
          error.details || error.message,
        );
        this.maybeComplete(s);
      });
      s.call.on("status", (value) => {
        this.checkDeadline(s);
        if (s.view.lifecycle !== "active") return;
        s.view.remoteStatus = status(value.code, value.details);
        this.maybeComplete(s);
      });
      if (desc.responseStream) {
        s.call.on("data", (message) => this.receive(s, message));
        s.call.on("end", () => {
          this.checkDeadline(s);
          if (s.view.lifecycle !== "active") return;
          s.view.responseEnded = true;
          this.maybeComplete(s);
        });
      }
      if (s.view.lifecycle === "terminal") s.call.cancel();
    } catch {
      this.finish(s, status(grpc.status.UNKNOWN, "gRPC传输创建失败"), "error");
    }
    return this.snapshot(projectId, s.id);
  }
  receive(s, message) {
    this.checkDeadline(s);
    if (s.view.lifecycle !== "active") return;
    let json, bytes;
    try {
      // Admission and persisted evidence use exactly the same JSON constraints.
      bytes = grpcSessionMessageBytes(message);
      json = JSON.stringify(message);
    } catch {
      this.finish(
        s,
        status(grpc.status.DATA_LOSS, "gRPC响应不能表示为JSON证据"),
        "error",
      );
      return;
    }
    this.checkDeadline(s);
    if (s.view.lifecycle !== "active") return;
    if (
      s.view.messages.length >= 100 ||
      s.view.responseBytes + bytes > GRPC_MAX_BYTES
    ) {
      s.view.truncated = true;
      this.finish(
        s,
        status(grpc.status.RESOURCE_EXHAUSTED, "gRPC响应超过100条或1MiB"),
        "limit",
      );
      return;
    }
    s.view.messages.push(JSON.parse(json));
    s.view.responseBytes += bytes;
  }
  maybeComplete(s) {
    this.checkDeadline(s);
    const v = s.view;
    if (v.lifecycle !== "active" || !v.remoteStatus) return;
    if (v.streaming.response ? !v.responseEnded : !v.callback) return;
    let outcome = v.remoteStatus;
    if (outcome.code === 0 && v.callback?.code) outcome = v.callback;
    if (outcome.code === 0 && v.transportError) outcome = v.transportError;
    if (
      outcome.code === 0 &&
      !v.streaming.response &&
      !v.callback.responseReceived
    )
      outcome = status(grpc.status.UNIMPLEMENTED, "gRPC客户端流未收到响应");
    this.finish(s, status(outcome.code, outcome.details), "remote");
  }
  checkDeadline(s) {
    if (
      s.view.lifecycle === "active" &&
      performance.now() - s.started >= s.definition.timeoutMs
    )
      this.finish(
        s,
        status(grpc.status.DEADLINE_EXCEEDED, "gRPC会话总期限已到"),
        "deadline",
      );
  }
  send(projectId, id, message) {
    const s = this.get(projectId, id),
      v = s.view;
    this.checkDeadline(s);
    if (
      this.closing ||
      v.lifecycle !== "active" ||
      v.requestState !== "writable" ||
      !v.streaming.request
    )
      throw Error("gRPC请求方向不可写");
    if (s.pending) throw Error("gRPC发送仍在等待本地回调或drain；不可重复发送");
    const prepared = prepareGrpcMessage(s.selected, message);
    this.checkDeadline(s);
    if (v.lifecycle !== "active") throw Error("gRPC会话总期限已到");
    if (
      v.requestMessages.length >= 100 ||
      v.requestBytes + prepared.jsonBytes > GRPC_MAX_BYTES ||
      v.requestWireBytes + prepared.wireBytes > GRPC_MAX_BYTES
    )
      throw Error("gRPC请求超过100条或1MiB");
    const entry = {
      ...prepared,
      sendState: "pending",
      at: new Date().toISOString(),
    };
    v.requestMessages.push(entry);
    v.requestBytes += prepared.jsonBytes;
    v.requestWireBytes += prepared.wireBytes;
    const pending = { callback: false, drained: false, returned: false };
    s.pending = pending;
    const complete = () => {
      this.checkDeadline(s);
      if (
        v.lifecycle !== "active" ||
        s.pending !== pending ||
        !pending.returned ||
        !pending.callback ||
        !pending.drained
      )
        return;
      entry.sendState = "accepted"; // Local callback/drain only, never a remote ack.
      s.pending = null;
      s.call.off("drain", onDrain);
    };
    const onDrain = () => {
      pending.drained = true;
      complete();
    };
    s.call.once("drain", onDrain);
    try {
      const ready = s.call.write(prepared.message, (error) => {
        if (v.lifecycle !== "active" || s.pending !== pending) return;
        if (error) {
          entry.sendState = "failed";
          s.pending = null;
          this.finish(
            s,
            status(grpc.status.UNKNOWN, "gRPC本地发送失败；远端结果未确认"),
            "error",
          );
          return;
        }
        pending.callback = true;
        complete();
      });
      pending.drained ||= ready;
      pending.returned = true;
      complete();
    } catch {
      entry.sendState = "failed";
      s.pending = null;
      this.finish(
        s,
        status(grpc.status.UNKNOWN, "gRPC本地发送失败；远端结果未确认"),
        "error",
      );
    }
    return this.snapshot(projectId, id);
  }
  halfClose(projectId, id) {
    const s = this.get(projectId, id),
      v = s.view;
    this.checkDeadline(s);
    if (
      this.closing ||
      v.lifecycle !== "active" ||
      v.requestState !== "writable" ||
      !v.streaming.request
    )
      throw Error("gRPC请求方向不能半关闭");
    if (s.pending) throw Error("gRPC发送未完成本地回调或drain，不能半关闭");
    v.requestState = "halfClosing";
    try {
      s.call.end((error) => {
        this.checkDeadline(s);
        if (v.lifecycle !== "active") return;
        if (error)
          this.finish(
            s,
            status(grpc.status.UNKNOWN, "gRPC请求方向关闭失败"),
            "error",
          );
        else v.requestState = "halfClosed";
      });
    } catch {
      this.finish(
        s,
        status(grpc.status.UNKNOWN, "gRPC请求方向关闭失败"),
        "error",
      );
    }
    return this.snapshot(projectId, id);
  }
  finish(s, outcome, reason) {
    if (s.view.lifecycle !== "active") return;
    const v = s.view;
    v.lifecycle = "terminating";
    clearTimeout(s.timer);
    for (const entry of v.requestMessages)
      if (entry.sendState === "pending") entry.sendState = "unknown";
    s.pending = null;
    if (v.requestState !== "halfClosed") v.requestState = "unavailable";
    v.status = outcome;
    v.terminationReason = reason;
    v.durationMs = Math.max(0, performance.now() - s.started);
    v.finishedAt = new Date().toISOString();
    v.lifecycle = "terminal";
    s.finalSnapshot = structuredClone(v);
    try {
      s.call?.cancel();
    } catch {
      /* Already terminal. */
    }
    try {
      s.client?.close();
    } catch {
      /* Evidence must still be saved. */
    }
    s.call = null;
    s.client = null;
    s.release();
    this.save(s);
  }
  save(s, retry = false) {
    if (s.view.lifecycle !== "terminal") throw Error("gRPC会话尚未终止");
    if (s.receiptState === "saved" || s.receiptState === "pending")
      return s.recordPromise;
    if (s.recordPromise && (!retry || this.closing)) return s.recordPromise;
    s.receiptState = "pending";
    s.recordPromise = Promise.resolve().then(async () => {
      try {
        s.finalRecord ??= makeGrpcSessionRecord(s.definition, s.finalSnapshot);
        await finalizeGrpcSession(this.store, s.projectId, s.finalRecord);
        s.receipt = recordSaveSuccess(s.id);
        s.receiptState = "saved";
      } catch (error) {
        s.receipt = recordSaveFailure(s.projectId, s.id, error);
        s.receiptState =
          s.receipt.persistenceOutcome.code === "PROJECT_COMMIT_UNCERTAIN"
            ? "unknown"
            : "failed";
      }
      return s.receipt;
    });
    return s.recordPromise;
  }
  async cancel(projectId, id) {
    const s = this.get(projectId, id),
      terminal = s.view.lifecycle === "terminal";
    this.finish(
      s,
      status(grpc.status.CANCELLED, "已取消；远端结果未确认"),
      "cancel",
    );
    await this.save(s, terminal);
    return this.snapshot(projectId, id);
  }
  async reconcile(projectId, id) {
    const s = this.get(projectId, id);
    if (s.view.lifecycle !== "terminal")
      throw Error("仅终态gRPC会话可核对保存");
    await this.save(s, true);
    return this.snapshot(projectId, id);
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const s of this.sessions.values())
      this.finish(
        s,
        status(grpc.status.CANCELLED, "应用正常关闭；远端结果未确认"),
        "shutdown",
      );
    return (this.closePromise = Promise.all(
      [...this.sessions.values()].map((s) => s.recordPromise),
    ).then(() =>
      [...this.sessions.values()].map((s) => ({
        projectId: s.projectId,
        sessionId: s.id,
        receiptState: s.receiptState,
        ...structuredClone(s.receipt),
      })),
    ));
  }
}
