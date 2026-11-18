import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  nativeDataArray,
  nativeDataObject,
} from "./native-response-extraction.mjs";

// The desktop writes this preset even for a manual test without a timer.
const manualFrequency = {
  name: "",
  type: "preset",
  preset: {
    cycle: "hour",
    config: { interval: 5, time: "08:30", weekdays: [7] },
  },
  cron: { expression: "" },
};
const fail = (message) => {
  throw Error("Apipost automated_testings：" + message);
};
const check = (condition, message) => {
  if (!condition) fail(message);
};
const ident = (s) =>
  typeof s === "string" &&
  /^[A-Za-z0-9_.-]{1,200}$/.test(s) &&
  !["constructor", "prototype", "__proto__"].includes(s);
const text = (s, max) =>
  typeof s === "string" && s.length <= max && s.isWellFormed();
const integer = (n, min, max) =>
  Number.isSafeInteger(n) && n >= min && n <= max;
const stamp = (s) => text(s, 64) && Number.isFinite(Date.parse(s));
function fields(obj, keys) {
  try {
    nativeDataObject(obj, keys);
  } catch {
    fail("存在未知或无效字段");
  }
  check(
    keys.every((k) => Object.hasOwn(obj, k)),
    "缺少字段",
  );
}
function array(v, limit) {
  try {
    nativeDataArray(v, limit);
  } catch {
    fail("数组无效或超限");
  }
  return v;
}
const testFields = [
  "project_id",
  "testing_id",
  "parent_id",
  "name",
  "version",
  "testing_type",
  "settings",
  "scenario",
  "frequency",
  "event_list",
  "case_references",
  "references_target_ids",
  "tags",
  "is_locked",
  "sort",
  "created_at",
  "updated_at",
];
const settingsFields = [
  "env_id",
  "enable_request",
  "execute_count",
  "interval_time",
  "ignore_error",
  "enable_sandbox",
  "iterates_data_id",
];
const eventFields = [
  "event_id",
  "parent_event_id",
  "test_id",
  "project_id",
  "type",
  "enabled",
  "sort",
  "data",
  "auto_sync",
];
const dataFields = [
  "origin_target_id",
  "parent_id",
  "target_id",
  "name",
  "method",
  "url",
  "apiData",
];

export function cloudAutomationIds(project) {
  const indices = new Map([
    [
      "e",
      new Map(project.environments.map((env, i) => [env.id, String(i + 1)])),
    ],
    [
      "m",
      new Map(
        (project.settings?.statuses || []).map((status, i) => [
          status.id,
          String(i + 1),
        ]),
      ),
    ],
  ]);
  const assigned = new Map();
  return (kind, value) => {
    const registry = indices.get(kind);
    if (registry) {
      check(registry.has(value), "导出引用未登记");
      return registry.get(value);
    }
    const key = kind + "\0" + value;
    const id =
      "2" +
      createHash("sha256")
        .update(key)
        .digest("hex")
        .slice(0, kind === "project" ? 14 : 13);
    check(!assigned.has(id) || assigned.get(id) === key, "原生资源标识冲突");
    assigned.set(id, key);
    return id;
  };
}

function fixedLoop(ev) {
  const d = ev.data;
  fields(d, [
    "name",
    "limit",
    "sleep",
    "loop_type",
    "loop_timeout",
    "loop_traverse_data",
  ]);
  check(
    ev.parent_event_id === "0" &&
      ev.enabled === 1 &&
      ev.auto_sync === false &&
      text(d.name, 200) &&
      !!d.name.trim() &&
      d.loop_type === 2 &&
      integer(d.limit, 1, 100) &&
      d.sleep === 0 &&
      d.loop_timeout === 0 &&
      isDeepStrictEqual(d.loop_traverse_data, {
        name: "",
        type: 1,
        iterationData: [],
      }),
    "仅支持无数据、无超时的固定次数根循环",
  );
  return d;
}

