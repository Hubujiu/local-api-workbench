const phases = new Set([
  "starting",
  "active",
  "sending",
  "stopping",
  "uncertain-start",
  "uncertain-send",
  "uncertain-stop",
  "closed",
]);
const live = (snapshot) =>
  snapshot && ["open", "connecting"].includes(snapshot.state);
const idValid = (id) =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const types = new Set(["tcp", "websocket", "sse"]);
export function createProtocolSessionController({
  api,
  storage,
  instanceId,
  onChange = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
  generateId = () => crypto.randomUUID(),
}) {
  const key = "local-api-protocol-intent-v1";
  let intentId = null,
    sessionId = null,
    type = null,
    snapshot = null,
    phase = "idle",
    warning = "",
    generation = 0,
    timer = null,
    pollingGeneration = null,
    storageBlocked = false,
    uncertainDelivery = false;
  const status = () => ({
    snapshot: snapshot ? structuredClone(snapshot) : null,
    phase,
    warning:
      warning + (uncertainDelivery ? "。此前发送的远端结果仍未确认" : ""),
    intentId,
    instanceId,
    uncertainDelivery,
    canConnect: !storageBlocked && ["idle", "closed"].includes(phase),
    canSend:
      !storageBlocked &&
      phase === "active" &&
      snapshot?.state === "open" &&
      type !== "sse",
    canStop: !!intentId && !["closed", "stopping"].includes(phase),
  });
  const emit = () => onChange(status());
  const clear = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  function persist() {
    try {
      storage.setItem(
        key,
        JSON.stringify({
          version: 1,
          instanceId,
          intentId,
          sessionId,
          type,
          phase,
          uncertainDelivery,
        }),
      );
      storageBlocked = false;
    } catch {
      storageBlocked = true;
      warning =
        "无法保存会话恢复标记，已禁止建立连接和发送；仍可尝试断开已知会话";
      throw Error(warning);
    }
  }
  function validSnapshot(value, expectedId = sessionId) {
    if (
      !value ||
      !idValid(value.id) ||
      (expectedId && value.id !== expectedId) ||
      value.type !== type ||
      !["connecting", "open", "closed", "error"].includes(value.state) ||
      !Array.isArray(value.events) ||
      value.events.some(
        (event) =>
          !event ||
          typeof event !== "object" ||
          typeof event.at !== "string" ||
          typeof event.direction !== "string" ||
          typeof event.data !== "string",
      )
    )
      throw Error("会话回执不完整或身份不匹配");
    return value;
  }
  function receipt(value) {
    if (
      !value ||
      value.instanceId !== instanceId ||
      value.intentId !== intentId ||
      !["started", "cancelled", "unknown", "expired"].includes(value.phase) ||
      value.retry_safe !== false
    )
      throw Error("连接意图回执不匹配");
    if (value.phase === "cancelled" && live(value.session))
      throw Error("取消回执仍显示活动会话");
    if (sessionId && value.sessionId !== sessionId)
      throw Error("会话身份不匹配");
    if (value.phase === "started" && value.session === null)
      throw Error("连接回执缺少会话");
    if (value.session !== null) {
      validSnapshot(value.session, value.sessionId);
      if (value.sessionId !== value.session.id) throw Error("会话身份不匹配");
    } else if (value.sessionId !== null && !idValid(value.sessionId))
      throw Error("会话身份无效");
    return value;
  }
  const endpoint = () => "/protocol-session-intents/" + intentId;
  const retainUnknown = (operation, error) => {
    phase = "uncertain-" + operation;
    if (operation === "send") uncertainDelivery = true;
    warning = error.message + "。结果未确认，不会自动重试；请核对或断开会话";
    try {
      persist();
    } catch {}
    emit();
  };
  function accept(value, { preserveUncertainty = false } = {}) {
    const result = receipt(value);
    if (result.session) {
      sessionId = result.sessionId;
      snapshot = structuredClone(result.session);
      if (
        snapshot.events.some(
          (event) =>
            event.direction === "sent" &&
            (["failed", "unknown"].includes(event.sendState) ||
              (!live(snapshot) && event.sendState === "queued")),
        )
      )
        uncertainDelivery = true;
    }
    if (result.phase === "cancelled" || result.phase === "expired") {
      phase = "closed";
      warning =
        result.phase === "expired"
          ? "会话证据已过期；旧远端结果不因过期而得到确认"
          : "";
    } else if (result.phase === "unknown") {
      phase = phase.startsWith("uncertain-") ? phase : "uncertain-start";
      warning = "连接结果未确认，不会自动重连；可尝试断开此意图";
    } else if (!preserveUncertainty) {
      phase = live(snapshot) ? "active" : "closed";
      warning = "";
    }
    persist();
    emit();
  }
  function arm() {
    clear();
    if (phase === "active" && live(snapshot))
      timer = schedule(() => {
        timer = null;
        void poll();
      }, 1000);
  }
  async function poll() {
    if (
      pollingGeneration === generation ||
      !intentId ||
      ["starting", "sending", "stopping", "closed", "idle"].includes(phase)
    )
      return;
    const epoch = generation,
      owned = intentId;
    pollingGeneration = epoch;
    try {
      const value = await api(endpoint());
      if (epoch !== generation || owned !== intentId) return;
      accept(value, { preserveUncertainty: phase.startsWith("uncertain-") });
    } catch (error) {
      if (epoch === generation) {
        warning = error.message + "。读取失败，未自动重连或重发";
        emit();
      }
    } finally {
      if (pollingGeneration === epoch) pollingGeneration = null;
      if (epoch === generation) arm();
    }
  }
  async function connect(definition) {
    if (!status().canConnect)
      throw Error("连接尚未结束或结果未确认，请先断开当前意图");
    const owned = generateId();
    if (!idValid(owned) || !types.has(definition.type))
      throw Error("连接意图或协议无效");
    clear();
    const epoch = ++generation;
    intentId = owned;
    sessionId = null;
    snapshot = null;
    type = definition.type;
    phase = "starting";
    warning = "";
    try {
      persist();
    } catch (error) {
      phase = "uncertain-start";
      emit();
      throw error;
    }
    emit();
    try {
      const value = await api(endpoint(), "POST", {
        instanceId,
        definition: structuredClone(definition),
      });
      if (epoch !== generation) return;
      accept(value);
      arm();
    } catch (error) {
      if (epoch !== generation) return;
      retainUnknown("start", error);
      throw Error(warning);
    }
  }
  async function send(message) {
    if (!status().canSend)
      throw Error("当前会话不可发送，或上次发送结果尚未确认");
    clear();
    const epoch = ++generation,
      owned = sessionId;
    phase = "sending";
    try {
      persist();
    } catch (error) {
      phase = "uncertain-send";
      emit();
      throw error;
    }
    emit();
    try {
      const value = await api("/protocol-sessions/" + owned + "/send", "POST", {
        message,
      });
      if (epoch !== generation || owned !== sessionId) return;
      snapshot = structuredClone(validSnapshot(value, owned));
      phase = live(snapshot) ? "active" : "closed";
      if (
        !live(snapshot) ||
        snapshot.events.some(
          (event) =>
            event.direction === "sent" &&
            ["failed", "unknown"].includes(event.sendState),
        )
      ) {
        uncertainDelivery = true;
        warning = "发送结果未确认，不会自动重发；断开不代表撤回消息";
      } else warning = "发送已提交本地传输；不代表远端业务成功";
      persist();
      emit();
      arm();
    } catch (error) {
      if (epoch !== generation) return;
      retainUnknown("send", error);
      throw Error(warning);
    }
  }
  async function stop() {
    if (!intentId || phase === "closed") return;
    if (phase === "stopping") throw Error("断开请求尚未结束");
    // Closing a transport cannot retract a message whose receipt is still pending.
    if (phase === "sending") uncertainDelivery = true;
    clear();
    const epoch = ++generation;
    phase = "stopping";
    try {
      persist();
    } catch {}
    emit();
    try {
      const value = await api(endpoint() + "/stop", "POST", { instanceId });
      if (epoch !== generation) return;
      const result = receipt(value);
      if (
        !["cancelled", "expired"].includes(result.phase) &&
        live(result.session)
      )
        throw Error("服务端尚未确认断开");
      if (result.phase === "unknown") throw Error("服务端断开结果未确认");
      accept(value);
      if (phase !== "closed") throw Error("服务端尚未确认断开");
    } catch (error) {
      if (epoch !== generation) return;
      retainUnknown("stop", error);
      throw Error(warning);
    }
  }
  async function restore() {
    if (!idValid(instanceId)) {
      storageBlocked = true;
      warning = "无法确认本地服务实例，已禁止连接";
      emit();
      return;
    }
    let record;
    try {
      const raw = storage.getItem(key);
      if (!raw) {
        emit();
        return;
      }
      record = JSON.parse(raw);
      if (
        record.uncertainDelivery !== undefined &&
        typeof record.uncertainDelivery !== "boolean"
      )
        throw Error("恢复记录无效");
      if (
        record.version !== 1 ||
        !idValid(record.instanceId) ||
        !idValid(record.intentId) ||
        !types.has(record.type) ||
        !phases.has(record.phase) ||
        (record.sessionId !== null && !idValid(record.sessionId))
      )
        throw Error("会话恢复标记损坏");
    } catch {
      storageBlocked = true;
      warning =
        "会话恢复标记不可读取，未建立新连接；请确认旧会话后处理存储问题";
      emit();
      return;
    }
    uncertainDelivery =
      record.uncertainDelivery === true ||
      ["sending", "uncertain-send"].includes(record.phase);
    if (record.instanceId !== instanceId) {
      warning =
        "本地服务实例已变化，旧会话不可恢复；旧远端结果仍未确认。建立连接将创建新意图";
      emit();
      return;
    }
    intentId = record.intentId;
    sessionId = record.sessionId;
    type = record.type;
    phase =
      {
        starting: "uncertain-start",
        sending: "uncertain-send",
        stopping: "uncertain-stop",
      }[record.phase] || record.phase;
    if (phase === "closed") {
      emit();
      return;
    }
    clear();
    ++generation;
    if (phase === "active") phase = "uncertain-start";
    emit();
    try {
      const value = await api(endpoint());
      accept(value, {
        preserveUncertainty: ["uncertain-send", "uncertain-stop"].includes(
          phase,
        ),
      });
      arm();
    } catch (error) {
      warning = error.message + "。未恢复连接身份，不会重连；可尝试断开旧意图";
      emit();
    }
  }
  function evidence() {
    return {
      ...(snapshot ? structuredClone(snapshot) : {}),
      connectionRecovery: {
        instanceId,
        intentId,
        phase,
        warning: status().warning,
        uncertainDelivery,
      },
    };
  }
  return { connect, send, stop, poll, restore, status, evidence };
}
