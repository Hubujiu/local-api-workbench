const esc = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const add = (xs, id) => {
  if (id && !xs.includes(id)) xs.push(id);
};
export function createGrpcStreamState() {
  return {
    revision: 0,
    definitionId: "",
    sessionId: "",
    sessionIdKnown: false,
    session: null,
    pending: null,
    cancelPending: null,
    uncertainStart: false,
    uncertainSessions: [],
    persistenceProblems: [],
    notice: "",
    lateResult: null,
    metadata: "[]",
    ca: "",
    cert: "",
    key: "",
    message: "{}",
    initialMessage: "{}",
    initialEnabled: false,
  };
}
export function invalidateGrpcStream(state) {
  state.revision++;
  state.metadata = "[]";
  for (const k of ["ca", "cert", "key"]) state[k] = "";
  state.notice =
    "已离开面板并清除临时凭据；流可能继续，返回后只能显式刷新，不自动重发。";
}
function snapshot(value, id) {
  if (
    !plain(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.type !== "grpc" ||
    (id && id !== value.id) ||
    !["active", "terminal"].includes(value.lifecycle) ||
    !plain(value.streaming) ||
    typeof value.streaming.request !== "boolean" ||
    typeof value.streaming.response !== "boolean" ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.requestMessages) ||
    typeof value.recordSaved !== "boolean" ||
    ![null, "pending", "saved", "unknown", "failed"].includes(
      value.receiptState,
    )
  )
    throw Error("gRPC会话回执无效，勿重发");
  return value;
}
export function createGrpcStreamController(options) {
  const {
    state,
    assertCurrent,
    setBusy,
    post,
    get,
    onChange = () => {},
  } = options;
  const check = () => assertCurrent();
  const refresh = () => {
    try {
      check();
      onChange();
    } catch {}
  };
  function persist() {
    if (options.persistEvidence?.(state) !== true)
      throw Error("无法保存恢复标记，已阻止新操作");
  }
  const note = () => {
    try {
      options.persistEvidence?.(state);
    } catch {}
  };
  function apply(value, id) {
    const result = snapshot(value, id);
    state.session = result;
    state.sessionId = result.id;
    state.sessionIdKnown = true;
    if (
      result.requestMessages.some((m) =>
        ["unknown", "failed"].includes(m.sendState),
      )
    )
      add(state.uncertainSessions, result.id);
    if (result.lifecycle === "terminal") {
      if (result.recordSaved && result.receiptState === "saved")
        state.persistenceProblems = state.persistenceProblems.filter(
          (x) => x !== result.id,
        );
      else add(state.persistenceProblems, result.id);
    }
    return result;
  }
  function edit(k, value) {
    check();
    if (state.pending || state.cancelPending) throw Error("请等待当前操作结束");
    if (
      ![
        "definitionId",
        "sessionId",
        "metadata",
        "ca",
        "cert",
        "key",
        "message",
        "initialMessage",
        "initialEnabled",
      ].includes(k)
    )
      throw Error("字段不支持");
    if (
      k === "definitionId" &&
      value &&
      !(options.definitions || []).some((d) => d.id === value)
    )
      throw Error("定义不存在");
    if (k === "sessionId") {
      value = String(value).trim();
      if (
        state.sessionId &&
        (state.sessionIdKnown ||
          state.session ||
          state.uncertainSessions.includes(state.sessionId) ||
          state.persistenceProblems.includes(state.sessionId)) &&
        value !== state.sessionId &&
        (!state.session ||
          state.session.lifecycle !== "terminal" ||
          !state.session.recordSaved)
      )
        throw Error("原会话尚未核对终态保存，不能更换或清空ID");
      if (value.length > 200) throw Error("会话ID过长");
      if (value === state.sessionId) return;
      state.session = null;
      state.sessionIdKnown = false;
    }
    state[k] = value;
    state.revision++;
    if (["definitionId", "sessionId"].includes(k)) {
      note();
      if (k === "definitionId") refresh();
    }
  }
  async function operation(kind, work, id) {
    check();
    if (state.pending || state.cancelPending) throw Error("已有操作进行中");
    setBusy(true, kind);
    const token = {},
      version = state.revision;
    state.pending = { kind, id, token };
    state.notice = "";
    refresh();
    const current = () => {
      check();
      if (state.revision !== version || state.pending?.token !== token)
        throw Error("视图已变化，迟到回执保留待核对");
    };
    try {
      return await work(current);
    } catch (error) {
      note();
      try {
        current();
        state.notice = error.message || "操作失败，勿重发";
      } catch {}
    } finally {
      if (state.pending?.token === token) state.pending = null;
      if (!state.cancelPending) setBusy(false, kind);
      refresh();
    }
  }
  function requireNew() {
    if (state.uncertainStart || state.persistenceProblems.length)
      throw Error("已有连接或保存结果未确认，禁止新网络操作");
  }
  async function start() {
    check();
    requireNew();
    if (
      (state.sessionId && !state.session) ||
      state.session?.lifecycle === "active"
    )
      throw Error("已有活动流，请先取消并核对");
    if (state.uncertainSessions.length)
      throw Error("已有发送结果未知，请核对，不能重启重放");
    if (!(options.definitions || []).some((d) => d.id === state.definitionId))
      throw Error("请选择已保存的流式定义");
    const metadata = JSON.parse(state.metadata);
    if (!Array.isArray(metadata)) throw Error("metadata须为JSON数组");
    const tls = Object.fromEntries(
      ["ca", "cert", "key"].filter((k) => state[k]).map((k) => [k, state[k]]),
    );
    const body = {
      definitionId: state.definitionId,
      metadata,
      ...(Object.keys(tls).length ? { tls } : {}),
      ...(state.initialEnabled
        ? { message: JSON.parse(state.initialMessage) }
        : {}),
    };
    return operation("start", async (current) => {
      const definition = options.definitions.find(
        (d) => d.id === state.definitionId,
      );
      const schema = await options.inspectDefinition(definition);
      current();
      const method = schema?.services
        ?.find((s) => s.name === definition.service)
        ?.methods?.find((m) => m.name === definition.method);
      if (
        !method ||
        typeof method.requestStream !== "boolean" ||
        typeof method.responseStream !== "boolean"
      )
        throw Error("已保存定义的方法信息无效");
      if (!method.requestStream && !method.responseStream)
        throw Error("此定义是单次调用，请使用上方面板");
      if (state.initialEnabled === method.requestStream)
        throw Error(
          method.requestStream
            ? "client/bidi流不能提供初始请求，请取消勾选"
            : "服务端流须勾选初始请求",
        );
      state.uncertainStart = true;
      persist();
      const value = await post("grpc-sessions", body);
      try {
        current();
      } catch (e) {
        state.lateResult = value;
        throw e;
      }
      apply(value);
      state.uncertainStart = false;
      try {
        persist();
      } catch (e) {
        state.uncertainStart = true;
        throw e;
      }
      state.notice =
        "已收到本机创建回执；手动刷新读取流。不自动重连，不保证远端业务恰好一次。";
    });
  }
  async function poll() {
    const id = state.sessionId;
    if (!id) throw Error("请输入原会话ID");
    return operation(
      "refresh",
      async (current) => {
        const value = await get("grpc-sessions/" + encodeURIComponent(id));
        current();
        apply(value, id);
        persist();
        state.notice =
          "只读刷新；未知发送标记保持。终态记录状态与网络结果分别显示。";
      },
      id,
    );
  }
  async function transmit(kind) {
    check();
    requireNew();
    const s = state.session;
    if (
      !s ||
      s.id !== state.sessionId ||
      s.lifecycle !== "active" ||
      !s.streaming.request ||
      s.requestState !== "writable"
    )
      throw Error("当前请求流不可写，请先刷新核对");
    if (state.uncertainSessions.includes(s.id))
      throw Error("前次发送结果未知，不得重发或半关闭");
    if (s.requestMessages.some((m) => m.sendState === "pending"))
      throw Error("本地发送仍在等待回调/drain，请刷新");
    const body = kind === "send" ? { message: JSON.parse(state.message) } : {};
    return operation(
      kind,
      async (current) => {
        add(state.uncertainSessions, s.id);
        persist();
        const value = await post(
          "grpc-sessions/" + encodeURIComponent(s.id) + "/" + kind,
          body,
        );
        try {
          current();
        } catch (e) {
          state.lateResult = value;
          throw e;
        }
        // A concurrent cancellation owns the newer terminal snapshot and uncertainty.
        if (
          state.cancelPending ||
          state.persistenceProblems.includes(s.id) ||
          state.session?.lifecycle === "terminal"
        ) {
          state.lateResult = value;
          note();
          return;
        }
        apply(value, s.id);
        const unknown =
          value.requestMessages.some((m) =>
            ["unknown", "failed"].includes(m.sendState),
          ) ||
          (kind === "half-close" &&
            !["halfClosed", "halfClosing"].includes(value.requestState));
        if (!unknown)
          state.uncertainSessions = state.uncertainSessions.filter(
            (x) => x !== s.id,
          );
        try {
          persist();
        } catch (e) {
          add(state.uncertainSessions, s.id);
          throw e;
        }
        state.notice =
          kind === "send"
            ? "仅收到本机发送快照；pending/accepted不是远端确认，勿重发同一业务消息。"
            : "已请求半关闭，仍须等待最终状态；不代表RPC成功。";
      },
      s.id,
    );
  }
  async function terminal(kind) {
    check();
    const id = state.sessionId;
    if (!id) throw Error("请输入原会话ID");
    if (state.cancelPending) return;
    if (state.pending && !["send", "half-close"].includes(state.pending.kind))
      throw Error("请等待当前操作结束");
    if (kind === "reconcile" && state.session?.lifecycle !== "terminal")
      throw Error("请先刷新核对终态");
    const token = {},
      version = state.revision,
      parallel = !!state.pending;
    if (!parallel) setBusy(true, kind);
    state.cancelPending = { id, token };
    state.sessionIdKnown = true;
    add(state.persistenceProblems, id);
    let storageFailed = false;
    try {
      persist();
    } catch {
      storageFailed = true;
    }
    refresh();
    try {
      const value = await post(
        "grpc-sessions/" + encodeURIComponent(id) + "/" + kind,
        {},
      );
      check();
      if (state.revision !== version || state.sessionId !== id) {
        state.lateResult = value;
        note();
        return;
      }
      const result = apply(value, id);
      if (result.lifecycle !== "terminal") throw Error("终态回执不完整");
      state.notice =
        (result.recordSaved
          ? "终态记录已确认保存。"
          : "流已终止，但记录尚未确认保存。") +
        "取消不能撤回远端操作；核对仅重试同一记录保存，不重放业务。";
      try {
        persist();
      } catch {
        storageFailed = true;
      }
      if (storageFailed)
        state.notice += "恢复标记保存失败，刷新可能丢失证据，请保留回执。";
      return result;
    } catch (error) {
      add(state.persistenceProblems, id);
      note();
      try {
        check();
        if (state.revision === version)
          state.notice =
            "停止或保存结果未知；请只读核对。" +
            (storageFailed ? "恢复标记保存失败，刷新可能丢失证据。" : "");
      } catch {}
    } finally {
      if (state.cancelPending?.token === token) state.cancelPending = null;
      if (!state.pending) setBusy(false, kind);
      refresh();
    }
  }
  return {
    edit,
    start,
    poll,
    send: () => transmit("send"),
    halfClose: () => transmit("half-close"),
    cancel: () => terminal("cancel"),
    reconcile: () => terminal("reconcile"),
  };
}
export function renderGrpcStream(state, definitions = []) {
  const busy = !!(state.pending || state.cancelPending),
    disabled = busy ? "disabled" : "";
  return `<section id="grpc-stream-workbench"><h2>gRPC 交互式流</h2><p>仅已保存的server/client/bidi流式定义；定义编辑与保存请使用上方面板。总期限与消息上限不续期。操作均显式执行，不自动重连或重发。</p><label>已保存定义<select id="grpc-stream-definition" ${disabled}><option value="">请选择</option>${definitions.map((d) => `<option value="${esc(d.id)}" ${d.id === state.definitionId ? "selected" : ""}>${esc(d.name)} · ${esc(d.service)} / ${esc(d.method)}</option>`).join("")}</select></label><label><input type="checkbox" id="grpc-stream-initialEnabled" ${state.initialEnabled ? "checked" : ""} ${disabled}>服务端流：创建时发送一条初始请求（client/bidi不得勾选）</label><label>初始请求 JSON<textarea id="grpc-stream-initialMessage" ${disabled}>${esc(state.initialMessage)}</textarea></label><details><summary>临时metadata与TLS（离开清空，不保存）</summary>${["metadata", "ca", "cert", "key"].map((k) => `<label>${esc(k)}<textarea id="grpc-stream-${k}" autocomplete="off" spellcheck="false" ${disabled}>${esc(state[k])}</textarea></label>`).join("")}</details><p>请求/响应正文及远端错误可能敏感，会进入终态历史。accepted仅指本机写入，非远端业务确认。</p><button id="grpc-stream-start" ${disabled} ${state.uncertainStart ? "disabled" : ""}>创建流（一次尝试）</button><label>原会话ID（手动恢复，不会创建连接）<input id="grpc-stream-sessionId" value="${esc(state.sessionId)}" ${disabled}></label><button id="grpc-stream-refresh" ${disabled}>只读刷新</button><p id="grpc-stream-status">${esc(state.session ? `${state.session.id} · ${state.session.lifecycle} · ${state.session.requestState} · 保存:${state.session.receiptState ?? "尚未终态"}` : "尚未核对会话")}</p><label>发送消息 JSON<textarea id="grpc-stream-message" ${disabled}>${esc(state.message)}</textarea></label><button id="grpc-stream-send" ${disabled} ${state.uncertainSessions.includes(state.sessionId) || state.uncertainStart || state.persistenceProblems.length ? "disabled" : ""}>发送一条新消息</button><button id="grpc-stream-half-close" ${disabled} ${state.uncertainSessions.includes(state.sessionId) || state.uncertainStart || state.persistenceProblems.length ? "disabled" : ""}>半关闭请求方向</button><button id="grpc-stream-cancel" ${state.cancelPending || (state.pending && !["send", "half-close"].includes(state.pending.kind)) ? "disabled" : ""}>取消并核对保存</button><button id="grpc-stream-reconcile" ${disabled}>终态记录保存核对（可能重试存储）</button><p id="grpc-stream-notice" role="status">${esc(state.notice)}</p>${state.uncertainStart ? "<p>创建结果未知：不可直接重试，也不能凭定义认领；请保留迟到回执或原会话ID。</p>" : ""}${state.uncertainSessions.length ? `<p>未知发送/半关闭：${esc(state.uncertainSessions.join("、"))}；刷新不会证明远端未执行。</p>` : ""}${state.persistenceProblems.length ? `<p>停止/保存待核对：${esc(state.persistenceProblems.join("、"))}</p>` : ""}<pre id="grpc-stream-result">${esc(state.session ? JSON.stringify(state.session, null, 2) : "尚无会话回执")}</pre>${state.lateResult ? `<details><summary>迟到回执（未认领，可能敏感）</summary><pre>${esc(JSON.stringify(state.lateResult, null, 2))}</pre></details>` : ""}</section>`;
}
export function bindGrpcStream(root, options) {
  const controller = createGrpcStreamController(options),
    q = (id) => root.querySelector("#grpc-stream-" + id),
    error = (e) => {
      try {
        options.assertCurrent();
        options.state.notice = e.message;
        options.onChange?.();
      } catch {}
    };
  for (const k of [
    "message",
    "initialMessage",
    "metadata",
    "ca",
    "cert",
    "key",
  ])
    if (q(k))
      q(k).oninput = () => {
        try {
          controller.edit(k, q(k).value);
        } catch (e) {
          error(e);
        }
      };
  if (q("sessionId"))
    q("sessionId").onchange = () => {
      try {
        controller.edit("sessionId", q("sessionId").value);
      } catch (e) {
        error(e);
      }
    };
  if (q("definition"))
    q("definition").onchange = () => {
      try {
        controller.edit("definitionId", q("definition").value);
      } catch (e) {
        error(e);
      }
    };
  if (q("initialEnabled"))
    q("initialEnabled").onchange = () => {
      try {
        controller.edit("initialEnabled", q("initialEnabled").checked);
      } catch (e) {
        error(e);
      }
    };
  for (const [id, fn] of Object.entries({
    start: controller.start,
    refresh: controller.poll,
    send: controller.send,
    "half-close": controller.halfClose,
    cancel: controller.cancel,
    reconcile: controller.reconcile,
  }))
    if (q(id)) q(id).onclick = () => Promise.resolve().then(fn).catch(error);
  return controller;
}
