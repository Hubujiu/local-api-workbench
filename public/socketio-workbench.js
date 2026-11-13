const esc = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const copy = (x) => structuredClone(x);
const canonical = (x) =>
  JSON.stringify(x, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
const plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const fields = [
  "id",
  "name",
  "url",
  "path",
  "events",
  "version",
  "transport",
  "handshake",
];
function definitionOf(state) {
  return Object.fromEntries(
    fields
      .filter((k) => state.definition[k] !== undefined)
      .map((k) => [k, copy(state.definition[k])]),
  );
}
export function createSocketIOState() {
  const state = {
    revision: 0,
    definition: {
      name: "Socket.IO",
      url: "http://localhost:3000",
      path: "/socket.io/",
      events: null,
      version: 4,
      transport: "websocket",
    },
    saved: null,
    eventsText: "null",
    auth: "{}",
    query: "{}",
    headers: "{}",
    ca: "",
    cert: "",
    key: "",
    event: "",
    args: "[]",
    incomingAckId: "",
    incomingAckArgs: "[]",
    incomingAckReceipts: [],
    expectAck: true,
    ackTimeoutMs: 5000,
    sessions: [],
    session: null,
    result: null,
    lateResult: null,
    pending: null,
    stopPending: null,
    uncertainStart: false,
    uncertainSessions: [],
    stopProblems: [],
    stopReceipts: {},
    notice: "",
  };
  Object.defineProperties(state, {
    draftDirty: {
      get: () =>
        state.eventsText !== JSON.stringify(state.saved?.events ?? null) ||
        JSON.stringify(definitionOf(state)) !==
          JSON.stringify(state.saved || definitionOf(createSocketIOState())),
    },
    selectedId: { get: () => state.definition.id || "" },
  });
  return state;
}
export function selectSocketIO(state, definition) {
  if (state.pending || state.stopPending) throw Error("请等待当前操作结束");
  const keep = {
    revision: state.revision + 1,
    sessions: state.sessions,
    session: state.session,
    result: state.result,
    lateResult: state.lateResult,
    uncertainStart: state.uncertainStart,
    uncertainSessions: state.uncertainSessions,
    stopProblems: state.stopProblems,
    stopReceipts: state.stopReceipts,
    incomingAckReceipts: state.incomingAckReceipts,
  };
  Object.assign(state, createSocketIOState(), keep);
  if (definition) {
    state.definition = copy(definition);
    state.saved = definitionOf(state);
    state.eventsText = JSON.stringify(state.definition.events ?? null);
  }
}
export function invalidateSocketIO(state) {
  state.revision++;
  for (const k of ["auth", "query", "headers"]) state[k] = "{}";
  for (const k of ["ca", "cert", "key"]) state[k] = "";
  if (state.pending?.kind === "connect") state.uncertainStart = true;
  if (
    ["send", "ack"].includes(state.pending?.kind) &&
    !state.uncertainSessions.includes(state.pending.sessionId)
  )
    state.uncertainSessions.push(state.pending.sessionId);
  if (
    state.stopPending?.id &&
    !state.uncertainSessions.includes(state.stopPending.id)
  )
    state.uncertainSessions.push(state.stopPending.id);
  if (
    state.stopPending?.id &&
    !state.stopProblems.includes(state.stopPending.id)
  )
    state.stopProblems.push(state.stopPending.id);
  state.notice =
    "已离开面板，临时凭据已清空。现有连接可能继续；返回后只读刷新，不会自动连接或重发。";
}
function snapshot(value, id) {
  if (
    !plain(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.type !== "socketio" ||
    !["connecting", "open", "closed", "error"].includes(value.state) ||
    !Array.isArray(value.events) ||
    !plain(value.definition) ||
    (id && value.id !== id)
  )
    throw Error("会话回执无效，请核对，不会自动重试");
  return value;
}
function credentials(state) {
  const out = {};
  for (const k of ["auth", "query", "headers"]) {
    out[k] = JSON.parse(state[k]);
    if (!plain(out[k])) throw Error(k + "须为JSON对象");
  }
  const tls = Object.fromEntries(
    ["ca", "cert", "key"].filter((k) => state[k]).map((k) => [k, state[k]]),
  );
  if (Object.keys(tls).length) out.tls = tls;
  return out;
}
export function createSocketIOController(options) {
  const {
    state,
    assertCurrent,
    setBusy,
    saveDefinition,
    post,
    get,
    uid,
    onChange = () => {},
  } = options;
  const check = () => assertCurrent();
  function persist() {
    if (options.persistEvidence?.(state) !== true)
      throw Error("无法保存本机会话恢复标记，已阻止新的连接或发送");
  }
  function note() {
    try {
      options.persistEvidence?.(state);
    } catch {}
  }
  const refresh = () => {
    try {
      check();
      onChange();
    } catch {}
  };
  const uncertain = (kind, id) => {
    if (kind === "connect") state.uncertainStart = true;
    if (["send", "ack"].includes(kind) && !state.uncertainSessions.includes(id))
      state.uncertainSessions.push(id);
  };
  function select(id) {
    check();
    if (state.pending || state.stopPending) throw Error("请等待当前操作结束");
    const d = (options.definitions || []).find((x) => x.id === id);
    if (id && !d) throw Error("定义不存在");
    if (state.draftDirty && options.confirmDiscard?.() !== true) {
      refresh();
      return false;
    }
    selectSocketIO(state, d);
    refresh();
    return true;
  }
  function edit(field, value) {
    check();
    if (state.pending || state.stopPending) throw Error("操作期间请勿编辑");
    if (
      [
        "auth",
        "query",
        "headers",
        "ca",
        "cert",
        "key",
        "event",
        "args",
        "incomingAckId",
        "incomingAckArgs",
        "expectAck",
        "ackTimeoutMs",
      ].includes(field)
    )
      state[field] = value;
    else if (
      ["name", "url", "path", "events", "version", "transport"].includes(field)
    ) {
      if (field === "events") {
        state.eventsText = value;
        state.revision++;
        return;
      }
      if (field === "version") value = Number(value);
      state.definition[field] = value;
    } else throw Error("不支持的编辑字段");
    state.revision++;
  }
  async function operation(kind, work, id) {
    check();
    if (state.pending || state.stopPending) throw Error("已有操作进行中");
    setBusy(true, kind);
    const token = {},
      version = state.revision;
    state.pending = { kind, token, sessionId: id };
    state.notice = "";
    refresh();
    const current = () => {
      check();
      if (state.revision !== version || state.pending?.token !== token)
        throw Error("视图已变化，迟到结果未应用");
    };
    try {
      if (["connect", "send", "ack"].includes(kind)) {
        uncertain(kind, id);
        persist();
      }
      return await work(current);
    } catch (error) {
      uncertain(kind, id);
      note();
      try {
        current();
        state.notice =
          (["connect", "send", "ack"].includes(kind)
            ? "结果未知，不会自动重发。"
            : "") + (error.message || "操作失败");
      } catch {}
      return undefined;
    } finally {
      if (state.pending?.token === token) state.pending = null;
      if (!state.stopPending) setBusy(false, kind);
      refresh();
    }
  }
  async function save() {
    check();
    if (state.stopProblems.length)
      throw Error("停止或记录保存结果待核对，已阻止新的保存操作");
    const d = definitionOf(state);
    d.events = JSON.parse(state.eventsText);
    if (
      d.events !== null &&
      (!Array.isArray(d.events) || d.events.some((x) => typeof x !== "string"))
    )
      throw Error("监听事件须为JSON字符串数组或null");
    d.id ||= uid();
    return operation("save", async (current) => {
      const result = await saveDefinition(d);
      current();
      if (!result || result.id !== d.id)
        throw Error("定义保存回执不匹配，请重新加载核对");
      state.definition = copy(result);
      state.saved = definitionOf(state);
      state.eventsText = JSON.stringify(state.definition.events ?? null);
      state.notice = "定义已保存；临时认证及TLS材料未保存。";
    });
  }
  async function connect() {
    check();
    if (state.stopProblems.length)
      throw Error("停止或记录保存结果待核对，已阻止新的连接");
    if (state.uncertainStart)
      throw Error("前次连接结果未知；请列出会话并人工核对，不能直接重试连接");
    if (state.session && ["open", "connecting"].includes(state.session.state))
      throw Error("当前仍有连接，请先停止并核对");
    if (!state.saved || state.draftDirty) throw Error("请先保存定义");
    const body = { definitionId: state.saved.id, ...credentials(state) };
    return operation("connect", async (current) => {
      const value = await post("socketio-sessions", body);
      try {
        current();
      } catch (e) {
        state.lateResult = value;
        throw e;
      }
      state.session = snapshot(value);
      state.uncertainStart = false;
      try {
        persist();
      } catch (e) {
        state.uncertainStart = true;
        throw e;
      }
      state.result = null;
      state.notice =
        "已收到连接创建回执，不代表已连接；请手动刷新。不会自动重连。";
    });
  }
  async function list() {
    return operation("list", async (current) => {
      const values = await get("socketio-sessions");
      current();
      if (!Array.isArray(values)) throw Error("会话列表回执无效");
      state.sessions = values.map((x) => snapshot(x));
      state.notice =
        "只读列出服务实例保留的会话；未连接或重放。未知连接不会按定义自动认领。";
    });
  }
  function chooseSession(id) {
    check();
    if (state.pending || state.stopPending) throw Error("请等待当前操作结束");
    const value = state.sessions.find((x) => x.id === id);
    if (!value) throw Error("请先列出并明确选择会话");
    state.revision++;
    state.session = copy(value);
    state.result = null;
    state.notice =
      "已选择现有会话，仅用于读取/停止；不会重连。发送仍须检查会话定义及未知结果。";
    refresh();
  }
  async function poll() {
    const id = state.session?.id;
    if (!id) throw Error("请先选择会话");
    return operation(
      "refresh",
      async (current) => {
        const value = await get("socketio-sessions/" + encodeURIComponent(id));
        current();
        state.session = snapshot(value, id);
        state.notice = "已只读刷新；不会清除未知发送标记，或补存执行记录。";
      },
      id,
    );
  }
  async function send() {
    check();
    if (state.stopProblems.length)
      throw Error("停止或记录保存结果待核对，已阻止新的发送");
    const s = state.session;
    if (!s || s.state !== "open") throw Error("当前会话未打开，请先刷新核对");
    if (state.uncertainStart || state.uncertainSessions.includes(s.id))
      throw Error("前次结果未知，不能重发；请核对远端并停止会话");
    if (
      state.draftDirty ||
      !state.saved ||
      canonical(s.definition) !== canonical(state.saved)
    )
      throw Error("当前会话定义与已保存选择不匹配");
    const args = JSON.parse(state.args);
    if (!Array.isArray(args)) throw Error("事件参数须为JSON数组");
    const body = {
      event: state.event,
      args,
      ...(state.expectAck ? { ackTimeoutMs: Number(state.ackTimeoutMs) } : {}),
    };
    return operation(
      "send",
      async (current) => {
        const result = await post(
          "socketio-sessions/" + encodeURIComponent(s.id) + "/send",
          body,
        );
        try {
          current();
        } catch (e) {
          state.lateResult = result;
          throw e;
        }
        if (
          !plain(result) ||
          ![
            "sent",
            "acknowledged",
            "ack-timeout",
            "disconnected",
            "ack-rejected",
          ].includes(result.status) ||
          !["unknown", "acknowledged"].includes(result.remoteOutcome) ||
          (["sent", "ack-timeout", "disconnected"].includes(result.status) &&
            result.remoteOutcome !== "unknown") ||
          (["acknowledged", "ack-rejected"].includes(result.status) &&
            result.remoteOutcome !== "acknowledged") ||
          (result.status === "acknowledged" && !Array.isArray(result.args))
        )
          throw Error("发送回执无效");
        state.result = result;
        if (result.remoteOutcome === "unknown") uncertain("send", s.id);
        else if (!state.stopProblems.includes(s.id))
          state.uncertainSessions = state.uncertainSessions.filter(
            (x) => x !== s.id,
          );
        try {
          persist();
        } catch (e) {
          uncertain("send", s.id);
          throw e;
        }
        state.notice =
          result.remoteOutcome === "acknowledged"
            ? "收到对端ack，仅表示对端确认，不保证业务恰好执行一次。"
            : "未确认远端结果，不会自动重发；请核对后停止会话。";
      },
      s.id,
    );
  }
  async function acknowledge() {
    check();
    if (state.incomingAckReceipts.length >= 1000)
      throw Error("本页确认回执达到1000项上限；已阻止新回应，请先停止核对会话");
    const s = state.session;
    if (!s || s.state !== "open") throw Error("请先只读刷新打开的会话");
    if (
      state.stopProblems.length ||
      state.uncertainStart ||
      state.uncertainSessions.includes(s.id)
    )
      throw Error("前次结果待核对，不能回应或重发");
    if (
      state.draftDirty ||
      !state.saved ||
      canonical(s.definition) !== canonical(state.saved)
    )
      throw Error("会话与已保存定义不匹配");
    const ackId = state.incomingAckId;
    if (
      !s.events.some((e) => e.direction === "received" && e.ackId === ackId) ||
      s.events.some((e) => e.direction === "ack-sent" && e.ackId === ackId) ||
      state.incomingAckReceipts.some(
        (e) => e.sessionId === s.id && e.ackId === ackId,
      )
    )
      throw Error("请选择当前会话尚未回应的入站确认；过期状态由服务核对");
    const args = JSON.parse(state.incomingAckArgs);
    if (!Array.isArray(args) || args.length > 100)
      throw Error("确认参数须为至多100项JSON数组");
    return operation(
      "ack",
      async (current) => {
        const result = await post(
          "socketio-sessions/" + encodeURIComponent(s.id) + "/ack",
          { ackId, args },
        );
        try {
          current();
        } catch (e) {
          state.lateResult = result;
          throw e;
        }
        if (!plain(result) || result.acknowledged !== true)
          throw Error("确认回执无效");
        // Suppress this consumed ID even before the next read. This is local receipt, not delivery proof.
        state.incomingAckReceipts.push({ sessionId: s.id, ackId });
        state.result = {
          ackId,
          locallySubmitted: true,
          remoteOutcome: "unknown",
        };
        if (!state.stopProblems.includes(s.id))
          state.uncertainSessions = state.uncertainSessions.filter(
            (x) => x !== s.id,
          );
        try {
          persist();
        } catch (e) {
          uncertain("ack", s.id);
          throw e;
        }
        state.notice =
          "本地已提交确认，不代表远端收到或业务执行成功；不会重发此确认。";
      },
      s.id,
    );
  }
  async function stop() {
    check();
    const id = state.session?.id;
    if (!id) throw Error("请先选择会话");
    if (state.stopPending) return;
    if (state.pending && !["send", "ack"].includes(state.pending.kind))
      throw Error("请等待当前操作结束");
    const token = {},
      version = state.revision,
      parallel = !!state.pending,
      previousUnknown = state.uncertainSessions.includes(id);
    let storageFailed = false;
    if (!parallel) setBusy(true, "stop");
    state.stopPending = { token, id };
    uncertain("send", id);
    if (!state.stopProblems.includes(id)) state.stopProblems.push(id);
    try {
      persist();
    } catch {
      storageFailed = true;
    }
    state.notice =
      "请求停止只关闭本机连接，不证明远端未执行。" +
      (storageFailed
        ? "恢复标记保存失败，刷新可能丢失结果；仍尝试安全停止。"
        : "");
    refresh();
    try {
      const result = await post(
        "socketio-sessions/" + encodeURIComponent(id) + "/stop",
        {},
      );
      check();
      if (state.revision !== version || state.session?.id !== id) {
        state.lateResult = result;
        uncertain("send", id);
        if (!state.stopProblems.includes(id)) state.stopProblems.push(id);
        note();
        return;
      }
      snapshot(result, id);
      if (
        typeof result.recordSaved !== "boolean" ||
        !["closed", "error"].includes(result.state)
      )
        throw Error("停止保存回执不完整");
      state.session = result;
      state.notice = result.recordSaved
        ? "本机会话已停止，记录已保存。停止不能撤回已发送事件。"
        : "本机会话已停止，但记录未保存；请核对存储，不要重发业务事件。";
      state.stopReceipts[id] = result;
      if (result.recordSaved) {
        state.stopProblems = state.stopProblems.filter((x) => x !== id);
        if (!previousUnknown)
          state.uncertainSessions = state.uncertainSessions.filter(
            (x) => x !== id,
          );
      } else {
        uncertain("send", id);
        if (!state.stopProblems.includes(id)) state.stopProblems.push(id);
      }
      try {
        persist();
      } catch {
        storageFailed = true;
      }
      if (storageFailed)
        state.notice +=
          "恢复标记保存失败，刷新可能丢失本次回执，请保留核对；不会自动重试。";
      return result;
    } catch (error) {
      uncertain("send", id);
      if (!state.stopProblems.includes(id)) state.stopProblems.push(id);
      note();
      try {
        check();
        if (state.revision === version)
          state.notice =
            "停止结果未知；只读刷新核对，不会自动重试或重发。" +
            (storageFailed ? "恢复标记保存失败，刷新可能丢失结果。" : "");
      } catch {}
    } finally {
      if (state.stopPending?.token === token) state.stopPending = null;
      if (!state.pending) setBusy(false, "stop");
      refresh();
    }
  }
  return {
    select,
    edit,
    save,
    connect,
    list,
    chooseSession,
    poll,
    send,
    acknowledge,
    stop,
  };
}
export function renderSocketIO(state, definitions = []) {
  const d = state.definition,
    busy = !!(state.pending || state.stopPending),
    disabled = busy ? "disabled" : "";
  return `<section id="socketio-workbench"><h1>Socket.IO 事件调试</h1><p>连接与发送只在明确点击后执行，不自动重连或重发。会话列表只读；页面刷新后须人工核对旧会话，不能假定旧连接不存在。</p><label>已保存定义<select id="socketio-definition" ${disabled}><option value="">新建定义</option>${definitions.map((x) => `<option value="${esc(x.id)}" ${x.id === d.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>${["name", "url", "path"].map((k) => `<label>${{ name: "名称", url: "地址（含命名空间，无认证查询参数）", path: "Engine.IO传输路径" }[k]}<input id="socketio-${k}" value="${esc(d[k])}" ${disabled}></label>`).join("")}<label>协议版本<select id="socketio-version" ${disabled}>${[4, 2].map((x) => `<option value="${x}" ${(d.version ?? 4) === x ? "selected" : ""}>${x}</option>`).join("")}</select></label><label>传输<select id="socketio-transport" ${disabled}>${["websocket", "polling", "auto"].map((x) => `<option ${x === (d.transport || "websocket") ? "selected" : ""}>${x}</option>`).join("")}</select></label><label>监听事件 JSON数组或null（全部）<textarea id="socketio-events" ${disabled}>${esc(state.eventsText)}</textarea></label><button id="socketio-save" ${disabled}>保存定义（不含临时凭据）</button><details><summary>临时连接认证及TLS（离开面板清空）</summary>${["auth", "query", "headers", "ca", "cert", "key"].map((k) => `<label>${esc(k)}<textarea id="socketio-${k}" autocomplete="off" spellcheck="false" ${disabled}>${esc(state[k])}</textarea></label>`).join("")}</details><p>TLS保持证书验证。定义握手模板保持原样；临时认证不保存，但事件正文、ack及地址可能敏感，会进入会话及保存历史。入站确认仅显式回应一次；本地提交不代表远端业务成功。</p><button id="socketio-connect" ${disabled} ${state.uncertainStart ? "disabled" : ""}>显式连接</button><button id="socketio-list" ${disabled}>列出已有会话（不重连）</button><label>人工选择会话<select id="socketio-session" ${disabled}><option value="">请选择</option>${state.sessions.map((s) => `<option value="${esc(s.id)}" ${s.id === state.session?.id ? "selected" : ""}>${esc(s.id)} · ${esc(s.definition.name)} · ${esc(s.state)}</option>`).join("")}</select></label><button id="socketio-refresh" ${disabled}>只读刷新</button><p id="socketio-session-status">${state.session ? esc(state.session.id + " · " + state.session.state) : "尚未选择会话"}</p><label>事件名<input id="socketio-event" value="${esc(state.event)}" ${disabled}></label><label>参数JSON数组<textarea id="socketio-args" ${disabled}>${esc(state.args)}</textarea></label><label><input id="socketio-expectAck" type="checkbox" ${state.expectAck ? "checked" : ""} ${disabled}>等待对端ack</label><label>ack超时毫秒<input id="socketio-ackTimeoutMs" type="number" min="50" max="30000" value="${esc(state.ackTimeoutMs)}" ${disabled}></label><button id="socketio-send" ${disabled} ${state.uncertainStart || state.uncertainSessions.includes(state.session?.id) ? "disabled" : ""}>显式发送事件</button><label>入站确认ID（从当前事件选择）<select id="socketio-incomingAckId" ${disabled}><option value="">请选择收到的事件</option>${(
    state.session?.events || []
  )
    .filter((e) => e.direction === "received" && e.ackId)
    .map(
      (e) =>
        `<option value="${esc(e.ackId)}" ${e.ackId === state.incomingAckId ? "selected" : ""}>${esc(e.event)} · ${esc(e.ackId)}</option>`,
    )
    .join(
      "",
    )}</select></label><label>回应JSON参数数组<textarea id="socketio-incomingAckArgs" ${disabled}>${esc(state.incomingAckArgs)}</textarea></label><button id="socketio-ack" ${disabled}>显式回应入站确认</button><button id="socketio-stop" ${!state.session || state.stopPending || (state.pending && !["send", "ack"].includes(state.pending.kind)) ? "disabled" : ""}>停止并保存记录</button><p id="socketio-notice" role="status">${esc(state.notice)}</p>${state.uncertainStart ? "<p>曾有未知连接结果；列表不能证明未创建连接，不能直接重试。</p>" : ""}${state.uncertainSessions.length ? `<p>未知发送/停止记录：${esc(state.uncertainSessions.join("、"))}。只读刷新或停止不会证明远端未执行。</p>` : ""}${state.stopProblems.length ? `<p id="socketio-stop-warning">停止或记录保存仍需核对：${esc(state.stopProblems.join("、"))}；后续发送ack不能消除此证据。</p>` : ""}<pre id="socketio-stop-result">${esc(state.session && state.stopReceipts[state.session.id] ? JSON.stringify(state.stopReceipts[state.session.id], null, 2) : "尚无停止保存回执")}</pre><pre id="socketio-result">${esc(state.result ? JSON.stringify(state.result, null, 2) : "尚无发送回执")}</pre><details><summary>实际会话冻结定义（发送目标）</summary><pre>${esc(state.session ? JSON.stringify(state.session.definition, null, 2) : "尚无会话")}</pre></details><pre id="socketio-events-result">${esc(state.session ? JSON.stringify(state.session.events, null, 2) : "尚无会话事件")}</pre>${state.lateResult ? `<details><summary>迟到回执（需核对，可能敏感）</summary><pre>${esc(JSON.stringify(state.lateResult, null, 2))}</pre></details>` : ""}</section>`;
}
export function bindSocketIO(root, options) {
  const controller = createSocketIOController(options),
    q = (id) => root.querySelector("#socketio-" + id),
    error = (e) => {
      try {
        options.assertCurrent();
        options.state.notice = e.message;
        options.onChange?.();
      } catch {}
    };
  for (const k of [
    "name",
    "url",
    "path",
    "events",
    "auth",
    "query",
    "headers",
    "ca",
    "cert",
    "key",
    "event",
    "args",
    "incomingAckId",
    "incomingAckArgs",
    "ackTimeoutMs",
  ]) {
    const el = q(k);
    if (el)
      el.oninput = () => {
        try {
          controller.edit(k, el.value);
        } catch (e) {
          error(e);
        }
      };
  }
  for (const k of ["version", "transport", "expectAck", "incomingAckId"]) {
    const el = q(k);
    if (el)
      el.onchange = () => {
        try {
          controller.edit(k, k === "expectAck" ? el.checked : el.value);
        } catch (e) {
          error(e);
        }
      };
  }
  if (q("definition"))
    q("definition").onchange = () => {
      try {
        controller.select(q("definition").value);
      } catch (e) {
        error(e);
      }
    };
  if (q("session"))
    q("session").onchange = () => {
      try {
        controller.chooseSession(q("session").value);
      } catch (e) {
        error(e);
      }
    };
  for (const [id, fn] of Object.entries({
    save: controller.save,
    connect: controller.connect,
    list: controller.list,
    refresh: controller.poll,
    send: controller.send,
    ack: controller.acknowledge,
    stop: controller.stop,
  })) {
    if (q(id)) q(id).onclick = () => Promise.resolve().then(fn).catch(error);
  }
  return controller;
}
