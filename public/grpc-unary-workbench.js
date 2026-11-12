const esc = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const clone = (x) => structuredClone(x);
const sourceKeys = ["proto", "protoName", "files", "schema"];
const sourceOf = (x) =>
  Object.fromEntries(
    sourceKeys.filter((k) => x[k] !== undefined).map((k) => [k, clone(x[k])]),
  );
export function createGrpcUnaryState() {
  const state = {
    revision: 0,
    definition: {
      name: "gRPC",
      target: "grpc://localhost:50051",
      proto: "",
      service: "",
      method: "",
      timeoutMs: 5000,
    },
    saved: null,
    services: [],
    reflectedServices: [],
    reflectionService: "",
    schemaReady: false,
    message: "{}",
    metadata: "[]",
    ca: "",
    cert: "",
    key: "",
    result: null,
    notice: "",
    pending: null,
    uncertain: false,
    lastRun: null,
    lateResult: null,
  };
  Object.defineProperties(state, {
    draftDirty: { get: () => grpcUnaryDefinitionDirty(state) },
    selectedId: { get: () => state.definition.id || "" },
  });
  return state;
}
export function grpcUnaryDefinitionDirty(state) {
  const baseline = state.saved || definitionOf(createGrpcUnaryState());
  return JSON.stringify(definitionOf(state)) !== JSON.stringify(baseline);
}

export function selectGrpcUnary(state, definition) {
  if (state.pending) throw Error("请等待当前操作结束");
  const revision = state.revision + 1,
    uncertain = state.uncertain,
    lastRun = state.lastRun,
    lateResult = state.lateResult;
  Object.assign(state, createGrpcUnaryState(), {
    revision,
    uncertain,
    lastRun,
    lateResult,
  });
  if (definition) {
    state.definition = clone(definition);
    state.saved = definitionOf(state);
  }
}
export function invalidateGrpcUnary(state) {
  state.revision++;
  state.metadata = "[]";
  for (const key of ["ca", "cert", "key"]) state[key] = "";
  if (state.pending?.runId) {
    if (state.pending.kind === "run") state.uncertain = true;
    state.notice =
      "已离开调用面板；临时凭据已清除，调用可能继续。请核对保留的runId；请求取消不证明远端未执行。";
  }
}