export function readAutomationDefinitions(source) {
  const tests = array(source.automated_testings, 200);
  if (!tests.length) return [];
  const apis = new Map(source.apis.map((a) => [a.target_id, a]));
  const testIds = new Set(),
    eventIds = new Set();
  let count = 0;
  return tests.map((test) => {
    fields(test, testFields);
    check(
      test.project_id === source.project_id &&
        ident(test.testing_id) &&
        !testIds.has(test.testing_id) &&
        test.testing_type === "testing" &&
        test.parent_id === "0" &&
        text(test.name, 200) &&
        test.name.trim() &&
        integer(test.version, 0, 2147483647) &&
        integer(test.sort, 0, 2147483647) &&
        stamp(test.created_at) &&
        stamp(test.updated_at),
      "用例身份、层级或版本无效",
    );
    testIds.add(test.testing_id);
    check(
      test.scenario === "manual" &&
        isDeepStrictEqual(test.frequency, manualFrequency),
      "仅支持已核对的手动用例及其默认频率配置",
    );
    check(
      !array(test.case_references, 0).length &&
        !array(test.tags, 0).length &&
        test.is_locked === -1,
      "用例依赖、锁或标签未支持",
    );
    const s = test.settings;
    fields(s, settingsFields);
    check(
      source.global.envs.some((e) => String(e.env_id) === s.env_id) &&
        s.iterates_data_id === "0" &&
        s.enable_request === -1 &&
        s.enable_sandbox === -1 &&
        [1, -1].includes(s.ignore_error) &&
        integer(s.execute_count, 1, 100) &&
        integer(s.interval_time, 0, 10000),
      "执行环境、轮次、间隔、沙盒或数据配置未支持",
    );
    const refs = new Set();
    let prev = -1;
    const list = array(test.event_list, 201);
    const wrapper = list[0]?.type === "loop" ? list[0] : undefined;
    const events = wrapper ? list.slice(1) : list;
    for (const ev of list) {
      check(++count <= 200, "导入合计最多200个事件");
      fields(ev, eventFields);
      check(
        ev.project_id === source.project_id &&
          ev.test_id === test.testing_id &&
          ident(ev.event_id) &&
          !eventIds.has(ev.event_id) &&
          [1, -1].includes(ev.enabled) &&
          integer(ev.sort, 0, 2147483647) &&
          ev.sort > prev,
        "事件顺序不明确或标识重复",
      );
      prev = ev.sort;
      eventIds.add(ev.event_id);
      if (ev === wrapper) {
        fixedLoop(ev);
        check(s.execute_count === 1, "暂不支持叠加外层执行轮次");
        continue;
      }
      check(
        ev.parent_event_id === (wrapper?.event_id ?? "0"),
        "事件父节点未支持",
      );
      const d = ev.data;
      if (ev.type === "request") {
        fields(d, ["apiData", "project_id"]);
        const copy = d.apiData;
        check(
          ev.auto_sync === false &&
            d.project_id === source.project_id &&
            copy?.project_id === source.project_id &&
            copy.target_type === "api" &&
            copy.target_id === "" &&
            copy.parent_id === "0" &&
            copy.is_force === -1 &&
            copy.is_create === 1 &&
            copy.is_changed === -1 &&
            text(copy.name, 200) &&
            copy.name.trim() &&
            text(copy.method, 20) &&
            text(copy.url, 16384),
          "独立 HTTP 步骤配置未支持",
        );
        continue;
      }
      check(ev.type === "api", "事件类型未支持");
      fields(d, dataFields);
      const api = apis.get(d.target_id);
      check(
        api?.target_type === "api" &&
          ident(d.target_id) &&
          d.origin_target_id === d.target_id &&
          d.parent_id === api.parent_id &&
          text(d.name, 200) &&
          d.name.trim() &&
          text(d.method, 20) &&
          text(d.url, 16384) &&
          typeof ev.auto_sync === "boolean",
        "接口来源或引用无效",
      );
      if (ev.auto_sync) check(d.apiData === null, "实时引用同时包含副本");
      else {
        const copy = d.apiData;
        check(
          copy?.target_type === "api" &&
            copy.target_id === d.target_id &&
            copy.parent_id === d.parent_id &&
            copy.project_id === source.project_id &&
            [undefined, 0].includes(copy.is_force) &&
            copy.method === d.method &&
            copy.url === d.url,
          "复制接口的来源或请求不一致",
        );
      }
      refs.add(d.target_id);
    }
    check(
      events.length &&
        isDeepStrictEqual(array(test.references_target_ids, 200), [...refs]),
      "接口引用索引与事件不符",
    );
    const executions =
      events.filter((e) => e.enabled === 1).length *
      (wrapper?.data.limit ?? s.execute_count);
    check(
      Math.max(0, executions - 1) * s.interval_time <= 60000,
      "请求间隔合计超过60000毫秒",
    );
    return { test, events, wrapper };
  });
}

