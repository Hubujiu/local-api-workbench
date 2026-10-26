// Official MIT-licensed SDK framing; application-specific lifecycle stays bounded.
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import { MCPHTTPSessions } from "./mcp-http-sessions.mjs";

const executionTools = new Set([
  "localapi_execute_api",
  "localapi_execute_flow",
  "localapi_run_plan",
  "apipost_execute_api",
  "apipost_execute_flow",
]);
const rpcError = (id, message, code = -32603) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

export class BoundedMCPWriter {
  constructor(
    output,
    {
      maxFrameBytes = 8 * 1024 * 1024,
      maxQueuedBytes = 12 * 1024 * 1024,
      timeoutMs = 5000,
      onFailure = () => {},
    } = {},
  ) {
    Object.assign(this, {
      output,
      maxFrameBytes,
      maxQueuedBytes,
      timeoutMs,
      onFailure,
    });
    this.queue = [];
    this.bytes = 0;
    this.current = null;
    this.failure = null;
    this.onError = () => this.fail(Error("MCP stdout failed"));
    this.onClose = () => this.fail(Error("MCP stdout closed"));
    output.on("error", this.onError);
    output.on("close", this.onClose);
  }
  prepare(message) {
    if (this.failure) throw this.failure;
    const text = serializeMessage(message),
      bytes = Buffer.byteLength(text);
    if (bytes > this.maxFrameBytes)
      throw Error(
        "MCP response exceeds frame limit; inspect saved history, do not replay",
      );
    return { text, bytes };
  }
  send(message, options) {
    try {
      return this.enqueue(this.prepare(message), options);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  enqueue({ text, bytes }, { shouldSend = () => true } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (bytes + this.bytes > this.maxQueuedBytes) {
      this.fail(Error("MCP output queue exhausted"));
      return Promise.reject(this.failure);
    }
    this.bytes += bytes;
    return new Promise((resolve, reject) => {
      this.queue.push({ text, bytes, resolve, reject, shouldSend });
      this.pump();
    });
  }
  pump() {
    if (this.current || this.failure || !this.queue.length) return;
    const entry = (this.current = this.queue.shift());
    if (!entry.shouldSend()) {
      this.current = null;
      this.bytes -= entry.bytes;
      entry.resolve();
      this.pump();
      return;
    }
    entry.timer = setTimeout(
      () => this.fail(Error("MCP stdout write timed out")),
      this.timeoutMs,
    );
    try {
      // Wait for the write callback, including when write() reports backpressure.
      this.output.write(entry.text, (error) => {
        if (this.current !== entry) return;
        if (error) {
          this.fail(Error("MCP stdout write failed"));
          return;
        }
        clearTimeout(entry.timer);
        this.current = null;
        this.bytes -= entry.bytes;
        entry.resolve();
        this.pump();
      });
    } catch {
      this.fail(Error("MCP stdout write failed"));
    }
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    const entries = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue = [];
    this.bytes = 0;
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.output.destroy?.();
    this.onFailure(error);
  }
  dispose() {
    this.output.off("error", this.onError);
    this.output.off("close", this.onClose);
  }
}

export async function serveMCPStdio({
  input,
  output,
  dispatch,
  activityFactory = () => undefined,
  maxHandlers = 32,
  maxTools = 10,
  maxInputBytes = 12 * 1024 * 1024,
  writerOptions = {},
}) {
  const registry = new MCPHTTPSessions({ maxSessions: 1, idleMs: Infinity });
  const session = registry.create();
  const buffer = new ReadBuffer({ maxBufferSize: maxInputBytes });
  const pending = new Set();
  let tools = 0,
    ending = false,
    failure,
    tailBytes = 0,
    resolveDone,
    rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Attach rejection handling immediately; callers still receive the original failure.
  done.catch(() => {});
  const stop = (error) => {
    if (ending) {
      failure ||= error;
      return;
    }
    ending = true;
    failure = error;
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onError);
    input.off("close", onClose);
    input.pause();
    buffer.clear();
    registry.advance({ dropSessions: true });
    void (async () => {
      await Promise.allSettled([...pending]);
      writer.dispose();
      failure ? rejectDone(failure) : resolveDone();
    })();
  };
  const writer = new BoundedMCPWriter(output, {
    ...writerOptions,
    onFailure: stop,
  });
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
  };
  const sendFailure = (message) => {
    if (pending.size >= maxHandlers) {
      stop(Error("MCP pending handler limit exceeded"));
      return;
    }
    track(writer.send(message).catch(stop));
  };
  const handle = async (message, lease, isTool, cancellable) => {
    let activity,
      answer,
      executionStatus,
      recordSaved,
      replyStarted = false;
    try {
      if (cancellable) {
        activity = activityFactory(message);
        await activity?.start();
      }
      answer = await dispatch(message, {
        signal: lease.signal,
        onProgress: (progress) => activity?.update(progress),
      });
      let result;
      try {
        result = JSON.parse(answer?.result?.content?.[0]?.text);
      } catch {}
      executionStatus = cancellable ? result?.status : undefined;
      recordSaved = cancellable
        ? (result?.recordSaved ?? result?.record_saved)
        : undefined;
      const frame =
        answer && !lease.cancelledByNotification
          ? writer.prepare(answer)
          : undefined;
      await activity?.finish(Boolean(answer?.result?.isError), {
        status: executionStatus,
        recordSaved,
      });
      if (frame && !lease.cancelledByNotification) {
        replyStarted = true;
        await writer.enqueue(frame, {
          shouldSend: () => !lease.cancelledByNotification,
        });
      }
    } catch {
      await activity
        ?.finish(true, { status: executionStatus, recordSaved })
        .catch(() => {});
      if (!replyStarted && !lease.cancelledByNotification && !writer.failure)
        await writer
          .send(
            rpcError(
              message.id,
              "Execution/progress/output failed; inspect history, do not replay",
            ),
            { shouldSend: () => !lease.cancelledByNotification },
          )
          .catch(stop);
    } finally {
      lease.finish();
      if (isTool) tools--;
    }
  };
  const route = (message) => {
    if (typeof message.method !== "string") return; // No server-initiated requests to match responses.
    if (message.id === undefined) {
      if (message.method === "notifications/cancelled")
        registry.cancel(session, message.params?.requestId);
      return;
    }
    if (pending.size >= maxHandlers) {
      stop(Error("MCP pending handler limit exceeded"));
      return;
    }
    const isTool = message.method === "tools/call";
    const cancellable = isTool && executionTools.has(message.params?.name);
    let lease;
    try {
      lease = registry.begin(session, message.id, cancellable);
    } catch {
      sendFailure(
        rpcError(
          message.id,
          "Invalid/reused request ID or session request limit; restart stdio session",
          -32600,
        ),
      );
      return;
    }
    if (isTool && tools >= maxTools) {
      lease.finish();
      sendFailure(
        rpcError(message.id, "MCP concurrent tool limit reached", -32000),
      );
      return;
    }
    if (isTool) tools++;
    // handle() starts synchronously through its first await; lease is already registered.
    track(handle(message, lease, isTool, cancellable));
  };
  function onData(chunk) {
    if (ending) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const newline = bytes.lastIndexOf(10);
    tailBytes =
      newline < 0 ? tailBytes + bytes.length : bytes.length - newline - 1;
    try {
      buffer.append(bytes);
    } catch {
      stop(Error("MCP input exceeds bounded buffer"));
      return;
    }
    while (!ending) {
      let message;
      try {
        message = buffer.readMessage();
      } catch {
        sendFailure(rpcError(null, "Invalid JSON-RPC input", -32700));
        continue;
      }
      if (message === null) break;
      route(message);
    }
  }
  function onEnd() {
    stop(tailBytes ? Error("Incomplete MCP input at EOF") : undefined);
  }
  function onError() {
    stop(Error("MCP stdin failed"));
  }
  function onClose() {
    stop(Error("MCP stdin closed"));
  }
  input.on("data", onData);
  input.once("end", onEnd);
  input.once("error", onError);
  input.once("close", onClose);
  if (input.readableEnded) onEnd();
  else if (input.destroyed) onClose();
  return done;
}