function definitionOf(state) {
  const d = state.definition;
  return {
    ...(d.id ? { id: d.id } : {}),
    name: d.name,
    target: d.target,
    ...sourceOf(d),
    service: d.service,
    method: d.method,
    timeoutMs: Number(d.timeoutMs),
    ...(d.requiredMetadata
      ? { requiredMetadata: clone(d.requiredMetadata) }
      : {}),
  };
}
function methodOf(state) {
  return state.services
    .find((s) => s.name === state.definition.service)
    ?.methods?.find((m) => m.name === state.definition.method);
}
function assertSchema(value) {
  if (
    !value ||
    !/^[a-f0-9]{64}$/.test(value.sha256 || "") ||
    !Array.isArray(value.services) ||
    !value.services.length ||
    value.services.some(
      (s) =>
        typeof s.name !== "string" ||
        !Array.isArray(s.methods) ||
        s.methods.some(
          (m) =>
            typeof m.name !== "string" ||
            typeof m.requestStream !== "boolean" ||
            typeof m.responseStream !== "boolean",
        ),
    )
  )
    throw Error("gRPC schema回执无效");
  return value.services;
}
function runtime(state) {
  const metadata = JSON.parse(state.metadata);
  if (!Array.isArray(metadata)) throw Error("metadata必须为JSON数组");
  const tls = Object.fromEntries(
    ["ca", "cert", "key"].filter((k) => state[k]).map((k) => [k, state[k]]),
  );
  return { metadata, ...(Object.keys(tls).length ? { tls } : {}) };
}
// The app owns project/page identity, whole-project CAS save and the global busy lock.
// No credentials are returned by definitionOf or passed to saveDefinition.
export function createGrpcUnaryController(options) {
  const {
    state,
    post,
    saveDefinition,
    assertCurrent,
    setBusy,
    uid,
    onChange = () => {},
    cancelRun,
  } = options;
  const check = () => assertCurrent();
  const refresh = () => {
    try {
      check();
      onChange();
    } catch {}
  };
  const touch = () => {
    state.revision++;
  };
  function select(id) {
    check();
    if (state.pending) throw Error("请等待当前操作结束");
    const d = (options.definitions || []).find((x) => x.id === id);
    if (id && !d) throw Error("gRPC定义不存在");
    if (state.draftDirty && options.confirmDiscard?.() !== true) {
      refresh();
      return false;
    }
    selectGrpcUnary(state, d);
    refresh();
  }
  function edit(field, value) {
    check();
    touch();
    if (
      [
        "message",
        "metadata",
        "ca",
        "cert",
        "key",
        "reflectionService",
      ].includes(field)
    )
      state[field] = value;
    else {
      state.definition[field] = value;
      if (field === "proto") {
        delete state.definition.schema;
        delete state.definition.files;
        delete state.definition.protoName;
        state.schemaReady = false;
        state.services = [];
      }
      if (field === "service") state.definition.method = "";
    }
  }
  async function operation(kind, work, network = false) {
    check();
    if (state.pending) throw Error("当前gRPC操作尚未结束");
    const version = state.revision,
      token = {},
      runId = network ? uid() : undefined;
    const current = () => {
      check();
      if (state.revision !== version || state.pending?.token !== token)
        throw Error("面板或输入已变化，未应用迟到结果");
    };
    setBusy(true);
    state.pending = { kind, token, runId, cancelRequested: false };
    if (kind === "run") state.lastRun = { runId, outcome: "pending" };
    state.notice = "";
    refresh();
    try {
      return await work(current, runId);
    } catch (error) {
      // Execution ownership is independent of editor ownership. Never forget an
      // attempted RPC merely because the user edited or left its view.
      if (kind === "run" && state.lastRun?.runId === runId) {
        state.uncertain = true;
        if (state.lastRun.outcome === "pending")
          state.lastRun.outcome = "unknown";
      }
      try {
        current();
        state.notice = error.message || "操作失败";
        if (kind === "run") {
          state.uncertain = true;
          state.notice =
            "调用结果未知，不会自动重发。请核对远端；错误详情：" + state.notice;
        }
      } catch {}
      return undefined;
    } finally {
      if (state.pending?.token === token) state.pending = null;
      setBusy(false);
      refresh();
    }
  }
  async function inspect() {
    const source = sourceOf(state.definition);
    return operation("schema", async (current) => {
      const result = await post("grpc-schema", source);
      current();
      state.services = assertSchema(result);
      state.schemaReady = true;
      if (!state.services.some((x) => x.name === state.definition.service)) {
        state.definition.service = state.services[0].name;
        state.definition.method = "";
      }
    });
  }
  async function reflect(service = "") {
    const body = {
      target: state.definition.target,
      timeoutMs: Number(state.definition.timeoutMs),
      ...runtime(state),
      ...(service ? { service } : {}),
    };
    return operation(
      "reflection",
      async (current, runId) => {
        const result = await post("grpc-reflection", { ...body, runId });
        current();
        if (
          result?.runId !== runId ||
          result.status?.code !== 0 ||
          result.complete !== true
        )
          throw Error(
            "反射未完整成功：" + String(result?.status?.details || "回执无效"),
          );
        if (service) {
          const services = assertSchema(result);
          if (
            !plain(result.schema) ||
            !services.some((x) => x.name === service)
          )
            throw Error("反射服务schema不匹配");
          for (const k of sourceKeys) delete state.definition[k];
          state.definition.schema = clone(result.schema);
          state.services = services;
          state.schemaReady = true;
          state.definition.service = service;
          state.definition.method = "";
        } else {
          if (
            !Array.isArray(result.services) ||
            result.services.some((x) => !x || typeof x.name !== "string")
          )
            throw Error("反射服务列表无效");
          state.reflectedServices = result.services;
          state.reflectionService = result.services[0]?.name || "";
        }
      },
      true,
    );
  }
  async function example() {
    if (!state.schemaReady || !methodOf(state))
      throw Error("请先解析并选择方法");
    const body = {
      ...sourceOf(state.definition),
      service: state.definition.service,
      method: state.definition.method,
    };
    return operation("example", async (current) => {
      const result = await post("grpc-request-example", body);
      current();
      if (
        result?.service !== body.service ||
        result?.method !== body.method ||
        !plain(result.example) ||
        !Array.isArray(result.skippedRecursiveFields)
      )
        throw Error("请求示例回执不匹配");
      state.message = JSON.stringify(result.example, null, 2);
      state.notice = result.skippedRecursiveFields.length
        ? "示例省略递归字段：" + result.skippedRecursiveFields.join("、")
        : "示例已生成，请检查后显式发送";
    });
  }
  async function save() {
    if (!state.schemaReady || !methodOf(state))
      throw Error("请先解析并选择方法");
    const definition = definitionOf(state);
    definition.id ||= uid();
    return operation("save", async (current) => {
      const saved = await saveDefinition(definition);
      current();
      if (!saved || saved.id !== definition.id)
        throw Error("定义保存回执不匹配，请重新加载核对");
      state.definition = clone(saved);
      state.saved = definitionOf(state);
      state.notice = "定义已保存；临时metadata和TLS凭据未保存";
    });
  }
  async function run() {
    check();
    const method = methodOf(state);
    if (
      !state.schemaReady ||
      !method ||
      method.requestStream ||
      method.responseStream
    )
      throw Error("此面板仅支持unary；流式方法尚未开放");
    if (state.uncertain)
      throw Error(
        "前次结果未知，请核对远端及本机记录，重新加载项目后才可明确发起新调用；不会自动重发",
      );
    if (
      !state.saved ||
      JSON.stringify(definitionOf(state)) !== JSON.stringify(state.saved)
    )
      throw Error("请先保存当前定义，再调用");
    const message = JSON.parse(state.message);
    if (!plain(message)) throw Error("unary请求须为JSON对象");
    const body = {
      definitionId: state.saved.id,
      service: state.definition.service,
      method: state.definition.method,
      timeoutMs: Number(state.definition.timeoutMs),
      messages: [message],
      ...runtime(state),
    };
    return operation(
      "run",
      async (current, runId) => {
        const result = await post("grpc-run", { ...body, runId });
        try {
          current();
        } catch (error) {
          if (state.lastRun?.runId === runId) {
            state.lateResult = result;
            state.lastRun.outcome = "late-receipt-needs-review";
            state.uncertain = true;
          }
          throw error;
        }
        if (
          result?.runId !== runId ||
          !Array.isArray(result.messages) ||
          !Number.isInteger(result.status?.code) ||
          typeof result.recordSaved !== "boolean"
        )
          throw Error("调用回执不完整，请核对远端和执行记录");
        state.result = result;
        state.lastRun = { runId, outcome: "receipt" };
        state.notice =
          (state.pending.cancelRequested
            ? "已请求取消不证明远端未执行。"
            : "") +
          (result.recordSaved
            ? "执行记录已保存（请求/响应可能敏感）。"
            : "调用已返回，但执行记录未保存；不要重发业务调用来补记录。");
      },
      true,
    );
  }
  async function cancel() {
    check();
    const pending = state.pending;
    if (!pending?.runId || pending.cancelRequested) return;
    pending.cancelRequested = true;
    state.notice =
      "已请求取消，不证明远端未执行；等待原调用回执，不会自动重发。";
    refresh();
    try {
      await cancelRun(pending.runId);
    } catch {
      try {
        check();
        if (state.pending === pending)
          state.notice = "取消请求结果未知；不证明远端未执行，不会自动重发。";
      } catch {}
    }
    refresh();
  }
  async function loadFiles(main, dependencies = []) {
    if (!main) throw Error("请选择入口proto文件");
    const files = [main, ...dependencies];
    if (files.length > 33 || files.reduce((n, f) => n + f.size, 0) > 262144)
      throw Error("proto文件包超过数量或256KiB限制");
    if (
      files.some((f) => !/^[-A-Za-z0-9_.]+\.proto$/.test(f.name)) ||
      new Set(files.map((f) => f.name)).size !== files.length
    )
      throw Error("仅接受名称唯一的根目录.proto文件；不读取任意磁盘路径");
    return operation("files", async (current) => {
      const values = await Promise.all(files.map((f) => f.text()));
      current();
      if (new TextEncoder().encode(values.join("")).length > 262144)
        throw Error("proto文件包超过256KiB");
      for (const k of sourceKeys) delete state.definition[k];
      state.definition.proto = values[0];
      state.definition.protoName = main.name;
      state.definition.files = Object.fromEntries(
        dependencies.map((f, i) => [f.name, values[i + 1]]),
      );
      state.schemaReady = false;
      state.services = [];
      state.notice = "仅已选择的文件已载入；请点击解析schema";
    });
  }
  return {
    select,
    edit,
    inspect,
    reflect,
    example,
    save,
    run,
    cancel,
    loadFiles,
  };
}
export function renderGrpcUnary(state, definitions = []) {
  const d = state.definition,
    pending = !!state.pending;
  const methods =
    state.services.find((s) => s.name === d.service)?.methods || [];
  const method = methodOf(state),
    unary = method && !method.requestStream && !method.responseStream;
  const disabled = pending ? "disabled" : "";
  return `<section id="grpc-unary-workbench"><h1>gRPC unary 调试</h1><p>仅unary可发送；流式方法可查看但未开放交互。请求正文为JSON编辑器，不是字段表单。调用可能有业务副作用，发送与反射仅在明确点击后执行。</p><label>已保存定义<select id="grpc-definition" ${disabled}><option value="">新建定义</option>${definitions.map((x) => `<option value="${esc(x.id)}" ${x.id === d.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label><label>名称<input id="grpc-name" value="${esc(d.name)}"></label><label>地址<input id="grpc-target" value="${esc(d.target)}" placeholder="grpcs://host:443"></label><label>超时毫秒<input id="grpc-timeoutMs" type="number" min="50" max="30000" value="${esc(d.timeoutMs)}"></label><p>输入proto或明确选择文件。不会读取任意磁盘路径；仅载入显式选择的同级依赖或内置Google定义。包含目录路径的多文件包请通过已有定义导入。</p><label>入口proto<input id="grpc-proto-file" type="file" accept=".proto" ${disabled}></label><label>同级依赖文件<input id="grpc-dependency-files" type="file" accept=".proto" multiple ${disabled}></label><button id="grpc-load-files" ${disabled}>载入已选择文件</button>${d.schema ? "<p>当前使用反射/导入的schema。编辑下方proto将替换schema。</p>" : ""}<label>proto<textarea id="grpc-proto">${esc(d.proto || "")}</textarea></label><button id="grpc-inspect" ${disabled}>解析schema（不调用业务）</button><button id="grpc-reflect-list" ${disabled}>反射：列出远端服务</button><select id="grpc-reflectionService">${state.reflectedServices.map((s) => `<option ${state.reflectionService === s.name ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select><button id="grpc-reflect-schema" ${disabled} ${state.reflectionService ? "" : "disabled"}>反射：获取所选服务schema</button><label>服务<select id="grpc-service"><option value="">请选择</option>${state.services.map((s) => `<option ${s.name === d.service ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label><label>方法<select id="grpc-method"><option value="">请选择</option>${methods.map((m) => `<option value="${esc(m.name)}" ${m.name === d.method ? "selected" : ""}>${esc(m.name)}${m.requestStream || m.responseStream ? "（流式，仅查看）" : "（unary）"}</option>`).join("")}</select></label><button id="grpc-save" ${disabled}>保存定义（不含凭据）</button><button id="grpc-example" ${disabled}>生成请求示例</button><label>请求JSON对象<textarea id="grpc-message">${esc(state.message)}</textarea></label><details><summary>当前面板临时凭据（不保存到定义）</summary><label>metadata JSON数组<textarea id="grpc-metadata" autocomplete="off">${esc(state.metadata)}</textarea></label>${["ca", "cert", "key"].map((k) => `<label>TLS ${k} PEM<textarea id="grpc-${k}" autocomplete="off" spellcheck="false">${esc(state[k])}</textarea></label>`).join("")}</details><p>TLS保持证书验证；私钥不写入定义。请求、响应及远端错误可能含敏感数据，执行记录可保存请求与响应，请勿公开分享。</p><button id="grpc-run" ${pending || !unary || state.uncertain ? "disabled" : ""}>显式发送 unary</button><button id="grpc-cancel" ${state.pending?.runId && !state.pending.cancelRequested ? "" : "disabled"}>请求取消</button><p id="grpc-notice" role="status">${esc(state.notice)}</p><p id="grpc-run-id">${state.lastRun ? esc("最近调用 " + state.lastRun.runId + " · " + state.lastRun.outcome) : ""}</p>${state.lateResult ? `<details><summary>离开面板后收到的回执（需核对，可能含敏感数据）</summary><pre>${esc(JSON.stringify(state.lateResult, null, 2))}</pre></details>` : ""}<pre id="grpc-result">${state.result ? esc(JSON.stringify(state.result, null, 2)) : "尚无调用结果"}</pre></section>`;
}
export function bindGrpcUnary(root, options) {
  const controller = createGrpcUnaryController(options),
    q = (id) => root.querySelector("#grpc-" + id);
  const showError = (error) => {
    try {
      options.assertCurrent();
      options.state.notice = error.message;
      options.onChange?.();
    } catch {}
  };
  const action = (id, fn) => {
    const el = q(id);
    if (el) el.onclick = () => Promise.resolve().then(fn).catch(showError);
  };
  for (const field of [
    "name",
    "target",
    "timeoutMs",
    "proto",
    "message",
    "metadata",
    "ca",
    "cert",
    "key",
  ]) {
    const el = q(field);
    if (el)
      el.oninput = () => {
        try {
          controller.edit(field, el.value);
        } catch (e) {
          showError(e);
        }
      };
  }
  for (const field of ["service", "method", "reflectionService"]) {
    const el = q(field);
    if (el)
      el.onchange = () => {
        try {
          controller.edit(field, el.value);
          options.onChange?.();
        } catch (e) {
          showError(e);
        }
      };
  }
  if (q("definition"))
    q("definition").onchange = () => {
      try {
        controller.select(q("definition").value);
      } catch (e) {
        showError(e);
      }
    };
  action("inspect", controller.inspect);
  action("example", controller.example);
  action("save", controller.save);
  action("run", controller.run);
  action("cancel", controller.cancel);
  action("reflect-list", () => controller.reflect());
  action("reflect-schema", () =>
    controller.reflect(options.state.reflectionService),
  );
  action("load-files", () =>
    controller.loadFiles(
      q("proto-file").files[0],
      Array.from(q("dependency-files").files),
    ),
  );
  return controller;
}