// Archive only information that a canonical plan cannot express. Ids are
// project-local and remapped together with a selective import's API bindings.
export function readAutomationMetadata(value) {
  if (value === undefined) return undefined;
  fields(value, [
    "version",
    "revision",
    "sort",
    "events",
    ...["loopName", "requestIntervalMs"].filter((k) => Object.hasOwn(value, k)),
  ]);
  if (Object.hasOwn(value, "requestIntervalMs"))
    check(integer(value.requestIntervalMs, 1, 10000), "请求间隔无效");
  if (Object.hasOwn(value, "loopName"))
    check(text(value.loopName, 200) && value.loopName.trim(), "循环名称无效");
  check(
    value.version === 1 &&
      integer(value.revision, 0, 2147483647) &&
      integer(value.sort, 0, 2147483647),
    "来源版本无效",
  );
  const ids = new Set();
  for (const e of array(value.events, 200)) {
    fields(e, ["stepId", "requestId", "sort", "live", "method", "url"]);
    check(
      ident(e.stepId) &&
        !ids.has(e.stepId) &&
        (ident(e.requestId) || (e.requestId === null && e.live === false)) &&
        integer(e.sort, 0, 2147483647) &&
        typeof e.live === "boolean" &&
        text(e.method, 20) &&
        text(e.url, 16384),
      "步骤来源无效",
    );
    ids.add(e.stepId);
  }
  return structuredClone(value);
}

export function importAutomationPlans(
  source,
  tests,
  requests,
  ids,
  resource,
  { convertCopies, snapshotPlan },
) {
  if (!tests.length) return [];
  const bySource = new Map(requests.map((r) => [r.sourceOperationId, r]));
  const copies = [],
    copyIds = new Map();
  for (const { events } of tests)
    for (const ev of events)
      if (!ev.auto_sync) {
        const key = resource("automation-copy", ev.event_id);
        copyIds.set(ev.event_id, "apipost:" + key);
        copies.push({ ...ev.data.apiData, target_id: key });
      }
  const converted = copies.length
    ? convertCopies({
        ...source,
        automated_testings: [],
        samples: [],
        apis: [
          ...source.apis.filter((a) => a.target_type === "folder"),
          ...copies,
        ],
      })
    : [];
  const snapshots = new Map(converted.map((r) => [r.sourceOperationId, r]));
  let snapshotBytes = 0;
  const sizes = new Map();
  return tests.map(({ test: t, events, wrapper }) => {
    const metadata = [];
    const steps = events.map((ev) => {
      const standalone = ev.type === "request";
      const d = standalone ? ev.data.apiData : ev.data,
        op = standalone ? copyIds.get(ev.event_id) : "apipost:" + d.target_id;
      const requestId = standalone ? null : ids.get(op),
        stepId = resource("automation-event", ev.event_id);
      const request = ev.auto_sync
        ? bySource.get(op)
        : snapshots.get(copyIds.get(ev.event_id));
      check((standalone || requestId) && request, "项目内接口或副本不存在");
      if (!sizes.has(request))
        sizes.set(request, Buffer.byteLength(JSON.stringify(request)));
      snapshotBytes += sizes.get(request);
      check(snapshotBytes <= 4 * 1024 * 1024, "用例快照合计超过 4 MiB");
      metadata.push({
        stepId,
        requestId,
        sort: ev.sort,
        live: ev.auto_sync,
        method: d.method,
        url: d.url,
      });
      return {
        id: stepId,
        name: d.name,
        enabled: ev.enabled === 1,
        ...(ev.auto_sync ? { liveRequestId: requestId } : {}),
        request: {
          ...request,
          id: requestId ?? resource("automation-copy", ev.event_id),
          sourceOperationId: op,
        },
      };
    });
    const s = t.settings;
    return snapshotPlan({
      id: resource("automation", t.testing_id),
      name: t.name,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      environmentId: resource("env", s.env_id),
      ...(s.ignore_error === -1 ? { failurePolicy: "stop" } : {}),
      apipostAutomation: {
        version: 1,
        revision: t.version,
        sort: t.sort,
        events: metadata,
        ...(wrapper ? { loopName: wrapper.data.name } : {}),
        ...(s.interval_time ? { requestIntervalMs: s.interval_time } : {}),
      },
      steps:
        !wrapper && s.execute_count === 1
          ? steps
          : [
              {
                type: "repeat",
                id: resource("automation-round", t.testing_id),
                name: wrapper?.data.name ?? t.name,
                count: wrapper?.data.limit ?? s.execute_count,
                steps,
              },
            ],
    });
  });
}

