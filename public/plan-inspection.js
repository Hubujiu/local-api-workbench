import { authTypes } from "./auth-model.js";
import { isHTTPPlanStep } from "./plan-step-types.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const empty = (text) => `<p class="plan-inspection-empty">${text}</p>`;
const row = (name, state) => `<dt>${esc(name)}</dt><dd>${esc(state)}</dd>`;
const list = (rows) => `<dl class="plan-inspection-list">${rows.join("")}</dl>`;
const objectKeys = (source) => Object.keys(source || {});
const variables = (current, initial) =>
  [...new Set([...objectKeys(current), ...objectKeys(initial)])].map((name) =>
    row(
      name,
      Object.hasOwn(current || {}, name) ? "当前值已隐藏" : "仅有初始定义",
    ),
  );

export function planEnvironmentInspection(project, environment) {
  const local = variables(
    environment.variables,
    environment.variableDefinitions,
  );
  const global = variables(
    project.globalVariables,
    project.globalVariableDefinitions,
  );
  const services = (project.servers || []).map((service) =>
    row(
      service.name,
      environment.serverUrls?.[service.id]
        ? "地址已配置（已隐藏）"
        : "未配置地址",
    ),
  );
  return [
    [
      `环境变量(${local.length})`,
      `<section class="plan-environment-services" aria-label="环境服务">${services.length ? list(services) : "暂无共享服务"}</section>` +
        (local.length ? list(local) : empty("暂无变量")),
    ],
    [
      `全局变量(${global.length})`,
      global.length ? list(global) : empty("暂无变量"),
    ],
  ];
}

const bodyTypes = [
  "none",
  "raw",
  "json",
  "xml",
  "html",
  "text",
  "javascript",
  "form",
  "form-data",
  "urlencoded",
  "binary",
  "msgpack",
];
const pairs = (rows, label) => {
  const entries = (Array.isArray(rows) ? rows : []).map((pair) =>
    row(
      pair.key || "（未命名）",
      pair.enabled === false ? "已禁用" : "值已隐藏",
    ),
  );
  return entries.length ? list(entries) : empty(`暂无${label}`);
};

export function planStepInspection(request) {
  const authType = authTypes.includes(request.auth?.type)
    ? request.auth.type
    : request.auth?.type === undefined
      ? "未指定"
      : "其他类型";
  const bodyType = bodyTypes.includes(request.bodyType)
    ? request.bodyType
    : request.bodyType === undefined
      ? "未指定"
      : "其他类型";
  const scriptPresence = (phase) =>
    request[phase + "Script"]?.trim() ||
    request[phase === "before" ? "sharedBeforeScripts" : "sharedAfterScripts"]
      ?.length
      ? "已记录（源码已隐藏）"
      : "未记录源码";
  return [
    ["请求头", pairs(request.headers, "请求头")],
    ["Query 参数", pairs(request.query, "Query 参数")],
    ["路径参数", pairs(request.path, "路径参数")],
    [
      "请求体",
      list([
        row("类型", bodyType),
        row("快照正文", request.body ? "已记录（内容已隐藏）" : "空"),
        row("表单字段", Array.isArray(request.form) ? request.form.length : 0),
      ]),
    ],
    ["认证", list([row("快照认证类型", authType), row("凭据", "不显示")])],
    ["Cookie", pairs(request.cookies, "Cookie")],
    [
      "脚本",
      list([
        row("发送前", scriptPresence("before")),
        row("发送后", scriptPresence("after")),
      ]),
    ],
  ];
}

function mountTabs(root, entries) {
  const key = root.id;
  root.innerHTML =
    '<div role="tablist" aria-label="查看内容" class="plan-inspection-tabs">' +
    entries
      .map(
        ([label], index) =>
          `<button type="button" id="${key}-tab-${index}" role="tab" aria-controls="${key}-panel-${index}">${esc(label)}</button>`,
      )
      .join("") +
    entries
      .map(
        ([, content], index) =>
          `<div id="${key}-panel-${index}" role="tabpanel" aria-labelledby="${key}-tab-${index}" class="plan-inspection-panel" tabindex="0" hidden>${content}</div>`,
      )
      .join("");
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const panels = [...root.querySelectorAll('[role="tabpanel"]')];
  const select = (index, focus) => {
    for (const [i, tab] of tabs.entries()) {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    }
    if (focus) tabs[index].focus();
  };
  select(0, false);
  for (const [index, tab] of tabs.entries()) {
    tab.onclick = () => select(index, true);
    tab.onkeydown = (event) => {
      const next = {
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(next, true);
    };
  }
}

export function bindPlanInspection(editor, project, plan) {
  if (!editor || !plan) return;
  const trigger = editor.querySelector("#view-plan-environment");
  const dialog = editor.querySelector("#plan-environment-inspection");
  const close = dialog.querySelector("button");
  const environmentTabs = dialog.querySelector(
    "#plan-environment-inspection-tabs",
  );
  trigger.onclick = () => {
    const selected = editor.querySelector("#plan-env").value;
    const environment = project.environments.find(
      (item) => item.id === selected,
    );
    if (!environment || !editor.isConnected || dialog.open) return;
    dialog.querySelector("h2").textContent = environment.name;
    mountTabs(environmentTabs, planEnvironmentInspection(project, environment));
    dialog.showModal();
    close.focus();
  };
  const dismiss = () => {
    dialog.close();
    environmentTabs.replaceChildren();
    trigger.focus();
  };
  close.onclick = dismiss;
  dialog.oncancel = (event) => {
    event.preventDefault();
    dismiss();
  };

  for (const opener of editor.querySelectorAll("[data-plan-inspect-step]")) {
    const step = plan.steps[Number(opener.dataset.planInspectStep)];
    if (!step || !isHTTPPlanStep(step)) continue;
    const panel = editor.querySelector(
      "#" + opener.getAttribute("aria-controls"),
    );
    const tabs = panel.querySelector(".plan-snapshot-tabs");
    const collapse = () => {
      panel.hidden = true;
      opener.setAttribute("aria-expanded", "false");
      tabs.replaceChildren();
    };
    opener.onclick = () => {
      if (!panel.hidden) return collapse();
      mountTabs(tabs, planStepInspection(step.request));
      panel.hidden = false;
      opener.setAttribute("aria-expanded", "true");
    };
    panel.onkeydown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      collapse();
      opener.focus();
    };
  }
}
