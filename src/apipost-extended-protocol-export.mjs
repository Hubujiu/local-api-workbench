import { isDeepStrictEqual } from "node:util";
import { validateResourceJSON } from "./api-resource-lifecycle.mjs";
import { apipostResourceFactory } from "./apipost-modern.mjs";
import { prepareNativeProtocols } from "./apipost-native-protocols.mjs";
import { snapshotPlan } from "./core.mjs";
const fail = (reason) => {
  throw Error("原生扩展协议导出不能无损保留" + reason + "；请使用项目备份");
};
const same = (a, b) => isDeepStrictEqual(a, b);
const types = new Set(["grpc", "socketio"]);
function ownData(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && !("value" in descriptor)) fail("访问器字段");
  return descriptor?.value;
}
function dataObject(object) {
  if (
    !object ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(object))
  )
    fail("对象类型");
  const descriptors = Object.getOwnPropertyDescriptors(object);
  for (const key of Reflect.ownKeys(descriptors))
    if (typeof key !== "string" || !("value" in descriptors[key]))
      fail("访问器或非JSON字段");
  return object;
}

function unique(items, label) {
  const map = new Map();
  for (const item of items) {
    if (!item?.id || map.has(item.id)) fail(label + "身份冲突");
    map.set(item.id, item);
  }
  return map;
}
function definitionsEqual(expected, actual, label) {
  const wanted = unique(expected, label),
    found = unique(actual, label);
  if (wanted.size !== found.size) fail(label + "数量");
  for (const [id, value] of wanted)
    if (!same(value, found.get(id))) fail(label + "修改/缺失");
}
function noCredentials(node) {
  if ((node.parent_id ?? "0") !== "0" || node.mark_id)
    fail("非根目录/状态引用");
  if (node.target_type === "socketio") {
    if (
      !node.url?.startsWith("http://") ||
      node.config?.socket_version !== "v4"
    )
      fail("Socket.IO TLS/版本");
    for (const kind of ["header", "cookie"])
      for (const row of node.request?.[kind]?.parameter ?? [])
        if (!Object.hasOwn(row, "value")) fail("已移除握手值");
    if (node.request?.cookie?.parameter?.length) fail("Cookie凭据");
  } else {
    for (const proto of node.protos ?? [])
      for (const service of proto.services ?? [])
        for (const method of service.methods ?? []) {
          if (
            method.tls !== -1 ||
            method.ssl !== -1 ||
            method.request_stream !== -1
          )
            fail("gRPC TLS/客户端流");
          if (method.request?.metadata?.parameter?.length)
            fail("已移除metadata值");
        }
  }
}
export function prepareExtendedProtocolExport(project) {
  dataObject(project);
  const storedSettings = dataObject(ownData(project, "settings") ?? {});
  const sources = ownData(storedSettings, "apipostProtocolSources") ?? [];
  const definitions = {
    grpc: ownData(storedSettings, "grpcDefinitions") ?? [],
    socketio: ownData(storedSettings, "socketioDefinitions") ?? [],
  };
  const plans = ownData(project, "plans") ?? [];
  if (
    !Array.isArray(sources) ||
    !Array.isArray(plans) ||
    sources.length > 1000 ||
    plans.length > 1000 ||
    Object.values(definitions).some((a) => !Array.isArray(a) || a.length > 1000)
  )
    fail("集合无效");
  validateResourceJSON({ sources, definitions });
  const entries = sources.filter((e) => types.has(e?.source?.target_type));
  if (
    !entries.length &&
    !definitions.grpc.length &&
    !definitions.socketio.length
  )
    return { base: project, derivedPlans: [], emit: () => [] };

  // Validate the collection itself before iteration/method lookup, without
  // rejecting existing HTTP snapshots' own undefined optional data fields.
  const planDescriptors = Object.getOwnPropertyDescriptors(plans);
  if (
    Object.getPrototypeOf(plans) !== Array.prototype ||
    Reflect.ownKeys(planDescriptors).length !== plans.length + 1
  )
    fail("计划数组属性");
  for (let i = 0; i < plans.length; i++)
    if (
      !planDescriptors[String(i)]?.enumerable ||
      !("value" in planDescriptors[String(i)])
    )
      fail("计划数组访问器/空洞");
  const protocolPlanIds = new Set();
  validateResourceJSON({
    sources,
    definitions,
    plans: plans.filter((p) => {
      const own = (object, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (descriptor && !("value" in descriptor)) fail("计划访问器");
        return descriptor?.value;
      };
      const planId = own(p, "id");
      if (typeof planId !== "string" || !planId) fail("计划身份");
      const steps = own(p, "steps");
      if (!Array.isArray(steps)) fail("计划步骤");
      for (let i = 0; i < steps.length; i++) {
        const step = own(steps, String(i));
        if (!step || typeof step !== "object") fail("计划步骤");
        if (types.has(own(step, "type"))) {
          protocolPlanIds.add(planId);
          return true;
        }
      }
      return false;
    }),
  });
  const currentPlans = unique(plans, "计划"),
    groups = new Map(),
    rawPlans = [],
    expected = { grpc: [], socketio: [] };
  for (const entry of entries) {
    if (
      Object.keys(entry).some(
        (k) =>
          ![
            "id",
            "sourceProjectId",
            "sourceTargetId",
            "source",
            "notes",
          ].includes(k),
      ) ||
      typeof entry.sourceProjectId !== "string" ||
      typeof entry.sourceTargetId !== "string"
    )
      fail("来源字段");
    const resource = apipostResourceFactory(entry.sourceProjectId);
    if (
      entry.id !== resource("protocol-source", entry.sourceTargetId) ||
      entry.source.target_id !== entry.sourceTargetId ||
      (entry.source.project_id !== undefined &&
        entry.source.project_id !== entry.sourceProjectId)
    )
      fail("来源身份");
    noCredentials(entry.source);
    const group = groups.get(entry.sourceProjectId) ?? [];
    if (group.some((e) => e.sourceTargetId === entry.sourceTargetId))
      fail("重复来源");
    group.push(entry);
    groups.set(entry.sourceProjectId, group);
  }
  for (const [project_id, group] of groups) {
    const converted = prepareNativeProtocols(
      {
        project_id,
        apis: group.map((e) => structuredClone(e.source)),
        global: { global_param: {} },
      },
      apipostResourceFactory(project_id),
    );
    for (const kind of ["grpc", "socketio"])
      expected[kind].push(...converted[kind]);
    rawPlans.push(...converted.plans);
    const byId = unique(group, "来源");
    for (const source of converted.sources)
      if (!same(source, byId.get(source.id))) fail("来源或说明变更");
  }
  for (const kind of ["grpc", "socketio"]) {
    definitionsEqual(expected[kind], definitions[kind], kind);
    for (const d of definitions[kind])
      if (d.handshake?.requiredHeaders?.length) fail("运行时握手凭据");
  }
  const consumed = new Set();
  for (const raw of unique(rawPlans, "派生消息计划").values()) {
    const current = currentPlans.get(raw.id);
    if (!current) fail("缺失派生消息计划");
    const reconstructed = snapshotPlan({
      ...raw,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    });
    if (!same(current, reconstructed)) fail("已编辑派生消息计划");
    consumed.add(raw.id);
  }
  const remainingPlans = plans.filter((p) => !consumed.has(p.id));
  if (remainingPlans.some((p) => protocolPlanIds.has(p.id)))
    fail("额外协议计划");
  const settings = { ...storedSettings };
  delete settings.grpcDefinitions;
  delete settings.socketioDefinitions;
  if (Object.hasOwn(settings, "apipostProtocolSources"))
    settings.apipostProtocolSources = sources.filter(
      (e) => !types.has(e?.source?.target_type),
    );
  return {
    base: { ...project, settings, plans: remainingPlans },
    derivedPlans: plans.filter((p) => consumed.has(p.id)),
    emit(projectId, id) {
      return entries.map((entry) => {
        const node = structuredClone(entry.source),
          scope = JSON.stringify([entry.sourceProjectId, entry.sourceTargetId]);
        node.project_id = projectId;
        node.target_id = id("extended", scope);
        node.parent_id = "0";
        if (node.target_type === "socketio") {
          for (const [i, m] of node.message.entries())
            m.param_id = id("message", JSON.stringify([scope, i]));
        } else
          for (const [pi, p] of node.protos.entries()) {
            p.proto_id = id("proto", JSON.stringify([scope, pi]));
            for (const [si, s] of p.services.entries()) {
              s.service_id = id("service", JSON.stringify([scope, pi, si]));
              for (const [mi, m] of s.methods.entries()) {
                const key = JSON.stringify([scope, pi, si, mi]);
                m.grpc_method_id = id("method", key);
                for (const [i, message] of m.request.message.entries())
                  message.param_id = id("message", JSON.stringify([key, i]));
              }
            }
          }
        return node;
      });
    },
  };
}
function semanticPlan(plan) {
  const { id, createdAt, updatedAt, ...copy } = structuredClone(plan);
  for (const step of copy.steps) {
    delete step.id;
    delete (step.grpc ?? step.socketio).definition.id;
  }
  return copy;
}
function multiset(expected, actual) {
  const remaining = [...actual];
  for (const value of expected) {
    const i = remaining.findIndex((x) => same(value, x));
    if (i < 0) fail("完整回读定义/消息计划差异");
    remaining.splice(i, 1);
  }
  if (remaining.length) fail("额外回读定义/消息计划");
}
export function verifyExtendedProtocolExport(before, after) {
  const a = prepareExtendedProtocolExport(before),
    b = prepareExtendedProtocolExport(after);
  for (const kind of ["grpcDefinitions", "socketioDefinitions"]) {
    const clean = (p) =>
      (p.settings?.[kind] ?? []).map(({ id, ...rest }) => rest);
    multiset(clean(before), clean(after));
  }
  multiset(a.derivedPlans.map(semanticPlan), b.derivedPlans.map(semanticPlan));
  return b.base;
}