// In the desktop runner interval_time separates consecutive enabled HTTP calls,
// including the boundary between two rounds. A repeat's intervalMs only waits
// between rounds. Reuse the runner's abortable wait control without changing
// occurrence or report identities.
export function scheduleAutomationRequests(plan, occurrences) {
  if (plan.apipostAutomation === undefined) return occurrences;
  const interval = readAutomationMetadata(
    plan.apipostAutomation,
  ).requestIntervalMs;
  if (!interval) return occurrences;
  check(
    occurrences.every(
      (o) => o.step?.request && !o.condition && !o.runtimeRows && !o.wait,
    ),
    "逐请求间隔不能与其他控制图组合",
  );
  check(
    Math.max(0, occurrences.length - 1) * interval <= 60000,
    "请求间隔合计超过60000毫秒",
  );
  return occurrences.flatMap((o, i) =>
    i ? [{ wait: true, milliseconds: interval }, o] : [o],
  );
}

export function exportAutomationPlans(
  project,
  document,
  { id, encodeRequest, automationMode },
) {
  check(
    automationMode === undefined || automationMode === "desktop-replay",
    "未知导出模式",
  );
  const replay = automationMode === "desktop-replay";
  const nativeById = new Map(
    document.apis
      .filter((a) => a.target_type === "api")
      .map((a) => [a.target_id, a]),
  );
  const envs = new Set(document.global.envs.map((e) => e.env_id));
  return (project.plans || []).map((plan) => {
    const meta = readAutomationMetadata(plan.apipostAutomation);
    if (!meta) throw Error("Apipost导出尚不能表达plans；请使用项目备份");
    check(
      !replay || !meta.requestIntervalMs,
      "8.2.7 桌面回放尚不能保留非零逐请求间隔，请使用保留引用的 Apipost JSON",
    );
    const environment = id("e", plan.environmentId);
    check(
      envs.has(environment) &&
        !plan.functions?.length &&
        !plan.description &&
        plan.source === "manual" &&
        plan.statusPolicy === "assertions" &&
        !plan.importedNativeFlowSource &&
        [undefined, "continue", "stop"].includes(plan.failurePolicy),
      "计划配置不能原生导出",
    );
    const group =
      plan.steps.length === 1 && plan.steps[0].type === "repeat"
        ? plan.steps[0]
        : null;
    if (group)
      check(
        group.enabled !== false &&
          group.rows === undefined &&
          group.rowsFrom === undefined &&
          group.untilCondition === undefined &&
          integer(group.count, 1, 100) &&
          (group.intervalMs ?? 0) === 0,
        "循环配置不能表示为执行轮次",
      );
    check(!meta.loopName || group, "原生循环节点已被移除");
    const wrap = Boolean(group && (replay || meta.loopName));
    const steps = group ? group.steps : plan.steps;
    const sources = new Map(meta.events.map((e) => [e.stepId, e])),
      refs = new Set();
    check(
      steps.length === sources.size && steps.length > 0,
      "步骤集与原生来源不一致",
    );
    const testId = id("t", plan.id);
    const cachedSort = steps.map((s) => sources.get(s.id)?.sort);
    const sameOrder = cachedSort.every(
      (s, i) => i === 0 || s > cachedSort[i - 1],
    );
    const parentId = wrap ? id("loop", group.id) : "0";
    const event_list = steps.map((s, i) => {
      const e = sources.get(s.id);
      check(
        e &&
          !s.type &&
          !s.nativeMCP &&
          s.expectedStatus === undefined &&
          (e.live
            ? s.liveRequestId === e.requestId
            : s.liveRequestId === undefined),
        "步骤或引用已经改变，无法无损导出",
      );
      sources.delete(s.id);
      const api =
        e.requestId === null ? null : nativeById.get(id("a", e.requestId));
      check(e.requestId === null || api, "步骤引用的项目接口不存在");
      const standalone = !e.live && (replay || e.requestId === null);
      const base = {
        event_id: id("v", s.id),
        parent_event_id: parentId,
        test_id: testId,
        project_id: document.project_id,
        enabled: s.enabled === false ? -1 : 1,
        sort: wrap ? i + 2 : sameOrder ? e.sort : i + 1,
        auto_sync: e.live,
      };
      let copy = null;
      if (!e.live) {
        const encoded = encodeRequest({ ...s.request, id: id("copy", s.id) });
        if (standalone) {
          check(
            encoded.parent_id === "0",
            "带父目录继承的副本无法展开为独立 HTTP 步骤",
          );
          return {
            ...base,
            type: "request",
            data: {
              project_id: document.project_id,
              apiData: {
                ...encoded,
                name: s.name,
                target_id: "",
                tags: [],
                is_force: -1,
                is_create: 1,
                is_changed: -1,
              },
            },
          };
        }
        check(encoded.parent_id === api.parent_id, "复制接口父目录已变化");
        copy = { ...encoded, target_id: api.target_id, tags: [], is_force: 0 };
      }
      refs.add(api.target_id);
      return {
        ...base,
        type: "api",
        data: {
          origin_target_id: api.target_id,
          parent_id: api.parent_id,
          target_id: api.target_id,
          name: s.name,
          method: copy?.method ?? e.method,
          url: copy?.url ?? e.url,
          apiData: copy,
        },
      };
    });
    if (wrap)
      event_list.unshift({
        event_id: parentId,
        parent_event_id: "0",
        test_id: testId,
        project_id: document.project_id,
        type: "loop",
        enabled: 1,
        sort: 1,
        auto_sync: false,
        data: {
          name: group.name,
          limit: group.count,
          sleep: 0,
          loop_type: 2,
          loop_timeout: 0,
          loop_traverse_data: { name: "", type: 1, iterationData: [] },
        },
      });
    return {
      project_id: document.project_id,
      testing_id: testId,
      parent_id: "0",
      name: plan.name,
      version: meta.revision,
      testing_type: "testing",
      settings: {
        env_id: environment,
        enable_request: -1,
        execute_count: wrap ? 1 : (group?.count ?? 1),
        interval_time: meta.requestIntervalMs ?? 0,
        ignore_error: plan.failurePolicy === "stop" ? -1 : 1,
        enable_sandbox: -1,
        iterates_data_id: "0",
      },
      scenario: "manual",
      frequency: structuredClone(manualFrequency),
      event_list,
      case_references: [],
      references_target_ids: [...refs],
      tags: [],
      is_locked: -1,
      sort: meta.sort,
      created_at: plan.createdAt,
      updated_at: plan.updatedAt,
    };
  });
}
